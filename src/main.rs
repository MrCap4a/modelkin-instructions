mod auth;
mod instructions;
mod legacy;
#[cfg(test)]
mod tests;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use minijinja::{Environment, context};
use serde_json::json;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{env, net::SocketAddr, path::Path};
use tokio::net::TcpListener;

#[derive(Clone)]
struct App {
    db: PgPool,
    secure_cookie: bool,
    trust_proxy: bool,
}

struct Error(StatusCode, &'static str);

type Api<T> = std::result::Result<T, Error>;

impl Error {
    const BAD: Self = Self(StatusCode::BAD_REQUEST, "Проверьте введённые данные.");
    const NOT_FOUND: Self = Self(StatusCode::NOT_FOUND, "Запись не найдена.");
    const UNAUTHORIZED: Self = Self(StatusCode::UNAUTHORIZED, "Войдите в панель администратора.");
    const INTERNAL: Self = Self(StatusCode::INTERNAL_SERVER_ERROR, "Ошибка сервера.");
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "database request failed");
        Self::INTERNAL
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

fn page(data: minijinja::Value) -> Response {
    let mut env = Environment::new();
    let result = env
        .add_template("page.html", include_str!("../templates/page.html"))
        .and_then(|()| env.get_template("page.html")?.render(data));
    match result {
        Ok(html) => Html(html).into_response(),
        Err(error) => {
            tracing::error!(%error, "page rendering failed");
            Error::INTERNAL.into_response()
        }
    }
}

fn missing_page() -> Response {
    (
        StatusCode::NOT_FOUND,
        page(context! { error => "Инструкция или шаг не найдены." }),
    )
        .into_response()
}

async fn headers(request: Request, next: Next) -> Response {
    let private = request.uri().path().starts_with("/api/")
        || request.uri().path().starts_with("/read/")
        || request.uri().path().starts_with("/guide/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    ));
    if private {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

async fn health(State(app): State<App>) -> Response {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&app.db)
        .await
    {
        Ok(1) => (
            [(header::CACHE_CONTROL, "no-store")],
            option_env!("MODELKIN_REVISION").unwrap_or("dev"),
        )
            .into_response(),
        _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn font(axum::extract::Path(name): axum::extract::Path<String>) -> Response {
    let bytes: &[u8] = match name.as_str() {
        "manrope-cyrillic-wght-normal.woff2" => {
            include_bytes!("../static/fonts/manrope-cyrillic-wght-normal.woff2")
        }
        "manrope-latin-wght-normal.woff2" => {
            include_bytes!("../static/fonts/manrope-latin-wght-normal.woff2")
        }
        "unbounded-cyrillic-wght-normal.woff2" => {
            include_bytes!("../static/fonts/unbounded-cyrillic-wght-normal.woff2")
        }
        "unbounded-latin-wght-normal.woff2" => {
            include_bytes!("../static/fonts/unbounded-latin-wght-normal.woff2")
        }
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([(header::CONTENT_TYPE, "font/woff2")], bytes).into_response()
}

fn router(app: App) -> Router {
    let protected = instructions::admin_routes()
        .route("/logout", post(auth::logout))
        .route_layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_session,
        ));

    Router::new()
        .route("/", get(|| async { page(context! {}) }))
        .route("/healthz", get(health))
        .route("/static/fonts/{name}", get(font))
        .route(
            "/static/style.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../static/style.css"),
                )
            }),
        )
        .route(
            "/static/figma-editor.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../static/figma-editor.js"),
                )
            }),
        )
        .route(
            "/static/figma-editor.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../static/figma-editor.css"),
                )
            }),
        )
        .route(
            "/static/admin.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../static/admin.js"),
                )
            }),
        )
        .route("/image/{key}", get(instructions::image))
        .route("/version/{key}", get(instructions::version))
        .route("/guide/{token}", get(instructions::guide))
        .route("/read/{token}", get(instructions::read_first))
        .route("/read/{token}/{page}", get(instructions::read_page))
        .nest(
            "/api",
            protected
                .route("/login", post(auth::login))
                .layer(middleware::from_fn(auth::csrf)),
        )
        .fallback(|| async { missing_page() })
        .layer(DefaultBodyLimit::max(12 * 1024 * 1024))
        .layer(middleware::from_fn(headers))
        .with_state(app)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    enum Command<'a> {
        Serve,
        Admin,
        Import(&'a Path),
    }
    let args: Vec<_> = env::args().skip(1).collect();
    let command = match args.as_slice() {
        [] => Command::Serve,
        [name] if name == "serve" => Command::Serve,
        [name] if name == "admin" => Command::Admin,
        [name, file] if name == "import-sqlite" => Command::Import(Path::new(file)),
        _ => anyhow::bail!(
            "Использование: modelkin-instruction [serve | admin | import-sqlite FILE]"
        ),
    };
    let db = PgPoolOptions::new()
        .max_connections(12)
        .connect(&env::var("DATABASE_URL").context("Укажите DATABASE_URL")?)
        .await
        .context("Не удалось подключиться к PostgreSQL")?;
    // An older release must still start after a compatible migration from a newer release.
    let mut migrations = sqlx::migrate!();
    migrations.set_ignore_missing(true).run(&db).await?;

    match command {
        Command::Admin => auth::configure(&db).await?,
        Command::Import(file) => legacy::import(file, &db).await?,
        Command::Serve => {
            let address = env::var("MODELKIN_BIND").unwrap_or_else(|_| "127.0.0.1:8000".into());
            let listener = TcpListener::bind(&address).await?;
            let app = App {
                db,
                secure_cookie: env::var("MODELKIN_HTTPS").as_deref() == Ok("1"),
                trust_proxy: env::var("MODELKIN_TRUST_PROXY").as_deref() == Ok("1"),
            };
            tracing::info!(%address, "accepting connections");
            axum::serve(
                listener,
                router(app).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown())
            .await?;
        }
    }
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

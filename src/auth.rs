use crate::{Api, App, Error};
use anyhow::{Context, Result};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{
        SaltString,
        rand_core::{OsRng, RngCore},
    },
};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
};
use subtle::ConstantTimeEq;

const LIFETIME: u32 = 12 * 60 * 60;
const COOKIE: &str = "modelkin_session";

#[derive(Clone)]
pub struct Session(String);

#[derive(Deserialize)]
pub struct Credentials {
    login: String,
    password: String,
}

pub fn token<const N: usize>() -> String {
    let mut bytes = [0; N];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub async fn csrf(request: Request, next: Next) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD)
        && request
            .headers()
            .get("x-modelkin-request")
            .and_then(|h| h.to_str().ok())
            != Some("1")
    {
        return Error(StatusCode::FORBIDDEN, "Доступ запрещён.").into_response();
    }
    next.run(request).await
}

pub async fn require_session(
    State(app): State<App>,
    mut request: Request,
    next: Next,
) -> Api<Response> {
    let token = request
        .headers()
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|h| h.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find_map(|(key, value)| (key == COOKIE).then_some(value))
        .filter(|value| value.len() == 43)
        .ok_or(Error::UNAUTHORIZED)?;
    let hash = digest(token);
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE token=$1 AND expires>now())",
    )
    .bind(&hash)
    .fetch_one(&app.db)
    .await?;
    if !valid {
        return Err(Error::UNAUTHORIZED);
    }
    request.extensions_mut().insert(Session(hash));
    Ok(next.run(request).await)
}

fn verify_legacy(encoded: &str, password: &str) -> bool {
    let mut parts = encoded.split('$');
    let (Some("scrypt:32768:8:1"), Some(salt), Some(expected), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let mut output = [0u8; 64];
    let params = scrypt::Params::new(15, 8, 1, output.len()).expect("valid legacy parameters");
    if scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut output).is_err() {
        return false;
    }
    let hex: String = output.iter().map(|b| format!("{b:02x}")).collect();
    bool::from(hex.as_bytes().ct_eq(expected.as_bytes()))
}

fn verify(encoded: &str, password: &str) -> bool {
    if let Ok(hash) = PasswordHash::new(encoded) {
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    } else {
        verify_legacy(encoded, password)
    }
}

fn client_ip(app: &App, headers: &HeaderMap, peer: Option<ConnectInfo<SocketAddr>>) -> IpAddr {
    let from_proxy = app
        .trust_proxy
        .then(|| {
            headers
                .get("x-modelkin-client-ip")?
                .to_str()
                .ok()?
                .parse()
                .ok()
        })
        .flatten();
    from_proxy
        .or_else(|| peer.map(|ConnectInfo(addr)| addr.ip()))
        .unwrap_or(Ipv4Addr::LOCALHOST.into())
}

async fn reserve_attempt(db: &PgPool, address: IpAddr) -> Api<()> {
    sqlx::query("DELETE FROM login_attempts WHERE expires <= now()")
        .execute(db)
        .await?;
    let allowed = sqlx::query_scalar::<_, i32>(
        "INSERT INTO login_attempts (client, expires, attempts)
         VALUES ($1::text::inet, now() + interval '15 minutes', 1)
         ON CONFLICT (client) DO UPDATE SET attempts = login_attempts.attempts + 1
         WHERE login_attempts.attempts < 10 RETURNING attempts",
    )
    .bind(address.to_string())
    .fetch_optional(db)
    .await?;
    if allowed.is_none() {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Слишком много попыток входа. Повторите через 15 минут.",
        ));
    }
    Ok(())
}

fn with_cookie(app: &App, value: &str, lifetime: u32) -> Response {
    let secure = if app.secure_cookie { "; Secure" } else { "" };
    let cookie =
        format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={lifetime}{secure}");
    let mut response = Json(json!({"ok": true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("valid session cookie"),
    );
    response
}

#[derive(Deserialize)]
pub struct PasswordConfirmation {
    password: String,
}

pub async fn purge_draft(
    State(app): State<App>,
    axum::extract::Path(id): axum::extract::Path<i64>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<PasswordConfirmation>,
) -> Api<StatusCode> {
    let invalid = Error(StatusCode::FORBIDDEN, "Неверный пароль администратора.");
    let address = client_ip(&app, &headers, peer.map(|Extension(info)| info));
    reserve_attempt(&app.db, address).await?;
    if input.password.len() > 4096 {
        return Err(invalid);
    }
    let mut db = app.db.begin().await?;
    let encoded: String = sqlx::query_scalar("SELECT password FROM admin WHERE id=1 FOR SHARE")
        .fetch_one(&mut *db)
        .await?;
    if !tokio::task::spawn_blocking(move || verify(&encoded, &input.password))
        .await
        .map_err(|_| Error::INTERNAL)?
    {
        return Err(invalid);
    }
    let result = sqlx::query("DELETE FROM drafts WHERE id=$1 AND deleted_at IS NOT NULL")
        .bind(id)
        .execute(&mut *db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(Error::NOT_FOUND);
    }
    sqlx::query("DELETE FROM login_attempts WHERE client=$1::text::inet")
        .bind(address.to_string())
        .execute(&mut *db)
        .await?;
    db.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn login(
    State(app): State<App>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> Api<Response> {
    const INVALID: Error = Error(StatusCode::UNAUTHORIZED, "Неверный логин или пароль.");
    reserve_attempt(
        &app.db,
        client_ip(&app, &headers, peer.map(|Extension(info)| info)),
    )
    .await?;
    if input.password.len() > 4096 {
        return Err(INVALID);
    }
    let (login, encoded) =
        sqlx::query_as::<_, (String, String)>("SELECT login, password FROM admin WHERE id=1")
            .fetch_optional(&app.db)
            .await?
            .ok_or(Error(
                StatusCode::BAD_REQUEST,
                "Сначала создайте администратора командой modelkin-instruction admin.",
            ))?;
    let previous = encoded.clone();
    let matches = tokio::task::spawn_blocking(move || {
        verify(&encoded, &input.password) && login == input.login
    })
    .await
    .map_err(|_| Error::INTERNAL)?;
    if !matches {
        return Err(INVALID);
    }
    let token = token::<32>();
    let mut tx = app.db.begin().await?;
    let current =
        sqlx::query_scalar::<_, String>("SELECT password FROM admin WHERE id=1 FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    if current != previous {
        return Err(INVALID);
    }
    sqlx::query("DELETE FROM sessions WHERE expires<=now()")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO sessions VALUES ($1, now() + $2 * interval '1 second')")
        .bind(digest(&token))
        .bind(f64::from(LIFETIME))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(with_cookie(&app, &token, LIFETIME))
}

pub async fn logout(
    State(app): State<App>,
    Extension(session): Extension<Session>,
) -> Api<Response> {
    sqlx::query("DELETE FROM sessions WHERE token=$1")
        .bind(session.0)
        .execute(&app.db)
        .await?;
    Ok(with_cookie(&app, "", 0))
}

pub async fn configure(db: &PgPool) -> Result<()> {
    print!("Логин администратора: ");
    io::stdout().flush()?;
    let mut login = String::new();
    io::stdin().read_line(&mut login)?;
    let login = login.trim();
    let password = rpassword::prompt_password("Пароль (от 12 символов): ")?;
    anyhow::ensure!(
        !login.is_empty()
            && login.chars().count() <= 100
            && (12..=1024).contains(&password.chars().count()),
        "Укажите логин и пароль длиной от 12 до 1024 символов."
    );
    anyhow::ensure!(
        password == rpassword::prompt_password("Повторите пароль: ")?,
        "Пароли не совпадают."
    );
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("Не удалось сохранить пароль")?
        .to_string();
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO admin VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET login=$1,password=$2",
    )
    .bind(login)
    .bind(hash)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sessions")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    println!("Учётная запись сохранена.");
    Ok(())
}

use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Method, Request as HttpRequest},
};
use serde_json::Value;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use tower::ServiceExt;

struct Browser {
    router: Router,
    cookie: Option<String>,
}

impl Browser {
    async fn request(&self, method: Method, route: &str, body: Option<Value>) -> Response {
        let mut request = HttpRequest::builder()
            .method(method)
            .uri(route)
            .header("x-modelkin-request", "1");
        if let Some(cookie) = &self.cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let body = if let Some(value) = body {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        } else {
            Body::empty()
        };
        self.router
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap()
    }

    async fn json(
        &self,
        method: Method,
        route: &str,
        body: Option<Value>,
        status: StatusCode,
    ) -> Value {
        let response = self.request(method, route, body).await;
        let actual = response.status();
        let bytes = to_bytes(response.into_body(), 12 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            actual,
            status,
            "{route}: {}",
            String::from_utf8_lossy(&bytes)
        );
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn text(&self, route: &str) -> String {
        let response = self.request(Method::GET, route, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{route}");
        String::from_utf8(
            to_bytes(response.into_body(), 12 * 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }
}

fn step(id: u8, title: &str, level: i32) -> Value {
    json!({
        "id": format!("{id:036x}"), "title": title, "body": "**Markdown** <script>bad</script> [bad](javascript:alert(1))",
        "level": level, "image": null
    })
}

async fn sqlite_fixture() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("modelkin-test-{}.sqlite3", auth::token::<12>()));
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE admin (id INTEGER PRIMARY KEY, login TEXT, password TEXT);
         CREATE TABLE levels (id INTEGER PRIMARY KEY, name TEXT, color TEXT, position INTEGER, archived INTEGER);
         CREATE TABLE drafts (id INTEGER PRIMARY KEY, title TEXT, steps TEXT, revision INTEGER);
         CREATE TABLE releases (id INTEGER PRIMARY KEY, draft_id INTEGER, snapshot TEXT);
         CREATE TABLE links (token TEXT PRIMARY KEY, release_id INTEGER, level_id INTEGER);
         CREATE TABLE images (id TEXT PRIMARY KEY, content BLOB);
         INSERT INTO levels VALUES (1,'Легко','#24775a',1,0), (2,'Средне','#975900',2,0), (3,'Сложно','#9c3e59',3,0);",
    ).execute(&mut db).await.unwrap();
    let mut hash = [0; 64];
    scrypt::scrypt(
        b"known-test-password",
        b"test-salt",
        &scrypt::Params::new(15, 8, 1, 64).unwrap(),
        &mut hash,
    )
    .unwrap();
    sqlx::query("INSERT INTO admin VALUES (1,'test',$1)")
        .bind(format!(
            "scrypt:32768:8:1$test-salt${}",
            hash.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ))
        .execute(&mut db)
        .await
        .unwrap();
    let steps = json!([
        step(1, "Advanced step", 3),
        step(2, "Common step", 1),
        step(3, "Medium step", 2)
    ]);
    let levels = json!([
        {"id":1,"name":"Легко","color":"#24775a","position":1,"archived":0},
        {"id":2,"name":"Средне","color":"#975900","position":2,"archived":0},
        {"id":3,"name":"Сложно","color":"#9c3e59","position":3,"archived":0}
    ]);
    sqlx::query("INSERT INTO drafts VALUES (8,'Original title',$1,4)")
        .bind(steps.to_string())
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO releases VALUES (2,8,$1)")
        .bind(json!({"title":"Original title","steps":steps,"levels":levels}).to_string())
        .execute(&mut db)
        .await
        .unwrap();
    for level in 1..=3 {
        sqlx::query("INSERT INTO links VALUES ($1,2,$2)")
            .bind(format!("{level:032}"))
            .bind(level)
            .execute(&mut db)
            .await
            .unwrap();
    }
    db.close().await.unwrap();
    path
}

#[tokio::test]
#[ignore = "requires a fresh PostgreSQL database in TEST_DATABASE_URL"]
async fn import_and_publish() {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
    let db = PgPool::connect(&url).await.unwrap();
    sqlx::migrate!().run(&db).await.unwrap();
    let source = sqlite_fixture().await;
    legacy::import(&source, &db).await.unwrap();
    assert!(legacy::import(&source, &db).await.is_err());
    std::fs::remove_file(source).unwrap();

    let app = router(App {
        db,
        secure_cookie: true,
        trust_proxy: false,
    });
    let reader = Browser {
        router: app.clone(),
        cookie: None,
    };
    let mut editor = Browser {
        router: app,
        cookie: None,
    };
    assert_eq!(
        reader.text("/healthz").await,
        option_env!("MODELKIN_REVISION").unwrap_or("dev")
    );
    assert!(reader.text("/").await.contains("/admin.js"));
    assert_eq!(
        reader
            .request(Method::GET, "/api/state", None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let easy = format!("/read/{:032}", 1);
    let medium = format!("/read/{:032}", 2);
    let hard = format!("/read/{:032}", 3);
    let easy_page = reader.text(&easy).await;
    assert!(!easy_page.contains(r#"class="top""#));
    assert!(easy_page.contains("--tag:#24775a;--tag-ink:#ffffff"));
    assert!(easy_page.contains("Common step") && easy_page.contains("<strong>Markdown</strong>"));
    assert!(
        !easy_page.contains("Advanced step")
            && !easy_page.contains("javascript:")
            && !easy_page.contains("<script>")
    );
    assert!(
        reader
            .text(&format!("{medium}/2"))
            .await
            .contains("Medium step")
    );
    assert!(reader.text(&hard).await.contains("Advanced step"));

    let response = editor
        .request(
            Method::POST,
            "/api/login",
            Some(json!({"login":"test","password":"known-test-password"})),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cookie.contains("Secure") && cookie.contains("HttpOnly"));
    editor.cookie = Some(cookie.split(';').next().unwrap().to_owned());
    let state = editor
        .json(Method::GET, "/api/state", None, StatusCode::OK)
        .await;
    assert_eq!(state["drafts"][0]["id"], 8);
    for (target, expected) in [(1, [3, 1, 2]), (2, [1, 2, 3])] {
        let reordered = editor
            .json(
                Method::POST,
                "/api/levels/3",
                Some(json!({"action":"move", "target":target})),
                StatusCode::OK,
            )
            .await;
        let ids: Vec<_> = reordered["levels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|level| level["id"].as_i64().unwrap())
            .collect();
        assert_eq!(ids, expected);
    }
    let created = editor
        .json(Method::POST, "/api/drafts", None, StatusCode::OK)
        .await;
    assert_eq!(created["id"], 9);

    let mut draft = editor
        .json(Method::GET, "/api/drafts/8", None, StatusCode::OK)
        .await;
    let preview = editor
        .json(
            Method::POST,
            "/api/drafts/8/preview",
            Some(json!({"steps":draft["steps"], "level":2})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(preview["steps"].as_array().unwrap().len(), 2);
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(5, 5)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let mut multipart = b"--test-boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"step.png\"\r\nContent-Type: image/png\r\n\r\n".to_vec();
    multipart.extend(png.into_inner());
    multipart.extend(b"\r\n--test-boundary--\r\n");
    let upload = editor
        .router
        .clone()
        .oneshot(
            HttpRequest::builder()
                .method(Method::POST)
                .uri("/api/images")
                .header("x-modelkin-request", "1")
                .header(header::COOKIE, editor.cookie.as_ref().unwrap())
                .header(
                    header::CONTENT_TYPE,
                    "multipart/form-data; boundary=test-boundary",
                )
                .body(Body::from(multipart))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(upload.status(), StatusCode::OK);
    let uploaded: Value =
        serde_json::from_slice(&to_bytes(upload.into_body(), 2048).await.unwrap()).unwrap();
    let image_path = format!("/image/{}", uploaded["id"].as_str().unwrap());
    let image = reader.request(Method::GET, &image_path, None).await;
    assert_eq!(image.headers()[header::CONTENT_TYPE], "image/webp");
    draft["steps"][1]["body"] = json!(format!(
        "Before image\n\n![Inline image]({image_path})\n\nAfter image\n\n| Part | Qty |\n| --- | --- |\n| Bolt | 2 |"
    ));

    editor
        .json(
            Method::POST,
            "/api/levels/2",
            Some(json!({"action":"archive"})),
            StatusCode::OK,
        )
        .await;
    editor
        .json(
            Method::POST,
            "/api/levels/3",
            Some(json!({"action":"up"})),
            StatusCode::OK,
        )
        .await;
    draft["title"] = json!("Second & <version>");
    draft["steps"]
        .as_array_mut()
        .unwrap()
        .push(step(4, "New archived step", 2));
    editor
        .json(
            Method::PUT,
            "/api/drafts/8",
            Some(draft.clone()),
            StatusCode::BAD_REQUEST,
        )
        .await;
    draft["steps"].as_array_mut().unwrap().pop();
    let mut empty = step(9, "  ", 1);
    empty["body"] = json!("  ");
    draft["steps"].as_array_mut().unwrap().push(empty);
    let published = editor
        .json(
            Method::POST,
            "/api/drafts/8/releases",
            Some(draft.clone()),
            StatusCode::OK,
        )
        .await;
    assert_eq!(published["releases"][0]["number"], 2);
    assert_eq!(
        published["releases"][0]["links"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        published["draft"]["steps"].as_array().unwrap().len(),
        draft["steps"].as_array().unwrap().len()
    );
    assert_eq!(published["releases"][0]["links"][1]["steps"], 3);
    let restored = editor
        .json(
            Method::POST,
            "/api/levels/2",
            Some(json!({"action":"restore"})),
            StatusCode::OK,
        )
        .await;
    let level = restored["levels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|level| level["id"] == 2)
        .unwrap();
    assert_eq!(level["archived"], false);
    assert_eq!(level["position"], 2);
    let shared = published["releases"][0]["path"].as_str().unwrap();
    assert_eq!(published["releases"][1]["path"], shared);
    assert_eq!(shared, format!("/guide/{:032}", 1));
    let first = reader.text(shared).await;
    assert!(first.contains("Advanced step") && !first.contains("Common step"));
    assert!(first.contains("?level=1"));
    let switched = reader.text(&format!("{shared}?level=1&page=2")).await;
    assert!(switched.contains("Before image") && switched.contains("After image"));
    let new_hard = published["releases"][0]["links"][0]["path"]
        .as_str()
        .unwrap();
    assert_eq!(new_hard, hard);
    let new_page = reader.text(new_hard).await;
    assert!(
        new_page.contains("Second &amp; &lt;version&gt;") && new_page.contains("Advanced step")
    );
    assert!(!new_page.contains("Common step"));
    let new_easy = published["releases"][0]["links"][1]["path"]
        .as_str()
        .unwrap();
    assert_eq!(new_easy, easy);
    let with_media = reader.text(&format!("{new_easy}/2")).await;
    assert!(with_media.find("Before image").unwrap() < with_media.find(&image_path).unwrap());
    assert!(with_media.find(&image_path).unwrap() < with_media.find("After image").unwrap());
    assert!(with_media.contains("<table>") && with_media.contains("<td>Bolt</td>"));
    assert!(
        reader
            .text(&easy)
            .await
            .contains("Second &amp; &lt;version&gt;")
    );
    let previous = &published["releases"][1];
    let pinned = previous["version_path"].as_str().unwrap();
    assert!(reader.text(pinned).await.contains("Original title"));
    assert!(
        reader
            .text(&format!("{pinned}?level=2&page=2"))
            .await
            .contains("Medium step")
    );
    let restore_url = format!("/api/drafts/8/history/{}", previous["id"]);
    let appended = editor
        .json(
            Method::POST,
            &restore_url,
            Some(json!({"draft":published["draft"],"step":previous["steps"][0]["id"]})),
            StatusCode::OK,
        )
        .await;
    let appended_steps = appended["steps"].as_array().unwrap();
    assert_eq!(
        appended_steps.len(),
        published["draft"]["steps"].as_array().unwrap().len() + 1
    );
    assert_ne!(
        appended_steps.last().unwrap()["id"],
        previous["steps"][0]["id"]
    );
    assert_eq!(
        appended_steps.last().unwrap()["title"],
        previous["steps"][0]["title"]
    );
    let reverted = editor
        .json(
            Method::POST,
            &restore_url,
            Some(json!({"draft":appended})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(reverted["title"], "Original title");
    assert_eq!(reverted["steps"].as_array().unwrap().len(), 3);
    assert!(
        reader
            .text(shared)
            .await
            .contains("Second &amp; &lt;version&gt;")
    );
    let archived = published["releases"][1]["links"][0]["archive"]
        .as_str()
        .unwrap();
    assert!(editor.text(archived).await.contains("Original title"));
    assert_eq!(
        reader.request(Method::GET, archived, None).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(
        reader
            .text(&format!("{medium}/2"))
            .await
            .contains("Medium step")
    );
    editor
        .json(
            Method::PUT,
            "/api/drafts/8",
            Some(draft),
            StatusCode::CONFLICT,
        )
        .await;
    editor
        .json(Method::POST, "/api/logout", None, StatusCode::OK)
        .await;
    assert_eq!(
        editor
            .request(Method::GET, "/api/state", None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

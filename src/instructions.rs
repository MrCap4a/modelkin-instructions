use crate::{Api, App, Error, auth, missing_page, page};
use axum::{
    Json, Router,
    extract::{Multipart, Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use minijinja::context;
use pulldown_cmark::{Event, Parser, Tag, html};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection, types::Json as DbJson};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Write},
};

#[derive(Clone, Deserialize, Serialize, FromRow)]
pub struct Level {
    pub id: i64,
    name: String,
    color: String,
    position: i64,
    archived: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Step {
    id: String,
    title: String,
    body: String,
    level: i64,
    image: Option<String>,
}

#[derive(FromRow, Serialize)]
struct Draft {
    id: i64,
    title: String,
    steps: DbJson<Vec<Step>>,
    revision: i64,
}

#[derive(Deserialize)]
struct DraftInput {
    title: String,
    steps: Vec<Step>,
    revision: i64,
}

#[derive(Deserialize)]
struct PreviewInput {
    steps: Vec<Step>,
    level: i64,
}

#[derive(Deserialize, Serialize)]
struct Snapshot {
    title: String,
    steps: Vec<Step>,
    levels: Vec<Level>,
}

#[derive(Deserialize)]
struct NewLevel {
    name: String,
    color: String,
}

#[derive(Deserialize)]
struct LevelChange {
    action: String,
    target: Option<i64>,
}

pub fn admin_routes() -> Router<App> {
    Router::new()
        .route("/state", get(state))
        .route("/markdown", post(read_step_markdown))
        .route("/levels", post(add_level))
        .route("/levels/{id}", post(change_level).put(edit_level))
        .route("/drafts", post(create))
        .route(
            "/drafts/{id}",
            get(get_draft).put(update).delete(delete_draft),
        )
        .route("/drafts/{id}/preview", post(preview))
        .route("/drafts/{id}/releases", get(releases).post(publish))
        .route("/archive/{release}/{level}/{page}", get(read_archive))
        .route("/images", post(upload))
}

async fn levels(db: &mut PgConnection) -> Api<Vec<Level>> {
    Ok(sqlx::query_as("SELECT * FROM levels ORDER BY position, id")
        .fetch_all(db)
        .await?)
}

async fn state(State(app): State<App>) -> Api<Json<Value>> {
    let mut db = app.db.acquire().await?;
    let levels = levels(&mut db).await?;
    let drafts: Vec<(i64, String, i32, bool)> = sqlx::query_as(
        "SELECT d.id,d.title,jsonb_array_length(d.steps),EXISTS(SELECT 1 FROM releases r WHERE r.draft_id=d.id) FROM drafts d ORDER BY d.id DESC"
    )
        .fetch_all(&mut *db)
        .await?;
    Ok(Json(json!({
        "levels": levels,
        "drafts": drafts.into_iter().map(|(id,title,steps,published)| json!({"id":id,"title":title,"steps":steps,"published":published})).collect::<Vec<_>>()
    })))
}

async fn add_level(State(app): State<App>, Json(input): Json<NewLevel>) -> Api<Json<Value>> {
    let name = validate_level(&input)?;
    let mut db = app.db.begin().await?;
    sqlx::query("LOCK TABLE levels IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *db)
        .await?;
    sqlx::query("INSERT INTO levels (name,color,position) SELECT $1,$2,COALESCE(MAX(position),0)+1 FROM levels")
        .bind(name).bind(&input.color).execute(&mut *db).await?;
    let output = levels(&mut db).await?;
    db.commit().await?;
    Ok(Json(json!({"levels":output})))
}

fn validate_level(input: &NewLevel) -> Api<&str> {
    let name = input.name.trim();
    if name.is_empty()
        || name.chars().count() > 60
        || input.color.len() != 7
        || !input.color.starts_with('#')
        || !input.color.as_bytes()[1..]
            .iter()
            .all(u8::is_ascii_hexdigit)
    {
        return Err(Error::BAD);
    }
    Ok(name)
}

async fn edit_level(
    State(app): State<App>,
    Path(id): Path<i64>,
    Json(input): Json<NewLevel>,
) -> Api<Json<Value>> {
    let name = validate_level(&input)?;
    let mut db = app.db.begin().await?;
    let updated = sqlx::query("UPDATE levels SET name=$1,color=$2 WHERE id=$3 AND NOT archived")
        .bind(name)
        .bind(&input.color)
        .bind(id)
        .execute(&mut *db)
        .await?;
    if updated.rows_affected() == 0 {
        return Err(Error::NOT_FOUND);
    }
    let output = levels(&mut db).await?;
    db.commit().await?;
    Ok(Json(json!({"levels":output})))
}

async fn change_level(
    State(app): State<App>,
    Path(id): Path<i64>,
    Json(input): Json<LevelChange>,
) -> Api<Json<Value>> {
    let mut db = app.db.begin().await?;
    sqlx::query("LOCK TABLE levels IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *db)
        .await?;
    let ordered = levels(&mut db).await?;
    if !ordered.iter().any(|level| level.id == id) {
        return Err(Error::NOT_FOUND);
    }
    let active: Vec<_> = ordered.iter().filter(|level| !level.archived).collect();
    let index = active
        .iter()
        .position(|level| level.id == id)
        .ok_or(Error::BAD)?;
    match input.action.as_str() {
        "archive" if active.len() > 1 => {
            sqlx::query("UPDATE levels SET archived=true WHERE id=$1")
                .bind(id)
                .execute(&mut *db)
                .await?;
        }
        "up" | "down" | "move" => {
            let destination = match input.action.as_str() {
                "up" => index.checked_sub(1),
                "down" => index.checked_add(1),
                _ => active
                    .iter()
                    .position(|level| Some(level.id) == input.target),
            }
            .filter(|&position| position < active.len())
            .ok_or(Error::BAD)?;

            let mut ids: Vec<_> = active.iter().map(|level| level.id).collect();
            ids.remove(index);
            ids.insert(destination, id);
            let positions: Vec<_> = active.iter().map(|level| level.position).collect();
            sqlx::query("UPDATE levels SET position=ordering.position FROM unnest($1::bigint[], $2::bigint[]) AS ordering(id, position) WHERE levels.id=ordering.id")
                .bind(ids).bind(positions).execute(&mut *db).await?;
        }
        _ => return Err(Error::BAD),
    }
    let output = levels(&mut db).await?;
    db.commit().await?;
    Ok(Json(json!({"levels":output})))
}

async fn create(State(app): State<App>) -> Api<Json<Draft>> {
    Ok(Json(
        sqlx::query_as("INSERT INTO drafts DEFAULT VALUES RETURNING *")
            .fetch_one(&app.db)
            .await?,
    ))
}

async fn draft(db: &mut PgConnection, id: i64, lock: bool) -> Api<Draft> {
    let query = if lock {
        "SELECT * FROM drafts WHERE id=$1 FOR UPDATE"
    } else {
        "SELECT * FROM drafts WHERE id=$1"
    };
    sqlx::query_as(query)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(Error::NOT_FOUND)
}

async fn get_draft(State(app): State<App>, Path(id): Path<i64>) -> Api<Json<Draft>> {
    let mut db = app.db.acquire().await?;
    Ok(Json(draft(&mut db, id, false).await?))
}

async fn delete_draft(State(app): State<App>, Path(id): Path<i64>) -> Api<StatusCode> {
    let deleted = sqlx::query("DELETE FROM drafts WHERE id=$1")
        .bind(id)
        .execute(&app.db)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(Error::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn validate_steps(
    db: &mut PgConnection,
    old: &Draft,
    levels: &[Level],
    steps: &mut [Step],
) -> Api<()> {
    if steps.len() > 250 {
        return Err(Error::BAD);
    }
    let old_levels: HashMap<_, _> = old
        .steps
        .iter()
        .map(|step| (step.id.as_str(), step.level))
        .collect();
    let active: HashSet<_> = levels
        .iter()
        .filter(|level| !level.archived)
        .map(|level| level.id)
        .collect();
    let mut ids = HashSet::new();
    let mut images = HashSet::new();
    for step in steps {
        if step.id.len() != 36
            || !step.id.bytes().all(|b| b"-0123456789abcdef".contains(&b))
            || !ids.insert(step.id.clone())
            || step.title.chars().count() > 150
            || step.body.chars().count() > 50_000
            || (!active.contains(&step.level)
                && old_levels.get(step.id.as_str()) != Some(&step.level))
        {
            return Err(Error::BAD);
        }
        if let Some(image) = &step.image {
            if image.len() != 40 || !image.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(Error::BAD);
            }
            images.insert(image.clone());
        }
        step.title = step.title.trim().to_owned();
    }
    if !images.is_empty() {
        let keys: Vec<_> = images.into_iter().collect();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM images WHERE id=ANY($1)")
            .bind(&keys)
            .fetch_one(db)
            .await?;
        if count as usize != keys.len() {
            return Err(Error::BAD);
        }
    }
    Ok(())
}

async fn save(
    db: &mut PgConnection,
    id: i64,
    mut input: DraftInput,
    levels: &[Level],
) -> Api<Draft> {
    let old = draft(db, id, true).await?;
    if input.revision != old.revision {
        return Err(Error(
            StatusCode::CONFLICT,
            "Черновик изменился в другой вкладке. Скопируйте свои правки и обновите страницу.",
        ));
    }
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 150 {
        return Err(Error::BAD);
    }
    validate_steps(db, &old, levels, &mut input.steps).await?;
    Ok(sqlx::query_as(
        "UPDATE drafts SET title=$1, steps=$2, revision=revision+1 WHERE id=$3 RETURNING *",
    )
    .bind(title)
    .bind(DbJson(input.steps))
    .bind(id)
    .fetch_one(db)
    .await?)
}

async fn update(
    State(app): State<App>,
    Path(id): Path<i64>,
    Json(input): Json<DraftInput>,
) -> Api<Json<Draft>> {
    let mut db = app.db.begin().await?;
    sqlx::query("LOCK TABLE levels IN SHARE MODE")
        .execute(&mut *db)
        .await?;
    let levels = levels(&mut db).await?;
    let output = save(&mut db, id, input, &levels).await?;
    db.commit().await?;
    Ok(Json(output))
}

fn visible<'a>(steps: &'a [Step], levels: &[Level], selected: &Level) -> Vec<&'a Step> {
    let ranks: HashMap<_, _> = levels
        .iter()
        .map(|level| (level.id, level.position))
        .collect();
    steps
        .iter()
        .filter(|step| {
            ranks
                .get(&step.level)
                .is_some_and(|rank| *rank <= selected.position)
        })
        .collect()
}

fn render_markdown(body: &str) -> String {
    let options = pulldown_cmark::Options::ENABLE_TABLES;
    let mut document = String::with_capacity(body.len());
    let mut quotes = HashMap::new();
    let mut copied = 0;
    // Look for callouts only at parsed quote boundaries, never inside code samples.
    for (event, span) in Parser::new_ext(body, options).into_offset_iter() {
        if !matches!(event, Event::Start(Tag::BlockQuote(_))) || span.start < copied {
            continue;
        }
        let line = body[span.clone()].lines().next().unwrap_or("");
        let Some(first) = line.strip_prefix('>') else {
            continue;
        };
        let Some((kind, title)) = first
            .trim_start()
            .strip_prefix("[!")
            .and_then(|s| s.split_once(']'))
        else {
            continue;
        };
        let (class, fallback) = match kind.to_ascii_lowercase().as_str() {
            "warning" => ("callout-warning", "Предупреждение"),
            "note" => ("callout-note", "Примечание"),
            "tip" => ("callout-tip", "Совет"),
            _ => continue,
        };
        document.push_str(&body[copied..span.start]);
        quotes.insert(document.len(), class);
        document.push_str("> ###### ");
        document.push_str(if title.trim().is_empty() {
            fallback
        } else {
            title.trim()
        });
        copied = span.start + line.len();
    }
    document.push_str(&body[copied..]);
    let events = Parser::new_ext(&document, options)
        .into_offset_iter()
        .map(|(event, span)| match event {
            Event::Start(Tag::BlockQuote(_)) if quotes.contains_key(&span.start) => {
                Event::Html(format!("<blockquote class=\"{}\">", quotes[&span.start]).into())
            }
            Event::SoftBreak => Event::HardBreak,
            Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
            other => other,
        });
    let mut rendered = String::new();
    html::push_html(&mut rendered, events);
    ammonia::Builder::default()
        .add_allowed_classes(
            "blockquote",
            ["callout-tip", "callout-note", "callout-warning"],
        )
        .clean(&rendered)
        .to_string()
}

#[derive(Deserialize)]
struct MarkdownBody {
    body: String,
}

#[cfg(test)]
#[test]
fn renders_obsidian_callouts_without_changing_code_examples() {
    let source = ">[!warning] #важно\n> **Один**\n> Два\n> - Три\n\n> [!tip] #кстати\n> Совет\n\n> [!note]\n> Текст\n\n```md\n> [!warning] Пример\n```";
    let html = render_markdown(source);
    assert!(html.contains("<blockquote class=\"callout-warning\">"));
    assert!(html.contains("<h6>#важно</h6>"));
    assert!(html.contains("<strong>Один</strong><br"));
    assert!(html.contains("<li>Три</li>"));
    assert!(html.contains("class=\"callout-tip\"") && html.contains("<h6>Примечание</h6>"));
    assert!(html.contains("[!warning] Пример"));
    assert!(!render_markdown("> [!tip] <b>текст</b>").contains("<b>"));
}

async fn read_step_markdown(Json(MarkdownBody { body }): Json<MarkdownBody>) -> Api<Json<String>> {
    if body.chars().count() > 50_000 {
        return Err(Error::BAD);
    }
    Ok(Json(render_markdown(&body)))
}

async fn preview(
    State(app): State<App>,
    Path(id): Path<i64>,
    Json(mut input): Json<PreviewInput>,
) -> Api<Json<Value>> {
    let mut db = app.db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *db)
        .await?;
    let original = draft(&mut db, id, false).await?;
    let levels = levels(&mut db).await?;
    let selected = levels
        .iter()
        .find(|level| level.id == input.level && !level.archived)
        .ok_or(Error::BAD)?;
    validate_steps(&mut db, &original, &levels, &mut input.steps).await?;
    db.commit().await?;
    let steps = visible(&input.steps, &levels, selected).into_iter().map(|step| {
        json!({"id":step.id,"title":step.title,"body":step.body,"image":step.image,"level":step.level,"rendered":render_markdown(&step.body)})
    }).collect::<Vec<_>>();
    Ok(Json(json!({"steps":steps})))
}

async fn release_list(db: &mut PgConnection, draft: Draft) -> Api<Json<Value>> {
    let rows: Vec<(i64, DbJson<Snapshot>)> =
        sqlx::query_as("SELECT id,snapshot FROM releases WHERE draft_id=$1 ORDER BY id")
            .bind(draft.id)
            .fetch_all(&mut *db)
            .await?;
    let tokens: HashMap<i64,String> = sqlx::query_as(
        "SELECT DISTINCT ON (l.level_id) l.level_id,l.token FROM links l JOIN releases r ON r.id=l.release_id WHERE r.draft_id=$1 ORDER BY l.level_id,r.id"
    ).bind(draft.id).fetch_all(db).await?.into_iter().collect();
    let releases = rows
        .into_iter()
        .enumerate()
        .rev()
        .map(|(i, (id, DbJson(snapshot)))| {
            let links = snapshot
                .levels
                .iter()
                .filter(|level| !level.archived)
                .filter_map(|level| {
                    let token = tokens.get(&level.id)?;
                    Some(json!({
                        "name":level.name, "color":level.color, "path":format!("/read/{token}"),
                        "steps":visible(&snapshot.steps,&snapshot.levels,level).len(),
                        "archive":format!("/api/archive/{id}/{}/1",level.id)
                    }))
                })
                .collect::<Vec<_>>();
            json!({"number":i+1,"links":links})
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({"draft":draft,"releases":releases})))
}

async fn releases(State(app): State<App>, Path(id): Path<i64>) -> Api<Json<Value>> {
    let mut db = app.db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *db)
        .await?;
    let current = draft(&mut db, id, false).await?;
    let output = release_list(&mut db, current).await?;
    db.commit().await?;
    Ok(output)
}

async fn publish(
    State(app): State<App>,
    Path(id): Path<i64>,
    Json(input): Json<DraftInput>,
) -> Api<Json<Value>> {
    let mut db = app.db.begin().await?;
    sqlx::query("LOCK TABLE levels IN SHARE MODE")
        .execute(&mut *db)
        .await?;
    let levels = levels(&mut db).await?;
    let current = save(&mut db, id, input, &levels).await?;
    if current.steps.is_empty()
        || current.steps.iter().any(|step| {
            step.title.is_empty() && step.body.trim().is_empty() && step.image.is_none()
        })
    {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "Для публикации добавьте хотя бы один шаг и заполните каждый шаг.",
        ));
    }
    let snapshot = Snapshot {
        title: current.title.clone(),
        steps: current.steps.0.clone(),
        levels,
    };
    let release: i64 =
        sqlx::query_scalar("INSERT INTO releases (draft_id,snapshot) VALUES ($1,$2) RETURNING id")
            .bind(id)
            .bind(DbJson(&snapshot))
            .fetch_one(&mut *db)
            .await?;
    for level in snapshot.levels.iter().filter(|level| !level.archived) {
        sqlx::query("INSERT INTO links (token,release_id,level_id)
             SELECT $1,$2,$3 WHERE NOT EXISTS (
                 SELECT 1 FROM links l JOIN releases r ON r.id=l.release_id WHERE r.draft_id=$4 AND l.level_id=$3
             )")
            .bind(auth::token::<24>())
            .bind(release)
            .bind(level.id)
            .bind(id)
            .execute(&mut *db)
            .await?;
    }
    let output = release_list(&mut db, current).await?;
    db.commit().await?;
    Ok(output)
}

fn convert_image(raw: Vec<u8>) -> Api<Vec<u8>> {
    const INVALID: Error = Error(
        StatusCode::BAD_REQUEST,
        "Выберите изображение JPEG, PNG, WebP или GIF.",
    );
    const LARGE: Error = Error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Изображение слишком большое.",
    );
    let mut reader = ImageReader::new(Cursor::new(raw))
        .with_guessed_format()
        .map_err(|_| INVALID)?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP | ImageFormat::Gif)
    ) {
        return Err(INVALID);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| INVALID)?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > 20_000_000 {
        return Err(LARGE);
    }
    let orientation = decoder.orientation().map_err(|_| INVALID)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| INVALID)?;
    image.apply_orientation(orientation);
    if image.width() > 2400 || image.height() > 2400 {
        image = image.thumbnail(2400, 2400);
    }
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::WebP)
        .map_err(|_| Error::INTERNAL)?;
    output.flush().map_err(|_| Error::INTERNAL)?;
    Ok(output.into_inner())
}

async fn upload(State(app): State<App>, mut form: Multipart) -> Api<Json<Value>> {
    const MAX: usize = 10 * 1024 * 1024;
    let form_error = |error: axum::extract::multipart::MultipartError| {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Файл слишком большой. Максимум 10 МБ.",
            )
        } else {
            Error::BAD
        }
    };
    while let Some(mut field) = form.next_field().await.map_err(form_error)? {
        if field.name() != Some("image") {
            continue;
        }
        let mut raw = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(form_error)? {
            if raw.len() + chunk.len() > MAX {
                return Err(Error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Файл слишком большой. Максимум 10 МБ.",
                ));
            }
            raw.extend_from_slice(&chunk);
        }
        let content = tokio::task::spawn_blocking(move || convert_image(raw))
            .await
            .map_err(|_| Error::INTERNAL)??;
        let id = format!(
            "{:x}",
            <sha2::Sha256 as sha2::Digest>::digest(auth::token::<32>())
        );
        let id = &id[..40];
        sqlx::query("INSERT INTO images VALUES ($1,$2)")
            .bind(id)
            .bind(content)
            .execute(&app.db)
            .await?;
        return Ok(Json(json!({"id":id})));
    }
    Err(Error::BAD)
}

pub async fn image(State(app): State<App>, Path(key): Path<String>) -> Api<Response> {
    let content: Option<Vec<u8>> = sqlx::query_scalar("SELECT content FROM images WHERE id=$1")
        .bind(key)
        .fetch_optional(&app.db)
        .await?;
    Ok(content
        .map(|bytes| ([(header::CONTENT_TYPE, "image/webp")], bytes).into_response())
        .unwrap_or_else(missing_page))
}

pub async fn read_first(State(app): State<App>, Path(token): Path<String>) -> Api<Response> {
    read(app, token, 1).await
}

pub async fn read_page(
    State(app): State<App>,
    Path((token, index)): Path<(String, usize)>,
) -> Api<Response> {
    read(app, token, index).await
}

async fn read(app: App, token: String, index: usize) -> Api<Response> {
    if !(token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)))
    {
        return Ok(missing_page());
    }
    let found: Option<(DbJson<Snapshot>, i64)> = sqlx::query_as(
        "SELECT latest.snapshot,l.level_id FROM links l
         JOIN releases original ON original.id=l.release_id
         CROSS JOIN LATERAL (SELECT snapshot FROM releases WHERE draft_id=original.draft_id
             AND snapshot->'levels' @> jsonb_build_array(jsonb_build_object('id',l.level_id))
             ORDER BY id DESC LIMIT 1) latest WHERE l.token=$1",
    )
    .bind(&token)
    .fetch_optional(&app.db)
    .await?;
    let Some((DbJson(snapshot), selected)) = found else {
        return Ok(missing_page());
    };
    render_reader(snapshot, selected, index, format!("/read/{token}"), false)
}

async fn read_archive(
    State(app): State<App>,
    Path((release, level, index)): Path<(i64, i64, usize)>,
) -> Api<Response> {
    let snapshot: Option<DbJson<Snapshot>> =
        sqlx::query_scalar("SELECT snapshot FROM releases WHERE id=$1")
            .bind(release)
            .fetch_optional(&app.db)
            .await?;
    match snapshot {
        Some(DbJson(snapshot)) => render_reader(
            snapshot,
            level,
            index,
            format!("/api/archive/{release}/{level}"),
            true,
        ),
        None => Ok(missing_page()),
    }
}

fn render_reader(
    snapshot: Snapshot,
    selected: i64,
    index: usize,
    base: String,
    archived: bool,
) -> Api<Response> {
    let Some(level) = snapshot.levels.iter().find(|level| level.id == selected) else {
        return Ok(missing_page());
    };
    let visible = visible(&snapshot.steps, &snapshot.levels, level);
    if index < 1 || index > visible.len().max(1) {
        return Ok(missing_page());
    }
    let step = visible.get(index - 1).copied();
    Ok(page(context! {
        reader => true,
        title => snapshot.title,
        level => level,
        tag_ink => tag_ink(&level.color),
        step => step,
        body => step.map(|step| render_markdown(&step.body)).unwrap_or_default(),
        page => index,
        count => visible.len(),
        reader_base => base,
        archived => archived,
        outline => visible.iter().map(|step| &step.title).collect::<Vec<_>>(),
    }))
}

fn tag_ink(color: &str) -> &'static str {
    let rgb = u32::from_str_radix(color.trim_start_matches('#'), 16).unwrap_or_default();
    let linear = |shift: u32| {
        let c = f64::from((rgb >> shift) & 255) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let luminance = 0.2126 * linear(16) + 0.7152 * linear(8) + 0.0722 * linear(0);
    if luminance > 0.179 {
        "#000000"
    } else {
        "#ffffff"
    }
}

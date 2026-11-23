use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sqlx::{Connection, PgPool, SqliteConnection, sqlite::SqliteConnectOptions, types::Json};
use std::path::Path;

pub async fn import(path: &Path, target: &PgPool) -> Result<()> {
    ensure!(path.is_file(), "Файл SQLite не найден: {}", path.display());
    let mut source =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path).read_only(true))
            .await
            .context("Не удалось открыть SQLite")?;
    let mut source = source.begin().await?;
    let mut target = target.begin().await?;
    sqlx::query("LOCK TABLE levels, drafts, releases, links, images, admin, sessions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *target).await?;

    let fresh: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(SELECT 1 FROM drafts) AND NOT EXISTS(SELECT 1 FROM releases)
           AND NOT EXISTS(SELECT 1 FROM images) AND NOT EXISTS(SELECT 1 FROM admin)
           AND (SELECT count(*) FROM levels)=3
           AND (SELECT count(*) FROM levels WHERE (id, position, name, color, archived) IN
             ((1,1,'Легко','#30b383',false), (2,2,'Средне','#e3a319',false), (3,3,'Сложно','#e46142',false)))=3",
    ).fetch_one(&mut *target).await?;
    ensure!(
        fresh,
        "Импорт разрешён только в новую базу PostgreSQL с исходными уровнями."
    );
    sqlx::query("DELETE FROM levels")
        .execute(&mut *target)
        .await?;

    let levels: Vec<(i64, String, String, i64, bool)> =
        sqlx::query_as("SELECT id,name,color,position,archived FROM levels")
            .fetch_all(&mut *source)
            .await?;
    for (id, name, color, position, archived) in &levels {
        sqlx::query("INSERT INTO levels VALUES ($1,$2,$3,$4,$5)")
            .bind(id)
            .bind(name)
            .bind(color)
            .bind(position)
            .bind(archived)
            .execute(&mut *target)
            .await?;
    }
    let drafts: Vec<(i64, String, String, i64)> =
        sqlx::query_as("SELECT id,title,steps,revision FROM drafts")
            .fetch_all(&mut *source)
            .await?;
    for (id, title, steps, revision) in &drafts {
        sqlx::query("INSERT INTO drafts VALUES ($1,$2,$3,$4)")
            .bind(id)
            .bind(title)
            .bind(Json(serde_json::from_str::<Value>(steps)?))
            .bind(revision)
            .execute(&mut *target)
            .await?;
    }
    let releases: Vec<(i64, i64, String)> =
        sqlx::query_as("SELECT id,draft_id,snapshot FROM releases")
            .fetch_all(&mut *source)
            .await?;
    for (id, draft, snapshot) in &releases {
        let mut snapshot: Value = serde_json::from_str(snapshot)?;
        let levels = snapshot["levels"]
            .as_array_mut()
            .context("Не найдены уровни опубликованной версии")?;
        for level in levels {
            if let Some(flag) = level["archived"].as_i64() {
                level["archived"] = Value::Bool(flag != 0);
            }
        }
        sqlx::query("INSERT INTO releases VALUES ($1,$2,$3)")
            .bind(id)
            .bind(draft)
            .bind(Json(snapshot))
            .execute(&mut *target)
            .await?;
    }
    let links: Vec<(String, i64, i64)> =
        sqlx::query_as("SELECT token,release_id,level_id FROM links")
            .fetch_all(&mut *source)
            .await?;
    for (token, release, level) in &links {
        sqlx::query("INSERT INTO links VALUES ($1,$2,$3)")
            .bind(token)
            .bind(release)
            .bind(level)
            .execute(&mut *target)
            .await?;
    }
    let mut last = String::new();
    let mut image_count = 0;
    while let Some((id, content)) = sqlx::query_as::<_, (String, Vec<u8>)>(
        "SELECT id,content FROM images WHERE id>? ORDER BY id LIMIT 1",
    )
    .bind(&last)
    .fetch_optional(&mut *source)
    .await?
    {
        sqlx::query("INSERT INTO images VALUES ($1,$2)")
            .bind(&id)
            .bind(content)
            .execute(&mut *target)
            .await?;
        last = id;
        image_count += 1;
    }
    if let Some((login, hash)) =
        sqlx::query_as::<_, (String, String)>("SELECT login,password FROM admin WHERE id=1")
            .fetch_optional(&mut *source)
            .await?
    {
        sqlx::query("INSERT INTO admin VALUES (1,$1,$2)")
            .bind(login)
            .bind(hash)
            .execute(&mut *target)
            .await?;
    }

    for table in ["levels", "drafts", "releases"] {
        let next: i64 = sqlx::query_scalar(&format!("SELECT COALESCE(MAX(id),0)+1 FROM {table}"))
            .fetch_one(&mut *target)
            .await?;
        sqlx::query(&format!(
            "ALTER TABLE {table} ALTER COLUMN id RESTART WITH {next}"
        ))
        .execute(&mut *target)
        .await?;
    }
    source.commit().await?;
    target.commit().await?;
    println!(
        "Импорт завершён. Черновики: {}, версии: {}, ссылки: {}, картинки: {}.",
        drafts.len(),
        releases.len(),
        links.len(),
        image_count
    );
    Ok(())
}

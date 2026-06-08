use rusqlite::Connection;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("afuos.sqlite"))
        .map_err(|error| format!("Failed to resolve data dir: {error}"))
}

pub fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create data dir: {error}"))?;
    }

    let connection =
        Connection::open(path).map_err(|error| format!("Failed to open database: {error}"))?;
    migrate(&connection)?;
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS conversations (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              summary TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS execution_logs (
              id TEXT PRIMARY KEY,
              action_type TEXT NOT NULL,
              title TEXT NOT NULL,
              target TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL,
              risk_level TEXT NOT NULL,
              reason TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY,
              content TEXT NOT NULL,
              source TEXT NOT NULL DEFAULT 'manual',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS permission_rules (
              id TEXT PRIMARY KEY,
              action_type TEXT NOT NULL,
              target TEXT NOT NULL DEFAULT '',
              decision TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("Failed to migrate database: {error}"))?;
    Ok(())
}

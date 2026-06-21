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
            PRAGMA foreign_keys = ON;
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
    add_column_if_missing(
        connection,
        "messages",
        "image_attachments",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_enables_foreign_keys_for_connection() {
        let connection = Connection::open_in_memory().expect("memory database");

        migrate(&connection).expect("migrate");

        let enabled: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys pragma");
        assert_eq!(enabled, 1);
    }

    #[test]
    fn deleting_conversation_cascades_messages() {
        let connection = Connection::open_in_memory().expect("memory database");
        migrate(&connection).expect("migrate");

        connection
            .execute(
                "INSERT INTO conversations (id, title, summary, created_at, updated_at)
                 VALUES ('c1', 'title', '', 1, 1)",
                [],
            )
            .expect("insert conversation");
        connection
            .execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at)
                 VALUES ('m1', 'c1', 'user', 'hello', 1)",
                [],
            )
            .expect("insert message");

        connection
            .execute("DELETE FROM conversations WHERE id = 'c1'", [])
            .expect("delete conversation");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .expect("message count");
        assert_eq!(count, 0);
    }
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("Failed to inspect table {table}: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read table {table} columns: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect table {table} columns: {error}"))?;

    if !columns.iter().any(|item| item == column) {
        connection
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| format!("Failed to add column {column} to {table}: {error}"))?;
    }

    Ok(())
}

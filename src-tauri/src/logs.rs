use crate::db::open_database;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionLog {
    pub id: String,
    pub action_type: String,
    pub title: String,
    pub target: String,
    pub status: String,
    pub risk_level: String,
    pub reason: String,
    pub created_at: i64,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn write_execution_log(
    app: &AppHandle,
    action_type: &str,
    title: &str,
    target: &str,
    status: &str,
    risk_level: &str,
    reason: &str,
) -> Result<ExecutionLog, String> {
    let log = ExecutionLog {
        id: Uuid::new_v4().to_string(),
        action_type: action_type.to_string(),
        title: title.to_string(),
        target: target.to_string(),
        status: status.to_string(),
        risk_level: risk_level.to_string(),
        reason: reason.to_string(),
        created_at: now_ms(),
    };

    let connection = open_database(app)?;
    connection
        .execute(
            "INSERT INTO execution_logs (id, action_type, title, target, status, risk_level, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                log.id,
                log.action_type,
                log.title,
                log.target,
                log.status,
                log.risk_level,
                log.reason,
                log.created_at
            ],
        )
        .map_err(|error| format!("Failed to write execution log: {error}"))?;

    Ok(log)
}

pub fn list_execution_logs(app: &AppHandle, limit: u32) -> Result<Vec<ExecutionLog>, String> {
    let connection = open_database(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, action_type, title, target, status, risk_level, reason, created_at
             FROM execution_logs
             ORDER BY created_at DESC
             LIMIT ?1",
        )
        .map_err(|error| format!("Failed to prepare execution log query: {error}"))?;

    let rows = statement
        .query_map([limit], |row| {
            Ok(ExecutionLog {
                id: row.get(0)?,
                action_type: row.get(1)?,
                title: row.get(2)?,
                target: row.get(3)?,
                status: row.get(4)?,
                risk_level: row.get(5)?,
                reason: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Failed to read execution logs: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect execution logs: {error}"))
}

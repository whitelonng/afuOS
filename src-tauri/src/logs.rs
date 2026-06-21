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
    let sanitized_title = sanitize_log_text(title, 160);
    let sanitized_target = sanitize_log_target(action_type, target);
    let sanitized_reason = sanitize_log_text(reason, 280);
    let log = ExecutionLog {
        id: Uuid::new_v4().to_string(),
        action_type: action_type.to_string(),
        title: sanitized_title,
        target: sanitized_target,
        status: status.to_string(),
        risk_level: risk_level.to_string(),
        reason: sanitized_reason,
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

fn sanitize_log_target(action_type: &str, target: &str) -> String {
    match action_type {
        "copy_text" | "create_note" | "create_reminder" => "[content hidden]".to_string(),
        "shell" => summarize_shell_command(target),
        _ => sanitize_log_text(target, 240),
    }
}

fn summarize_shell_command(command: &str) -> String {
    let executable = command
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_matches(|character| matches!(character, '"' | '\''));

    if executable.is_empty() {
        "shell".to_string()
    } else {
        format!("shell: {executable}")
    }
}

fn sanitize_log_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let without_data_urls = if trimmed.starts_with("data:") {
        "[data url hidden]".to_string()
    } else {
        trimmed.to_string()
    };

    let redacted_secrets = redact_secret_values(&redact_bearer_tokens(&without_data_urls));
    let truncated: String = redacted_secrets.chars().take(max_chars).collect();
    truncated
}

fn redact_bearer_tokens(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut output = String::new();
    let mut index = 0;
    while let Some(relative_start) = lower[index..].find("bearer ") {
        let start = index + relative_start;
        let value_start = start + "bearer ".len();
        output.push_str(&value[index..value_start]);
        output.push_str("[redacted]");
        index = skip_secret_value(value, value_start, None);
    }
    output.push_str(&value[index..]);
    output
}

fn redact_secret_values(value: &str) -> String {
    let mut output = String::new();
    let mut index = 0;
    while let Some((_start, value_start, quote)) = find_secret_assignment(value, index) {
        output.push_str(&value[index..value_start]);
        output.push_str("[redacted]");
        if let Some(quote) = quote {
            output.push(quote);
        }
        index = skip_secret_value(value, value_start, quote);
        if let Some(quote) = quote {
            if value[index..].starts_with(quote) {
                index += quote.len_utf8();
            }
        }
    }
    output.push_str(&value[index..]);
    output
}

fn find_secret_assignment(value: &str, from: usize) -> Option<(usize, usize, Option<char>)> {
    let lower = value.to_ascii_lowercase();
    let keys = [
        "api_key",
        "apikey",
        "access_token",
        "authorization",
        "password",
        "secret",
        "token",
    ];

    keys.iter()
        .filter_map(|key| {
            lower[from..]
                .find(key)
                .and_then(|relative_start| {
                    let key_start = from + relative_start;
                    secret_value_start(value, key_start + key.len()).map(|(value_start, quote)| {
                        if *key == "authorization"
                            && value[value_start..]
                                .to_ascii_lowercase()
                                .starts_with("bearer [redacted]")
                        {
                            None
                        } else {
                            Some((key_start, value_start, quote))
                        }
                    })
                })
                .flatten()
        })
        .min_by_key(|(key_start, _, _)| *key_start)
}

fn secret_value_start(value: &str, mut index: usize) -> Option<(usize, Option<char>)> {
    let bytes = value.as_bytes();
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index < bytes.len() && matches!(bytes[index], b'"' | b'\'') {
        index += 1;
    }
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() || !matches!(bytes[index], b'=' | b':') {
        return None;
    }
    index += 1;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index < bytes.len() && matches!(bytes[index], b'"' | b'\'') {
        return Some((index + 1, Some(bytes[index] as char)));
    }
    Some((index, None))
}

fn skip_secret_value(value: &str, mut index: usize, quote: Option<char>) -> usize {
    let bytes = value.as_bytes();
    if let Some(quote) = quote {
        while index < bytes.len() {
            if bytes[index] as char == quote {
                break;
            }
            index += 1;
        }
        return index;
    }

    while index < bytes.len() {
        if matches!(
            bytes[index],
            b'&' | b',' | b';' | b' ' | b'\n' | b'\r' | b'\t' | b'"' | b'\''
        ) {
            break;
        }
        index += 1;
    }
    index
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

pub fn clear_execution_logs(app: &AppHandle) -> Result<(), String> {
    let connection = open_database(app)?;
    connection
        .execute("DELETE FROM execution_logs", [])
        .map_err(|error| format!("Failed to clear execution logs: {error}"))?;
    Ok(())
}

pub fn delete_execution_log(app: &AppHandle, log_id: String) -> Result<(), String> {
    let connection = open_database(app)?;
    connection
        .execute("DELETE FROM execution_logs WHERE id = ?1", params![log_id])
        .map_err(|error| format!("Failed to delete execution log: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_content_for_clipboard_notes_and_reminders_logs() {
        assert_eq!(
            sanitize_log_target("copy_text", "super secret"),
            "[content hidden]"
        );
        assert_eq!(
            sanitize_log_target("create_note", "meeting password"),
            "[content hidden]"
        );
        assert_eq!(
            sanitize_log_target("create_reminder", "take medicine at 9"),
            "[content hidden]"
        );
    }

    #[test]
    fn summarizes_shell_target_without_full_command() {
        assert_eq!(sanitize_log_target("shell", "date"), "shell: date");
        assert_eq!(
            sanitize_log_target("shell", "mkdir -p ~/Desktop/test"),
            "shell: mkdir"
        );
    }

    #[test]
    fn redacts_secret_like_query_parameters() {
        let sanitized = sanitize_log_text(
            "https://example.com/callback?token=abc123&name=afu&api_key=secret",
            240,
        );
        assert!(sanitized.contains("?token=[redacted]"));
        assert!(sanitized.contains("&api_key=[redacted]"));
        assert!(sanitized.contains("&name=afu"));
    }

    #[test]
    fn redacts_bearer_and_json_like_secrets() {
        let sanitized = sanitize_log_text(
            r#"Authorization: Bearer sk-secret {"api_key":"abc","password":"pw","name":"afu"}"#,
            240,
        );
        assert!(sanitized.contains("Bearer [redacted]"));
        assert!(sanitized.contains(r#""api_key":"[redacted]""#));
        assert!(sanitized.contains(r#""password":"[redacted]""#));
        assert!(sanitized.contains(r#""name":"afu""#));
        assert!(!sanitized.contains("sk-secret"));
        assert!(!sanitized.contains("\"abc\""));
        assert!(!sanitized.contains("\"pw\""));
    }
}

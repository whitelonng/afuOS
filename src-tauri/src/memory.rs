use crate::config::load_app_config;
use crate::db::open_database;
use crate::logs::now_ms;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const DEFAULT_SOUL: &str = r#"你是阿福，也可以叫 afu。
你运行在 afuos 这款 macOS 软件里，是用户的本地管家。

核心性格：
- 简短、可靠、少废话。
- 先帮助用户完成眼前任务，不主动炫耀能力。
- 不确定时直接澄清，不编造。
- 涉及高风险本地动作时，先说明影响并要求确认。
- 尊重用户的权限、禁区目录和长期偏好。

交互风格：
- 中文为主，除非用户切换语言或明确要求英文。
- 可以亲切，但不要油腻、夸张或过度拟人。
- 执行完成后给出清楚结果；失败时说明原因和下一步。
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub content: String,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub kind: String,
    pub path: String,
    pub content: String,
}

pub fn list_memories(app: &AppHandle) -> Result<Vec<MemoryItem>, String> {
    let connection = open_database(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, content, source, created_at, updated_at
             FROM memories
             ORDER BY updated_at DESC",
        )
        .map_err(|error| format!("Failed to prepare memories query: {error}"))?;

    let memories = statement
        .query_map([], |row| {
            Ok(MemoryItem {
                id: row.get(0)?,
                content: row.get(1)?,
                source: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Failed to read memories: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect memories: {error}"))?;
    Ok(memories)
}

pub fn add_memory(app: &AppHandle, content: String, source: String) -> Result<MemoryItem, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("记忆内容不能为空".to_string());
    }

    let now = now_ms();
    let memory = MemoryItem {
        id: Uuid::new_v4().to_string(),
        content: trimmed.to_string(),
        source: if source.trim().is_empty() {
            "manual".to_string()
        } else {
            source
        },
        created_at: now,
        updated_at: now,
    };

    let connection = open_database(app)?;
    connection
        .execute(
            "INSERT INTO memories (id, content, source, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                memory.id,
                memory.content,
                memory.source,
                memory.created_at,
                memory.updated_at
            ],
        )
        .map_err(|error| format!("Failed to add memory: {error}"))?;

    enforce_memory_limit(app, &connection)?;

    Ok(memory)
}

fn enforce_memory_limit(app: &AppHandle, connection: &rusqlite::Connection) -> Result<(), String> {
    let limit = load_app_config(app)?.memory.max_long_term_memories as i64;
    connection
        .execute(
            "DELETE FROM memories
             WHERE id NOT IN (
               SELECT id FROM memories
               ORDER BY updated_at DESC, created_at DESC
               LIMIT ?1
             )",
            params![limit],
        )
        .map_err(|error| format!("Failed to enforce memory limit: {error}"))?;
    Ok(())
}

pub fn delete_memory(app: &AppHandle, id: String) -> Result<(), String> {
    let connection = open_database(app)?;
    connection
        .execute("DELETE FROM memories WHERE id = ?1", params![id])
        .map_err(|error| format!("Failed to delete memory: {error}"))?;
    Ok(())
}

pub fn clear_memories(app: &AppHandle) -> Result<(), String> {
    let connection = open_database(app)?;
    connection
        .execute("DELETE FROM memories", [])
        .map_err(|error| format!("Failed to clear memories: {error}"))?;
    Ok(())
}

pub fn read_memory_file(app: &AppHandle, kind: String) -> Result<MemoryFile, String> {
    let normalized = normalize_file_kind(&kind)?;
    let path = memory_file_path(app, normalized)?;
    let content = if path.exists() {
        std::fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {normalized} file: {error}"))?
    } else {
        default_file_content(normalized).to_string()
    };

    Ok(MemoryFile {
        kind: normalized.to_string(),
        path: path.to_string_lossy().to_string(),
        content,
    })
}

pub fn write_memory_file(
    app: &AppHandle,
    kind: String,
    content: String,
) -> Result<MemoryFile, String> {
    let normalized = normalize_file_kind(&kind)?;
    let path = memory_file_path(app, normalized)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create memory file directory: {error}"))?;
    }

    std::fs::write(&path, content)
        .map_err(|error| format!("Failed to write {normalized} file: {error}"))?;
    read_memory_file(app, normalized.to_string())
}

fn normalize_file_kind(kind: &str) -> Result<&'static str, String> {
    match kind.trim() {
        "memory" => Ok("memory"),
        "soul" => Ok("soul"),
        _ => Err("unknown_memory_file_kind".to_string()),
    }
}

fn memory_file_path(app: &AppHandle, kind: &str) -> Result<PathBuf, String> {
    let file_name = match kind {
        "memory" => "memory.md",
        "soul" => "soul.md",
        _ => return Err("unknown_memory_file_kind".to_string()),
    };

    app.path()
        .app_data_dir()
        .map(|dir| dir.join(file_name))
        .map_err(|error| format!("Failed to resolve memory file path: {error}"))
}

fn default_file_content(kind: &str) -> &'static str {
    match kind {
        "soul" => DEFAULT_SOUL,
        _ => "",
    }
}

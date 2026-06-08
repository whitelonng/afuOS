use crate::db::open_database;
use crate::logs::now_ms;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConversation {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    pub conversation: StoredConversation,
    pub messages: Vec<StoredMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConversationRequest {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<SaveMessageRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMessageRequest {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub created_at: i64,
}

pub fn save_conversation(app: &AppHandle, request: SaveConversationRequest) -> Result<(), String> {
    let connection = open_database(app)?;
    connection
        .execute(
            "INSERT INTO conversations (id, title, summary, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, updated_at = excluded.updated_at",
            params![
                request.id,
                request.title,
                request.summary,
                request.created_at,
                request.updated_at
            ],
        )
        .map_err(|error| format!("Failed to save conversation: {error}"))?;

    connection
        .execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![request.id],
        )
        .map_err(|error| format!("Failed to replace conversation messages: {error}"))?;

    for message in request.messages {
        connection
            .execute(
                "INSERT INTO messages (id, conversation_id, role, content, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    message.id,
                    request.id,
                    message.role,
                    message.content,
                    if message.created_at > 0 {
                        message.created_at
                    } else {
                        now_ms()
                    }
                ],
            )
            .map_err(|error| format!("Failed to save message: {error}"))?;
    }

    Ok(())
}

pub fn list_conversations(
    app: &AppHandle,
    limit: u32,
) -> Result<Vec<ConversationSnapshot>, String> {
    let connection = open_database(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, summary, created_at, updated_at
             FROM conversations
             ORDER BY updated_at DESC
             LIMIT ?1",
        )
        .map_err(|error| format!("Failed to prepare conversations query: {error}"))?;

    let conversations = statement
        .query_map([limit], |row| {
            Ok(StoredConversation {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Failed to read conversations: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect conversations: {error}"))?;

    conversations
        .into_iter()
        .map(|conversation| {
            let messages = list_messages_for_conversation(&connection, &conversation.id)?;
            Ok(ConversationSnapshot {
                conversation,
                messages,
            })
        })
        .collect()
}

fn list_messages_for_conversation(
    connection: &rusqlite::Connection,
    conversation_id: &str,
) -> Result<Vec<StoredMessage>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, conversation_id, role, content, created_at
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|error| format!("Failed to prepare messages query: {error}"))?;

    let messages = statement
        .query_map([conversation_id], |row| {
            Ok(StoredMessage {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Failed to read messages: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect messages: {error}"))?;
    Ok(messages)
}

use crate::db::open_database;
use crate::logs::now_ms;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub data_url: String,
    pub size: i64,
}

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
    pub image_attachments: Vec<ImageAttachment>,
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
    pub image_attachments: Vec<ImageAttachment>,
    #[serde(default)]
    pub created_at: i64,
}

pub fn save_conversation(app: &AppHandle, request: SaveConversationRequest) -> Result<(), String> {
    let mut connection = open_database(app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start conversation save transaction: {error}"))?;

    transaction
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

    transaction
        .execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![request.id],
        )
        .map_err(|error| format!("Failed to replace conversation messages: {error}"))?;

    for message in request.messages {
        let image_attachments = serde_json::to_string(&message.image_attachments)
            .map_err(|error| format!("Failed to serialize message images: {error}"))?;
        transaction
            .execute(
                "INSERT INTO messages (id, conversation_id, role, content, image_attachments, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    message.id,
                    request.id,
                    message.role,
                    message.content,
                    image_attachments,
                    if message.created_at > 0 {
                        message.created_at
                    } else {
                        now_ms()
                    }
                ],
            )
            .map_err(|error| format!("Failed to save message: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit conversation save: {error}"))?;

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

pub fn delete_conversation(app: &AppHandle, conversation_id: String) -> Result<(), String> {
    let mut connection = open_database(app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start conversation delete transaction: {error}"))?;
    transaction
        .execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|error| format!("Failed to delete conversation messages: {error}"))?;
    transaction
        .execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation_id],
        )
        .map_err(|error| format!("Failed to delete conversation: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit conversation delete: {error}"))?;
    Ok(())
}

pub fn clear_conversations(app: &AppHandle) -> Result<(), String> {
    let mut connection = open_database(app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start conversations clear transaction: {error}"))?;
    transaction
        .execute("DELETE FROM messages", [])
        .map_err(|error| format!("Failed to clear conversation messages: {error}"))?;
    transaction
        .execute("DELETE FROM conversations", [])
        .map_err(|error| format!("Failed to clear conversations: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit conversations clear: {error}"))?;
    Ok(())
}

fn list_messages_for_conversation(
    connection: &rusqlite::Connection,
    conversation_id: &str,
) -> Result<Vec<StoredMessage>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, conversation_id, role, content, image_attachments, created_at
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
                image_attachments: parse_image_attachments(row.get::<_, String>(4)?),
                created_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("Failed to read messages: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect messages: {error}"))?;
    Ok(messages)
}

fn parse_image_attachments(raw: String) -> Vec<ImageAttachment> {
    serde_json::from_str(&raw).unwrap_or_default()
}

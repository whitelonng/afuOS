#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod conversations;
mod db;
mod llm;
mod logs;
mod memory;
mod permissions;
mod system;
mod voice;

use config::{load_app_config, save_app_config, AppConfig};
use conversations::{
    list_conversations, save_conversation, ConversationSnapshot, SaveConversationRequest,
};
use llm::{chat_completion, chat_completion_stream, ChatMessage};
use logs::{list_execution_logs, ExecutionLog};
use memory::{
    add_memory, clear_memories, delete_memory, list_memories, read_memory_file, write_memory_file,
    MemoryFile, MemoryItem,
};
use serde::Serialize;
use std::{collections::HashSet, str::FromStr, sync::Mutex};
use system::{execute_local_action, plan_local_action, LocalActionRequest, LocalActionResponse};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use voice::{synthesize_speech, transcribe_speech, TtsAudioResponse};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamPayload {
    request_id: String,
    content: Option<String>,
}

const THINKING_REQUIRED_MARKER: &str = "AFUOS_THINKING_REQUIRED";

#[derive(Default)]
struct ChatCancellationState {
    cancelled_request_ids: Mutex<HashSet<String>>,
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    load_app_config(&app)
}

#[tauri::command]
fn plan_local_action_command(text: String) -> Result<Option<LocalActionRequest>, String> {
    Ok(plan_local_action(&text))
}

#[tauri::command]
fn execute_local_action_command(
    app: tauri::AppHandle,
    action: LocalActionRequest,
    confirmed: bool,
) -> Result<LocalActionResponse, String> {
    execute_local_action(&app, action, confirmed)
}

#[tauri::command]
fn list_execution_logs_command(
    app: tauri::AppHandle,
    limit: Option<u32>,
) -> Result<Vec<ExecutionLog>, String> {
    list_execution_logs(&app, limit.unwrap_or(80))
}

#[tauri::command]
fn save_conversation_command(
    app: tauri::AppHandle,
    conversation: SaveConversationRequest,
) -> Result<(), String> {
    save_conversation(&app, conversation)
}

#[tauri::command]
fn list_conversations_command(
    app: tauri::AppHandle,
    limit: Option<u32>,
) -> Result<Vec<ConversationSnapshot>, String> {
    list_conversations(&app, limit.unwrap_or(40))
}

#[tauri::command]
fn list_memories_command(app: tauri::AppHandle) -> Result<Vec<MemoryItem>, String> {
    list_memories(&app)
}

#[tauri::command]
fn add_memory_command(
    app: tauri::AppHandle,
    content: String,
    source: Option<String>,
) -> Result<MemoryItem, String> {
    add_memory(
        &app,
        content,
        source.unwrap_or_else(|| "manual".to_string()),
    )
}

#[tauri::command]
fn delete_memory_command(app: tauri::AppHandle, id: String) -> Result<(), String> {
    delete_memory(&app, id)
}

#[tauri::command]
fn clear_memories_command(app: tauri::AppHandle) -> Result<(), String> {
    clear_memories(&app)
}

#[tauri::command]
fn read_memory_file_command(app: tauri::AppHandle, kind: String) -> Result<MemoryFile, String> {
    read_memory_file(&app, kind)
}

#[tauri::command]
fn write_memory_file_command(
    app: tauri::AppHandle,
    kind: String,
    content: String,
) -> Result<MemoryFile, String> {
    write_memory_file(&app, kind, content)
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    let previous = load_app_config(&app)?;
    register_configured_shortcut(&app, &config.general.shortcut)?;

    if let Err(error) = save_app_config(&app, &config) {
        let _ = register_configured_shortcut(&app, &previous.general.shortcut);
        return Err(error);
    }

    println!(
        "afuos config saved; active shortcut: {}",
        shortcut_label(&config.general.shortcut)
    );
    Ok(config)
}

#[tauri::command]
fn validate_shortcut(shortcut: String) -> Result<String, String> {
    let label = shortcut_label(&shortcut);
    Shortcut::from_str(&label).map_err(|error| format!("Invalid shortcut: {error}"))?;
    Ok(label)
}

fn register_configured_shortcut(
    app: &tauri::AppHandle,
    configured_shortcut: &str,
) -> Result<(), String> {
    let label = shortcut_label(configured_shortcut);
    let shortcut =
        Shortcut::from_str(&label).map_err(|error| format!("Invalid shortcut: {error}"))?;

    app.global_shortcut()
        .unregister_all()
        .map_err(|error| format!("Failed to clear global shortcuts: {error}"))?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|error| format!("Failed to register global shortcut `{label}`: {error}"))?;

    println!("afuos global shortcut registered: {label}");
    Ok(())
}

#[tauri::command]
fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    show_settings(&app);
    Ok(())
}

fn shortcut_label(configured_shortcut: &str) -> String {
    let trimmed = configured_shortcut.trim();
    if trimmed.is_empty() {
        AppConfig::default().general.shortcut
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
async fn send_chat_stream(
    app: tauri::AppHandle,
    window: tauri::Window,
    cancellation_state: tauri::State<'_, ChatCancellationState>,
    request_id: String,
    messages: Vec<ChatMessage>,
    reasoning_mode: Option<String>,
) -> Result<(), String> {
    let config = load_app_config(&app)?;
    let text_model = config.models.active_text_model();
    forget_cancelled_chat(&cancellation_state, &request_id)?;
    chat_completion_stream(
        &text_model,
        messages,
        reasoning_mode.as_deref().unwrap_or("fast"),
        |content| {
            window
                .emit(
                    "assistant://chat-delta",
                    ChatStreamPayload {
                        request_id: request_id.clone(),
                        content: Some(content),
                    },
                )
                .map_err(|error| format!("chat_delta_emit_failed: {error}"))
        },
        || is_chat_cancelled(&cancellation_state, &request_id),
    )
    .await
    .inspect_err(|_| {
        let _ = forget_cancelled_chat(&cancellation_state, &request_id);
    })?;

    window
        .emit(
            "assistant://chat-finished",
            ChatStreamPayload {
                request_id,
                content: None,
            },
        )
        .map_err(|error| format!("chat_finished_emit_failed: {error}"))?;

    Ok(())
}

#[tauri::command]
fn cancel_chat_stream(
    cancellation_state: tauri::State<'_, ChatCancellationState>,
    request_id: String,
) -> Result<(), String> {
    cancellation_state
        .cancelled_request_ids
        .lock()
        .map_err(|error| format!("chat_cancel_lock_failed: {error}"))?
        .insert(request_id);
    Ok(())
}

fn is_chat_cancelled(
    cancellation_state: &tauri::State<'_, ChatCancellationState>,
    request_id: &str,
) -> bool {
    cancellation_state
        .cancelled_request_ids
        .lock()
        .map(|cancelled| cancelled.contains(request_id))
        .unwrap_or(true)
}

fn forget_cancelled_chat(
    cancellation_state: &tauri::State<'_, ChatCancellationState>,
    request_id: &str,
) -> Result<(), String> {
    cancellation_state
        .cancelled_request_ids
        .lock()
        .map_err(|error| format!("chat_cancel_lock_failed: {error}"))?
        .remove(request_id);
    Ok(())
}

#[tauri::command]
async fn classify_reasoning_mode_command(
    app: tauri::AppHandle,
    text: String,
) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok("fast".to_string());
    }

    let config = load_app_config(&app)?;
    let text_model = config.models.active_text_model();
    let response = chat_completion(
        &text_model,
        vec![
            ChatMessage {
                role: "system".to_string(),
                content: format!(
                    "你只判断用户请求是否需要深度思考。只输出 {THINKING_REQUIRED_MARKER} 或 AFUOS_FAST_OK。\n\
需要深度思考：复杂分析、规划、代码、调试、架构、长文、多步骤推理、权衡取舍、需要较高准确性的决策。\n\
快速即可：闲聊、简单问答、打开应用、创建文件夹、简短改写、普通本地命令、无需推理的执行请求。"
                ),
            },
            ChatMessage {
                role: "user".to_string(),
                content: trimmed.to_string(),
            },
        ],
    )
    .await?;

    Ok(reasoning_mode_from_classifier_output(&response).to_string())
}

fn reasoning_mode_from_classifier_output(output: &str) -> &'static str {
    if output.contains(THINKING_REQUIRED_MARKER) {
        "thinking"
    } else {
        "fast"
    }
}

#[tauri::command]
async fn synthesize_speech_command(
    app: tauri::AppHandle,
    input: String,
) -> Result<TtsAudioResponse, String> {
    let config = load_app_config(&app)?;
    let mut tts_model = config.models.active_tts_model();
    let text_model = config.models.active_text_model();
    let result = synthesize_speech(&tts_model, input.clone()).await;

    if let Err(error) = &result {
        if error.contains("401")
            && !text_model.api_key.trim().is_empty()
            && text_model.api_key.trim() != tts_model.api_key.trim()
        {
            tts_model.api_key = text_model.api_key;
            return synthesize_speech(&tts_model, input).await;
        }
    }

    result
}

#[tauri::command]
async fn transcribe_speech_command(
    app: tauri::AppHandle,
    base64_audio: String,
    mime_type: String,
) -> Result<String, String> {
    let config = load_app_config(&app)?;
    let mut stt_config = config.models.active_stt_model();
    if stt_config.model.trim().is_empty() {
        stt_config.model = config.voice.stt_model;
    }
    transcribe_speech(&stt_config, base64_audio, mime_type).await
}

#[tauri::command]
fn toggle_assistant_window(app: tauri::AppHandle) -> Result<(), String> {
    toggle_window(&app);
    Ok(())
}

#[tauri::command]
fn hide_assistant_window(app: tauri::AppHandle) -> Result<(), String> {
    hide_window(&app);
    Ok(())
}

#[tauri::command]
fn start_window_drag(window: tauri::Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|error| format!("start_window_drag_failed: {error}"))
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(true);
        if visible {
            hide_window(app);
        } else {
            show_window(app);
        }
    }
}

fn hide_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        println!("afuos window hidden");
    }
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("assistant://wakeup", ());
        println!("afuos window shown");
    }
}

fn show_settings(app: &tauri::AppHandle) {
    show_window(app);
    let _ = app.emit("assistant://open-settings", ());
    println!("afuos settings opened");
}

fn install_tray_icon(app: &mut tauri::App) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    let settings_item = MenuItem::with_id(app, "open-settings", "进入设置", true, None::<&str>)?;
    let quit_item = PredefinedMenuItem::quit(app, Some("退出"))?;
    let tray_menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

    TrayIconBuilder::with_id("main")
        .tooltip("afuos")
        .icon(icon)
        .icon_as_template(false)
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "open-settings" {
                show_settings(app);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                println!("afuos tray clicked: show assistant window");
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    println!("afuos tray icon installed");
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(ChatCancellationState::default())
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            println!("afuos global shortcut pressed: {shortcut}");
                            toggle_window(app);
                        }
                    })
                    .build(),
            )?;

            let config = load_app_config(app.handle())?;
            let _ = db::open_database(app.handle())?;
            register_configured_shortcut(app.handle(), &config.general.shortcut)?;
            install_tray_icon(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            plan_local_action_command,
            execute_local_action_command,
            list_execution_logs_command,
            save_conversation_command,
            list_conversations_command,
            list_memories_command,
            add_memory_command,
            delete_memory_command,
            clear_memories_command,
            read_memory_file_command,
            write_memory_file_command,
            save_config,
            validate_shortcut,
            send_chat_stream,
            cancel_chat_stream,
            classify_reasoning_mode_command,
            synthesize_speech_command,
            transcribe_speech_command,
            toggle_assistant_window,
            hide_assistant_window,
            start_window_drag,
            show_settings_window
        ])
        .build(tauri::generate_context!())
        .expect("error while building afuos")
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event {
                show_window(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_label_falls_back_to_default_when_blank() {
        assert_eq!(shortcut_label("  "), "Cmd+Shift+Space");
    }

    #[test]
    fn configured_shortcut_accepts_common_macos_label() {
        assert!(validate_shortcut("CmdOrCtrl+Shift+Space".to_string()).is_ok());
        assert!(validate_shortcut("Cmd+Shift+Space".to_string()).is_ok());
        assert!(validate_shortcut("Cmd+Alt+A".to_string()).is_ok());
        assert!(validate_shortcut("Cmd+Ctrl+Shift+K".to_string()).is_ok());
    }

    #[test]
    fn classifier_marker_enables_thinking_mode() {
        assert_eq!(
            reasoning_mode_from_classifier_output("AFUOS_THINKING_REQUIRED"),
            "thinking"
        );
        assert_eq!(
            reasoning_mode_from_classifier_output("AFUOS_FAST_OK"),
            "fast"
        );
    }
}

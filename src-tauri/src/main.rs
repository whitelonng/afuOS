#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod conversations;
mod db;
mod llm;
mod logs;
mod mcp;
mod memory;
mod permissions;
mod skills;
mod system;
mod voice;

use config::{load_app_config, save_app_config, AppConfig};
use conversations::{
    clear_conversations, delete_conversation, list_conversations, save_conversation,
    ConversationSnapshot, SaveConversationRequest,
};
use llm::{chat_completion, chat_completion_stream, ChatMessage};
use logs::{
    clear_execution_logs, delete_execution_log, list_execution_logs, write_execution_log,
    ExecutionLog,
};
use mcp::{
    call_mcp_tool, classify_mcp_tool_risk, inspect_mcp_server, McpInspectionResult, McpToolRequest,
};
use memory::{
    add_memory, clear_memories, delete_memory, enforce_memory_limit_for_app, import_memories,
    list_memories, read_memory_file, write_memory_file, MemoryFile, MemoryItem,
};
use permissions::{
    clear_permission_rules, delete_permission_rule, find_permission_rule, list_permission_rules,
    remembered_decision, save_permission_rule, PermissionRule,
};
use serde::Serialize;
use skills::{read_skill_documents, SkillDocument};
use std::{collections::HashSet, str::FromStr, sync::Mutex};
use system::{
    execute_local_action, plan_local_action, ConfirmationPayload, LocalActionRequest,
    LocalActionResponse,
};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, LogicalSize, Manager, RunEvent, Size};
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
    remember: Option<bool>,
) -> Result<LocalActionResponse, String> {
    execute_local_action(&app, action, confirmed, remember.unwrap_or(false))
}

#[tauri::command]
fn list_execution_logs_command(
    app: tauri::AppHandle,
    limit: Option<u32>,
) -> Result<Vec<ExecutionLog>, String> {
    list_execution_logs(&app, limit.unwrap_or(80))
}

#[tauri::command]
fn clear_execution_logs_command(app: tauri::AppHandle) -> Result<(), String> {
    clear_execution_logs(&app)
}

#[tauri::command]
fn delete_execution_log_command(app: tauri::AppHandle, log_id: String) -> Result<(), String> {
    delete_execution_log(&app, log_id)
}

#[tauri::command]
fn write_execution_log_command(
    app: tauri::AppHandle,
    action_type: String,
    title: String,
    target: String,
    status: String,
    risk_level: String,
    reason: String,
) -> Result<ExecutionLog, String> {
    write_execution_log(
        &app,
        &action_type,
        &title,
        &target,
        &status,
        &risk_level,
        &reason,
    )
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
fn delete_conversation_command(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<(), String> {
    delete_conversation(&app, conversation_id)
}

#[tauri::command]
fn clear_conversations_command(app: tauri::AppHandle) -> Result<(), String> {
    clear_conversations(&app)
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
fn import_memories_command(
    app: tauri::AppHandle,
    memories: Vec<MemoryItem>,
) -> Result<usize, String> {
    import_memories(&app, memories)
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
fn read_skill_documents_command(paths: Vec<String>) -> Vec<SkillDocument> {
    read_skill_documents(paths)
}

#[tauri::command]
fn inspect_mcp_server_command(command: String) -> McpInspectionResult {
    inspect_mcp_server(&command)
}

#[tauri::command]
fn call_mcp_tool_command(
    app: tauri::AppHandle,
    request: McpToolRequest,
    confirmed: bool,
    remember: Option<bool>,
) -> Result<McpToolExecutionResponse, String> {
    execute_mcp_tool(&app, request, confirmed, remember.unwrap_or(false))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpToolExecutionResponse {
    status: String,
    message: String,
    request: Option<McpToolRequest>,
    confirmation: Option<ConfirmationPayload>,
    log: Option<ExecutionLog>,
}

fn execute_mcp_tool(
    app: &tauri::AppHandle,
    request: McpToolRequest,
    confirmed: bool,
    remember: bool,
) -> Result<McpToolExecutionResponse, String> {
    let title = format!("调用 MCP 工具 {}", request.tool_name);
    let target = format!(
        "{}:{}",
        request.server_name.trim(),
        request.tool_name.trim()
    );
    let rule_target = format!("{}::{}", request.command.trim(), request.tool_name.trim());
    let remembered = find_permission_rule(app, "mcp_tool", &rule_target)?
        .and_then(|rule| remembered_decision(&rule.decision));
    let (risk_level, reason) = classify_mcp_tool_risk(&request.tool_name);
    let decision = merge_system_permission_decision(
        system_permission_decision(&risk_level, &reason),
        remembered,
    );

    if decision.status == permissions::PermissionStatus::Deny {
        let log = write_execution_log(
            app,
            "mcp_tool",
            &title,
            &target,
            "denied",
            &decision.risk_level,
            &decision.reason,
        )
        .ok();
        return Ok(McpToolExecutionResponse {
            status: "failed".to_string(),
            message: decision.reason,
            request: Some(request),
            confirmation: None,
            log,
        });
    }

    if decision.status == permissions::PermissionStatus::RequireConfirmation && !confirmed {
        let request_command = request.tool_name.clone();
        return Ok(McpToolExecutionResponse {
            status: "requiresConfirmation".to_string(),
            message: decision.reason.clone(),
            request: Some(request),
            confirmation: Some(ConfirmationPayload {
                title,
                description: decision.reason.clone(),
                risk_level: decision.risk_level.clone(),
                command: request_command,
                target,
            }),
            log: None,
        });
    }

    if confirmed && remember && decision.risk_level == "low" {
        let _ = save_permission_rule(app, "mcp_tool", &rule_target, "allow");
    }

    let result = call_mcp_tool(
        &request.command,
        &request.tool_name,
        request.arguments.clone(),
    );
    let status = if result.status == "ok" {
        "completed"
    } else {
        "failed"
    };
    let message = if result.status == "ok" {
        result.content.clone()
    } else {
        result.error.clone()
    };
    let log = write_execution_log(
        app,
        "mcp_tool",
        &title,
        &target,
        status,
        &decision.risk_level,
        &decision.reason,
    )
    .ok();

    Ok(McpToolExecutionResponse {
        status: status.to_string(),
        message: if message.trim().is_empty() {
            if result.status == "ok" {
                "MCP 工具已执行完成".to_string()
            } else {
                "MCP 工具调用失败".to_string()
            }
        } else if result.status == "ok" {
            message
        } else {
            format!(
                "{}{}{}",
                message,
                if result.content.trim().is_empty() {
                    ""
                } else {
                    "\n"
                },
                result.content
            )
            .trim()
            .to_string()
        },
        request: Some(request),
        confirmation: None,
        log,
    })
}

fn system_permission_decision(risk_level: &str, reason: &str) -> permissions::PermissionDecision {
    if risk_level == "high" {
        permissions::PermissionDecision {
            status: permissions::PermissionStatus::RequireConfirmation,
            risk_level: risk_level.to_string(),
            reason: reason.to_string(),
        }
    } else {
        permissions::PermissionDecision {
            status: permissions::PermissionStatus::Allow,
            risk_level: risk_level.to_string(),
            reason: reason.to_string(),
        }
    }
}

fn merge_system_permission_decision(
    base_decision: permissions::PermissionDecision,
    remembered_decision: Option<permissions::PermissionDecision>,
) -> permissions::PermissionDecision {
    if base_decision.status == permissions::PermissionStatus::Deny
        || base_decision.risk_level != "low"
    {
        base_decision
    } else {
        remembered_decision.unwrap_or(base_decision)
    }
}

#[tauri::command]
fn list_permission_rules_command(app: tauri::AppHandle) -> Result<Vec<PermissionRule>, String> {
    list_permission_rules(&app)
}

#[tauri::command]
fn delete_permission_rule_command(app: tauri::AppHandle, rule_id: String) -> Result<(), String> {
    delete_permission_rule(&app, rule_id)
}

#[tauri::command]
fn clear_permission_rules_command(app: tauri::AppHandle) -> Result<(), String> {
    clear_permission_rules(&app)
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

    enforce_memory_limit_for_app(&app)?;
    if let Err(error) = apply_configured_window_size(&app, &config.general.window_size) {
        eprintln!("afuos failed to apply configured window size after save: {error}");
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
    let has_images = messages.iter().any(ChatMessage::has_image);
    let text_model = if has_images {
        config
            .models
            .active_vision_model()
            .ok_or_else(|| "missing_vision_model".to_string())?
    } else {
        config.models.active_text_model()
    };
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
            ChatMessage::text(
                "system",
                format!(
                    "你只判断用户请求是否需要深度思考。只输出 {THINKING_REQUIRED_MARKER} 或 AFUOS_FAST_OK。\n\
需要深度思考：复杂分析、规划、代码、调试、架构、长文、多步骤推理、权衡取舍、需要较高准确性的决策。\n\
快速即可：闲聊、简单问答、打开应用、创建文件夹、简短改写、普通本地命令、无需推理的执行请求。"
                ),
            ),
            ChatMessage::text("user", trimmed.to_string()),
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
    let mut tts_model = config
        .models
        .selected_tts_model()
        .ok_or_else(|| "missing_tts_profile".to_string())?;
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
    let mut stt_config = if config.voice.stt_mode == "model" {
        config
            .models
            .selected_stt_model()
            .ok_or_else(|| "missing_stt_profile".to_string())?
    } else {
        config.models.active_stt_model()
    };
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
        let focused = window.is_focused().unwrap_or(false);
        if should_hide_on_toggle(visible, focused) {
            hide_window(app);
        } else {
            show_window(app, true);
        }
    }
}

fn should_hide_on_toggle(visible: bool, focused: bool) -> bool {
    visible && focused
}

fn hide_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        println!("afuos window hidden");
    }
}

fn show_window(app: &tauri::AppHandle, emit_wakeup: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        if emit_wakeup {
            let _ = app.emit("assistant://wakeup", ());
        }
        println!("afuos window shown");
    }
}

fn show_settings(app: &tauri::AppHandle) {
    show_window(app, false);
    let _ = app.emit("assistant://open-settings", ());
    println!("afuos settings opened");
}

fn apply_configured_window_size(
    app: &tauri::AppHandle,
    configured_window_size: &str,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let (width, height) = window_size_dimensions(configured_window_size);
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| format!("set_window_size_failed: {error}"))?;
    Ok(())
}

fn window_size_dimensions(configured_window_size: &str) -> (f64, f64) {
    match configured_window_size.trim() {
        "small" => (640.0, 500.0),
        "large" => (920.0, 700.0),
        _ => (760.0, 560.0),
    }
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
                show_window(tray.app_handle(), false);
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
            if let Err(error) =
                apply_configured_window_size(app.handle(), &config.general.window_size)
            {
                eprintln!("afuos failed to apply configured window size during setup: {error}");
            }
            install_tray_icon(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            plan_local_action_command,
            execute_local_action_command,
            list_execution_logs_command,
            clear_execution_logs_command,
            delete_execution_log_command,
            write_execution_log_command,
            save_conversation_command,
            list_conversations_command,
            delete_conversation_command,
            clear_conversations_command,
            list_memories_command,
            add_memory_command,
            import_memories_command,
            delete_memory_command,
            clear_memories_command,
            list_permission_rules_command,
            delete_permission_rule_command,
            clear_permission_rules_command,
            read_skill_documents_command,
            inspect_mcp_server_command,
            call_mcp_tool_command,
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
                show_window(app, false);
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
    fn visible_unfocused_window_is_shown_not_hidden_on_toggle() {
        assert!(should_hide_on_toggle(true, true));
        assert!(!should_hide_on_toggle(true, false));
        assert!(!should_hide_on_toggle(false, false));
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

    #[test]
    fn window_size_dimensions_use_expected_presets() {
        assert_eq!(window_size_dimensions("small"), (640.0, 500.0));
        assert_eq!(window_size_dimensions("medium"), (760.0, 560.0));
        assert_eq!(window_size_dimensions("large"), (920.0, 700.0));
        assert_eq!(window_size_dimensions("unknown"), (760.0, 560.0));
    }

    #[test]
    fn high_risk_mcp_decision_ignores_remembered_allow() {
        let base_decision = permissions::PermissionDecision {
            status: permissions::PermissionStatus::RequireConfirmation,
            risk_level: "high".to_string(),
            reason: "MCP 工具可能修改外部系统，必须确认".to_string(),
        };
        let remembered = Some(permissions::PermissionDecision {
            status: permissions::PermissionStatus::Allow,
            risk_level: "remembered".to_string(),
            reason: "已按你的授权记录长期允许".to_string(),
        });

        let merged = merge_system_permission_decision(base_decision.clone(), remembered);
        assert_eq!(
            merged.status,
            permissions::PermissionStatus::RequireConfirmation
        );
        assert_eq!(merged.risk_level, base_decision.risk_level);
    }

    #[test]
    fn low_risk_mcp_decision_can_use_remembered_allow() {
        let base_decision = permissions::PermissionDecision {
            status: permissions::PermissionStatus::Allow,
            risk_level: "low".to_string(),
            reason: "低风险 MCP 工具".to_string(),
        };
        let remembered = Some(permissions::PermissionDecision {
            status: permissions::PermissionStatus::Allow,
            risk_level: "remembered".to_string(),
            reason: "已按你的授权记录长期允许".to_string(),
        });

        let merged = merge_system_permission_decision(base_decision, remembered);
        assert_eq!(merged.status, permissions::PermissionStatus::Allow);
        assert_eq!(merged.risk_level, "remembered");
    }
}

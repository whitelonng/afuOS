use crate::config::load_app_config;
use crate::logs::{write_execution_log, ExecutionLog};
use crate::permissions::{decide, PermissionDecision, PermissionStatus};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalActionRequest {
    pub action_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub app_name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationPayload {
    pub title: String,
    pub description: String,
    pub risk_level: String,
    pub command: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalActionResponse {
    pub status: String,
    pub message: String,
    pub action: Option<LocalActionRequest>,
    pub confirmation: Option<ConfirmationPayload>,
    pub log: Option<ExecutionLog>,
}

pub fn plan_local_action(text: &str) -> Option<LocalActionRequest> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.contains("浏览器") && trimmed.contains("打开") {
        return Some(LocalActionRequest::open_app(resolve_app_name("浏览器")));
    }

    if let Some(folder_name) = plan_desktop_folder_name(trimmed) {
        return Some(LocalActionRequest::shell(&format!(
            "mkdir -p ~/Desktop/{}",
            shell_quote(&folder_name)
        )));
    }

    if let Some(command) = strip_any_prefix(
        trimmed,
        &["运行命令", "执行命令", "运行 shell", "执行 shell"],
    ) {
        return Some(LocalActionRequest::shell(command));
    }

    if let Some(copied) = strip_any_prefix(trimmed, &["复制", "拷贝"]) {
        let text = copied
            .trim_end_matches("到剪贴板")
            .trim_end_matches("到剪切板")
            .trim()
            .to_string();
        if !text.is_empty() {
            return Some(LocalActionRequest::copy_text(text));
        }
    }

    if trimmed.contains("创建备忘录")
        || trimmed.contains("添加备忘录")
        || trimmed.contains("新建备忘录")
    {
        let content = extract_after_markers(trimmed, &["内容是", "内容为", "：", ":"])
            .unwrap_or_else(|| {
                trimmed
                    .replace("创建备忘录", "")
                    .replace("添加备忘录", "")
                    .replace("新建备忘录", "")
            });
        let content = content.trim().to_string();
        if !content.is_empty() {
            return Some(LocalActionRequest::create_note(content));
        }
    }

    if trimmed.contains("提醒我") || trimmed.contains("创建提醒") || trimmed.contains("添加提醒")
    {
        let title = trimmed
            .replace("提醒我", "")
            .replace("创建提醒", "")
            .replace("添加提醒", "")
            .trim()
            .to_string();
        if !title.is_empty() {
            return Some(LocalActionRequest::create_reminder(title));
        }
    }

    if let Some(target) = strip_any_prefix(trimmed, &["打开"]) {
        let target = target.trim();
        if target.is_empty() {
            return None;
        }

        if target.contains("下载") || target.eq_ignore_ascii_case("downloads") {
            if let Some(home) = dirs::home_dir() {
                return Some(LocalActionRequest::open_path(
                    home.join("Downloads").to_string_lossy().to_string(),
                ));
            }
        }

        if looks_like_url(target) {
            return Some(LocalActionRequest::open_url(normalize_url(target)));
        }

        if target.contains('/') || target.starts_with('~') {
            return Some(LocalActionRequest::open_path(expand_home(target)));
        }

        return Some(LocalActionRequest::open_app(resolve_app_name(target)));
    }

    None
}

pub fn execute_local_action(
    app: &AppHandle,
    action: LocalActionRequest,
    confirmed: bool,
) -> Result<LocalActionResponse, String> {
    let config = load_app_config(app)?;
    let target_path = if action.action_type == "open_path" {
        Some(action.path.as_str())
    } else {
        None
    };
    let decision = decide(&config.permissions, &action.action_type, target_path);

    if decision.status == PermissionStatus::Deny {
        let log = write_log_for_action(app, &action, "denied", &decision)?;
        return Ok(LocalActionResponse {
            status: "denied".to_string(),
            message: decision.reason,
            action: Some(action),
            confirmation: None,
            log: Some(log),
        });
    }

    if decision.status == PermissionStatus::RequireConfirmation && !confirmed {
        return Ok(LocalActionResponse {
            status: "requiresConfirmation".to_string(),
            message: decision.reason.clone(),
            confirmation: Some(confirmation_for_action(&action, &decision)),
            action: Some(action),
            log: None,
        });
    }

    let result = perform_action(&action);
    let (status, message) = match result {
        Ok(message) => ("completed".to_string(), message),
        Err(error) => ("failed".to_string(), error),
    };
    let log = write_log_for_action(app, &action, &status, &decision)?;

    Ok(LocalActionResponse {
        status,
        message,
        action: Some(action),
        confirmation: None,
        log: Some(log),
    })
}

fn perform_action(action: &LocalActionRequest) -> Result<String, String> {
    match action.action_type.as_str() {
        "open_app" => run_status(
            Command::new("open").args(["-a", &action.app_name]),
            &format!("已打开 {}", action.title),
        ),
        "open_url" => run_status(
            Command::new("open").arg(&action.url),
            &format!("已打开 {}", action.url),
        ),
        "open_path" => run_status(
            Command::new("open").arg(&action.path),
            &format!("已打开 {}", action.path),
        ),
        "copy_text" => copy_to_clipboard(&action.text),
        "create_note" => create_note(&action.text),
        "create_reminder" => create_reminder(&action.title),
        "shell" => run_shell(&action.command),
        _ => Err("未知动作类型".to_string()),
    }
}

fn run_status(command: &mut Command, success_message: &str) -> Result<String, String> {
    let output = command
        .output()
        .map_err(|error| format!("执行失败：{error}"))?;
    if output.status.success() {
        Ok(success_message.to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn copy_to_clipboard(text: &str) -> Result<String, String> {
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法打开剪贴板：{error}"))?;
    let stdin = child.stdin.as_mut().ok_or("无法写入剪贴板")?;
    stdin
        .write_all(text.as_bytes())
        .map_err(|error| format!("无法写入剪贴板：{error}"))?;
    let status = child
        .wait()
        .map_err(|error| format!("剪贴板命令失败：{error}"))?;
    if status.success() {
        Ok("已复制到剪贴板".to_string())
    } else {
        Err("复制到剪贴板失败".to_string())
    }
}

fn create_note(content: &str) -> Result<String, String> {
    run_osascript(
        &format!(
            r#"tell application "Notes"
                 activate
                 tell account "iCloud"
                   make new note at folder "Notes" with properties {{name:"阿福备忘录", body:{}}}
                 end tell
               end tell"#,
            apple_script_string(content)
        ),
        "已创建备忘录",
    )
}

fn create_reminder(title: &str) -> Result<String, String> {
    run_osascript(
        &format!(
            r#"tell application "Reminders"
                 activate
                 tell default list
                   make new reminder with properties {{name:{}}}
                 end tell
               end tell"#,
            apple_script_string(title)
        ),
        "已创建提醒事项",
    )
}

fn run_osascript(script: &str, success_message: &str) -> Result<String, String> {
    run_status(
        Command::new("osascript").arg("-e").arg(script),
        success_message,
    )
}

fn run_shell(command: &str) -> Result<String, String> {
    let output = Command::new("zsh")
        .arg("-lc")
        .arg(command)
        .output()
        .map_err(|error| format!("命令执行失败：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        if stdout.is_empty() {
            Ok("命令已执行完成".to_string())
        } else {
            Ok(stdout)
        }
    } else if stderr.is_empty() {
        Err("命令执行失败".to_string())
    } else {
        Err(stderr)
    }
}

fn write_log_for_action(
    app: &AppHandle,
    action: &LocalActionRequest,
    status: &str,
    decision: &PermissionDecision,
) -> Result<ExecutionLog, String> {
    write_execution_log(
        app,
        &action.action_type,
        &action.title,
        &target_for_action(action),
        status,
        &decision.risk_level,
        &decision.reason,
    )
}

fn confirmation_for_action(
    action: &LocalActionRequest,
    decision: &PermissionDecision,
) -> ConfirmationPayload {
    ConfirmationPayload {
        title: action.title.clone(),
        description: decision.reason.clone(),
        risk_level: decision.risk_level.clone(),
        command: action.command.clone(),
        target: target_for_action(action),
    }
}

fn target_for_action(action: &LocalActionRequest) -> String {
    match action.action_type.as_str() {
        "open_app" => action.app_name.clone(),
        "open_url" => action.url.clone(),
        "open_path" => action.path.clone(),
        "copy_text" => action.text.chars().take(80).collect(),
        "create_note" => action.text.chars().take(80).collect(),
        "create_reminder" => action.title.clone(),
        "shell" => action.command.clone(),
        _ => String::new(),
    }
}

fn strip_any_prefix<'a>(text: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    prefixes.iter().find_map(|prefix| text.strip_prefix(prefix))
}

fn extract_after_markers(text: &str, markers: &[&str]) -> Option<String> {
    markers.iter().find_map(|marker| {
        text.split_once(marker)
            .map(|(_, value)| value.trim().to_string())
    })
}

fn looks_like_url(value: &str) -> bool {
    value.starts_with("http://")
        || value.starts_with("https://")
        || (value.contains('.') && !value.contains(' '))
}

fn normalize_url(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("https://{value}")
    }
}

fn expand_home(path: &str) -> String {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

fn resolve_app_name(target: &str) -> String {
    match target.trim().to_lowercase().as_str() {
        "备忘录" | "notes" => "Notes".to_string(),
        "微信" | "wechat" => "WeChat".to_string(),
        "提醒事项" | "reminders" => "Reminders".to_string(),
        "浏览器" | "chrome" | "google chrome" => "Google Chrome".to_string(),
        "safari" => "Safari".to_string(),
        other => other.to_string(),
    }
}

fn apple_script_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn plan_desktop_folder_name(text: &str) -> Option<String> {
    let normalized = text.trim_start_matches("阿福").trim();
    let mentions_desktop =
        normalized.contains("桌面") || normalized.to_lowercase().contains("desktop");
    let creates_folder = (text.contains("创建") || text.contains("新建") || text.contains("建立"))
        && (normalized.contains("文件夹") || normalized.contains("目录"));
    if !creates_folder {
        return None;
    }

    extract_folder_name(
        normalized,
        &[
            "名字叫做",
            "名字叫",
            "叫做",
            "名称叫做",
            "名称叫",
            "名为",
            "名称是",
            "名称为",
            "名字是",
            "名字为",
            "叫",
        ],
    )
    .filter(|value| !value.is_empty())
    .or_else(|| {
        if mentions_desktop {
            Some("新文件夹".to_string())
        } else {
            None
        }
    })
}

fn extract_folder_name(text: &str, markers: &[&str]) -> Option<String> {
    extract_after_markers(text, markers)
        .map(|value| {
            value
                .replace("的文件夹", "")
                .replace("文件夹", "")
                .replace("在桌面", "")
                .replace("到桌面", "")
                .trim_matches(|character: char| {
                    character.is_whitespace()
                        || matches!(character, '，' | ',' | '。' | '.' | '"' | '\'' | '“' | '”')
                })
                .trim()
                .to_string()
        })
        .filter(|value| !value.is_empty())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl LocalActionRequest {
    fn open_app(app_name: String) -> Self {
        Self {
            action_type: "open_app".to_string(),
            title: format!("打开 {app_name}"),
            app_name,
            url: String::new(),
            path: String::new(),
            text: String::new(),
            command: String::new(),
        }
    }

    fn open_url(url: String) -> Self {
        Self {
            action_type: "open_url".to_string(),
            title: format!("打开 {url}"),
            app_name: String::new(),
            url,
            path: String::new(),
            text: String::new(),
            command: String::new(),
        }
    }

    fn open_path(path: String) -> Self {
        Self {
            action_type: "open_path".to_string(),
            title: format!("打开 {path}"),
            app_name: String::new(),
            url: String::new(),
            path,
            text: String::new(),
            command: String::new(),
        }
    }

    fn copy_text(text: String) -> Self {
        Self {
            action_type: "copy_text".to_string(),
            title: "复制文本到剪贴板".to_string(),
            app_name: String::new(),
            url: String::new(),
            path: String::new(),
            text,
            command: String::new(),
        }
    }

    fn create_note(text: String) -> Self {
        Self {
            action_type: "create_note".to_string(),
            title: "创建备忘录".to_string(),
            app_name: String::new(),
            url: String::new(),
            path: String::new(),
            text,
            command: String::new(),
        }
    }

    fn create_reminder(title: String) -> Self {
        Self {
            action_type: "create_reminder".to_string(),
            title,
            app_name: String::new(),
            url: String::new(),
            path: String::new(),
            text: String::new(),
            command: String::new(),
        }
    }

    fn shell(command: &str) -> Self {
        Self {
            action_type: "shell".to_string(),
            title: "运行 Shell 命令".to_string(),
            app_name: String::new(),
            url: String::new(),
            path: String::new(),
            text: String::new(),
            command: command.trim().to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_open_downloads() {
        let action = plan_local_action("打开下载目录").expect("action");
        assert_eq!(action.action_type, "open_path");
        assert!(action.path.ends_with("Downloads"));
    }

    #[test]
    fn plans_shell_as_high_risk_action() {
        let action = plan_local_action("运行命令 rm -rf /tmp/x").expect("action");
        assert_eq!(action.action_type, "shell");
        assert_eq!(action.command, "rm -rf /tmp/x");
    }

    #[test]
    fn plans_browser_open_from_natural_sentence() {
        let action = plan_local_action("阿福我给你权限了你把我的浏览器给我打开").expect("action");
        assert_eq!(action.action_type, "open_app");
        assert_eq!(action.app_name, "Google Chrome");
    }

    #[test]
    fn plans_desktop_folder_creation_as_shell_action() {
        let action = plan_local_action("你使用命令行在我桌面创建文件夹").expect("action");
        assert_eq!(action.action_type, "shell");
        assert_eq!(action.command, "mkdir -p ~/Desktop/'新文件夹'");
    }

    #[test]
    fn plans_named_folder_creation_on_desktop_by_default() {
        let action = plan_local_action("阿福创建文件夹名字叫做测试").expect("action");
        assert_eq!(action.action_type, "shell");
        assert_eq!(action.command, "mkdir -p ~/Desktop/'测试'");
    }

    #[test]
    fn extracts_folder_name_after_long_marker_before_short_marker() {
        assert_eq!(
            extract_folder_name("创建文件夹名字叫做测试", &["名字叫做", "叫"]),
            Some("测试".to_string())
        );
        assert_eq!(
            extract_folder_name("创建文件夹叫做测试。", &["叫做", "叫"]),
            Some("测试".to_string())
        );
    }
}

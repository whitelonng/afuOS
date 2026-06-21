use crate::config::load_app_config;
use crate::logs::{write_execution_log, ExecutionLog};
use crate::permissions::{
    decide, find_permission_rule, remembered_decision, save_permission_rule, PermissionDecision,
    PermissionStatus,
};
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

    if let Some(action) = plan_browser_search(trimmed) {
        return Some(action);
    }

    if trimmed.contains("浏览器") && trimmed.contains("打开") {
        return Some(LocalActionRequest::open_app(resolve_app_name("浏览器")));
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("browser")
        && (lowered.contains("open") || lowered.contains("launch"))
        && !lowered.contains("search")
    {
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
    )
    .or_else(|| {
        strip_ascii_prefix_case_insensitive(
            trimmed,
            &[
                "run command ",
                "execute command ",
                "run shell ",
                "execute shell ",
            ],
        )
    }) {
        return Some(LocalActionRequest::shell(command));
    }

    if let Some(copied) = strip_any_prefix(trimmed, &["复制", "拷贝"])
        .or_else(|| strip_ascii_prefix_case_insensitive(trimmed, &["copy "]))
    {
        let text = copied
            .trim_end_matches("到剪贴板")
            .trim_end_matches("到剪切板")
            .trim_end_matches(" to clipboard")
            .trim()
            .to_string();
        if !text.is_empty() {
            return Some(LocalActionRequest::copy_text(text));
        }
    }

    if trimmed.contains("创建备忘录")
        || trimmed.contains("添加备忘录")
        || trimmed.contains("新建备忘录")
        || trimmed.to_ascii_lowercase().contains("create note")
        || trimmed.to_ascii_lowercase().contains("add note")
        || trimmed.to_ascii_lowercase().contains("new note")
    {
        let content = extract_after_markers(trimmed, &["内容是", "内容为", "：", ":"])
            .or_else(|| {
                extract_after_markers_case_insensitive(
                    trimmed,
                    &["content is", "content:", "body:", "note:"],
                )
            })
            .unwrap_or_else(|| {
                trimmed
                    .replace("创建备忘录", "")
                    .replace("添加备忘录", "")
                    .replace("新建备忘录", "")
                    .replace("create note", "")
                    .replace("Create note", "")
                    .replace("add note", "")
                    .replace("Add note", "")
                    .replace("new note", "")
                    .replace("New note", "")
            });
        let content = content.trim().to_string();
        if !content.is_empty() {
            return Some(LocalActionRequest::create_note(content));
        }
    }

    if trimmed.contains("提醒我")
        || trimmed.contains("创建提醒")
        || trimmed.contains("添加提醒")
        || trimmed.to_ascii_lowercase().contains("remind me")
        || trimmed.to_ascii_lowercase().contains("create reminder")
        || trimmed.to_ascii_lowercase().contains("add reminder")
    {
        let title = trimmed
            .replace("提醒我", "")
            .replace("创建提醒", "")
            .replace("添加提醒", "")
            .replace("remind me to", "")
            .replace("Remind me to", "")
            .replace("remind me", "")
            .replace("Remind me", "")
            .replace("create reminder", "")
            .replace("Create reminder", "")
            .replace("add reminder", "")
            .replace("Add reminder", "")
            .trim()
            .to_string();
        if !title.is_empty() {
            return Some(LocalActionRequest::create_reminder(title));
        }
    }

    if let Some(target) = strip_any_prefix(trimmed, &["打开"])
        .or_else(|| strip_ascii_prefix_case_insensitive(trimmed, &["open "]))
    {
        let target = target.trim();
        if target.is_empty() {
            return None;
        }

        if let Some(path) = common_folder_path(target) {
            return Some(LocalActionRequest::open_path(path));
        }

        if looks_like_local_path(target) {
            return Some(LocalActionRequest::open_path(expand_home(target)));
        }

        if looks_like_url(target) {
            return Some(LocalActionRequest::open_url(normalize_url(target)));
        }

        return Some(LocalActionRequest::open_app(resolve_app_name(target)));
    }

    None
}

pub fn execute_local_action(
    app: &AppHandle,
    action: LocalActionRequest,
    confirmed: bool,
    remember: bool,
) -> Result<LocalActionResponse, String> {
    let config = load_app_config(app)?;
    let target_path = if action.action_type == "open_path" {
        Some(action.path.as_str())
    } else {
        None
    };
    let permission_target = permission_target_for_action(&action);
    let remembered = find_permission_rule(app, &action.action_type, &permission_target)?
        .and_then(|rule| remembered_decision(&rule.decision));
    let base_decision = decide(
        &config.permissions,
        &action.action_type,
        target_path,
        if action.action_type == "shell" {
            Some(action.command.as_str())
        } else {
            None
        },
    );
    let decision = merge_permission_decision(base_decision, remembered);

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

    if confirmed && remember && decision.risk_level == "low" {
        let _ = save_permission_rule(app, &action.action_type, &permission_target, "allow");
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
        "browser_search" => open_browser_url(&action.url),
        "shell" => run_shell(&action.command),
        _ => Err("未知动作类型".to_string()),
    }
}

fn open_browser_url(url: &str) -> Result<String, String> {
    run_status(
        Command::new("open").args(["-a", "Google Chrome", url]),
        &format!("已在浏览器打开 {url}"),
    )
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
        "browser_search" => action.url.clone(),
        "shell" => action.command.clone(),
        _ => String::new(),
    }
}

fn permission_target_for_action(action: &LocalActionRequest) -> String {
    match action.action_type.as_str() {
        "open_app" => action.app_name.trim().to_string(),
        "open_url" => action.url.trim().to_string(),
        "open_path" => action.path.trim().to_string(),
        "copy_text" => action.text.trim().to_string(),
        "create_note" => action.text.trim().to_string(),
        "create_reminder" => action.title.trim().to_string(),
        "browser_search" => action.url.trim().to_string(),
        "shell" => action.command.trim().to_string(),
        _ => target_for_action(action),
    }
}

fn merge_permission_decision(
    base_decision: PermissionDecision,
    remembered_decision: Option<PermissionDecision>,
) -> PermissionDecision {
    if base_decision.status == PermissionStatus::Deny || base_decision.risk_level != "low" {
        base_decision
    } else {
        remembered_decision.unwrap_or(base_decision)
    }
}

fn strip_any_prefix<'a>(text: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    prefixes.iter().find_map(|prefix| text.strip_prefix(prefix))
}

fn strip_ascii_prefix_case_insensitive<'a>(text: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    let lowered = text.to_ascii_lowercase();
    prefixes.iter().find_map(|prefix| {
        let lowered_prefix = prefix.to_ascii_lowercase();
        if lowered.starts_with(&lowered_prefix) {
            Some(text[prefix.len()..].trim_start())
        } else {
            None
        }
    })
}

fn extract_after_markers(text: &str, markers: &[&str]) -> Option<String> {
    markers.iter().find_map(|marker| {
        text.split_once(marker)
            .map(|(_, value)| value.trim().to_string())
    })
}

fn extract_after_markers_case_insensitive(text: &str, markers: &[&str]) -> Option<String> {
    let lowered = text.to_ascii_lowercase();
    markers.iter().find_map(|marker| {
        let lowered_marker = marker.to_ascii_lowercase();
        lowered
            .find(&lowered_marker)
            .map(|index| text[index + marker.len()..].trim().to_string())
    })
}

fn looks_like_url(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return true;
    }
    if looks_like_local_path(trimmed) || trimmed.chars().any(char::is_whitespace) {
        return false;
    }

    let host = trimmed.split('/').next().unwrap_or_default();
    if host.starts_with("www.") {
        return true;
    }
    let lowered_host = host.to_ascii_lowercase();
    let Some(tld) = lowered_host.rsplit('.').next() else {
        return false;
    };
    matches!(
        tld,
        "ai" | "app"
            | "cn"
            | "co"
            | "com"
            | "dev"
            | "edu"
            | "gov"
            | "io"
            | "me"
            | "net"
            | "org"
            | "site"
            | "top"
            | "xyz"
    )
}

fn looks_like_local_path(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with('/')
        || trimmed.starts_with("~/")
        || trimmed.starts_with("./")
        || trimmed.starts_with("../")
}

fn normalize_url(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("https://{value}")
    }
}

fn common_folder_path(target: &str) -> Option<String> {
    let normalized = target
        .trim()
        .trim_start_matches("我的")
        .trim_start_matches("my ")
        .trim_start_matches("My ")
        .trim_start_matches("the ")
        .trim_start_matches("The ")
        .trim_end_matches("目录")
        .trim_end_matches("文件夹")
        .trim()
        .to_lowercase();

    if normalized.contains("应用程序")
        || normalized == "applications"
        || normalized == "application"
        || normalized == "apps"
    {
        return Some("/Applications".to_string());
    }

    let home = dirs::home_dir()?;
    if normalized.contains("下载") || normalized == "downloads" || normalized == "download" {
        return Some(home.join("Downloads").to_string_lossy().to_string());
    }
    if normalized.contains("桌面") || normalized == "desktop" {
        return Some(home.join("Desktop").to_string_lossy().to_string());
    }
    if normalized.contains("文稿")
        || normalized.contains("文档")
        || normalized == "documents"
        || normalized == "docs"
    {
        return Some(home.join("Documents").to_string_lossy().to_string());
    }
    if normalized == "home" || normalized == "主目录" || normalized == "个人文件夹" {
        return Some(home.to_string_lossy().to_string());
    }

    None
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
    let trimmed = target
        .trim()
        .trim_start_matches("my ")
        .trim_start_matches("My ")
        .trim_start_matches("the ")
        .trim_start_matches("The ")
        .trim();
    match trimmed.to_lowercase().as_str() {
        "备忘录" | "notes" => "Notes".to_string(),
        "微信" | "wechat" => "WeChat".to_string(),
        "提醒事项" | "reminders" => "Reminders".to_string(),
        "浏览器" | "browser" | "chrome" | "google chrome" => "Google Chrome".to_string(),
        "safari" => "Safari".to_string(),
        "finder" | "访达" => "Finder".to_string(),
        "terminal" | "终端" => "Terminal".to_string(),
        other if other.is_empty() => String::new(),
        _ => trimmed.to_string(),
    }
}

fn plan_browser_search(text: &str) -> Option<LocalActionRequest> {
    let query = extract_browser_search_query(text)?;
    let engine = if text.to_lowercase().contains("google") || text.contains("谷歌") {
        BrowserSearchEngine::Google
    } else if text.contains("百度") || text.to_lowercase().contains("baidu") {
        BrowserSearchEngine::Baidu
    } else {
        BrowserSearchEngine::Google
    };
    Some(LocalActionRequest::browser_search(query, engine))
}

fn extract_browser_search_query(text: &str) -> Option<String> {
    let trimmed = text.trim_start_matches("阿福").trim();
    let direct_markers = [
        "用浏览器搜索",
        "在浏览器搜索",
        "浏览器搜索",
        "用 Google 搜索",
        "用Google搜索",
        "Google 搜索",
        "Google搜索",
        "google 搜索",
        "google搜索",
        "用谷歌搜索",
        "谷歌搜索",
        "用百度搜索",
        "百度搜索",
        "搜索一下",
        "搜索",
    ];

    direct_markers
        .iter()
        .find_map(|marker| {
            trimmed
                .split_once(marker)
                .map(|(_, value)| value.trim().to_string())
        })
        .or_else(|| {
            extract_after_markers_case_insensitive(
                trimmed,
                &[
                    "search google for",
                    "google search for",
                    "search baidu for",
                    "baidu search for",
                    "search in browser for",
                    "search in browser",
                    "search the browser for",
                    "search browser for",
                    "search for",
                    "search",
                    "google",
                    "baidu",
                ],
            )
        })
        .or_else(|| {
            trimmed
                .strip_prefix("搜")
                .map(|value| value.trim().to_string())
        })
        .map(|query| clean_browser_search_query(&query))
        .filter(|query| !query.is_empty())
}

fn clean_browser_search_query(query: &str) -> String {
    query
        .trim()
        .trim_start_matches("一下")
        .trim_start_matches("关于")
        .trim_start_matches("for")
        .trim_matches(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '，' | ',' | '。' | '.' | '"' | '\'' | '“' | '”' | '：' | ':' | '?'
                )
        })
        .trim()
        .to_string()
}

fn browser_search_url(query: &str, engine: BrowserSearchEngine) -> String {
    let encoded = percent_encode_query(query);
    match engine {
        BrowserSearchEngine::Google => format!("https://www.google.com/search?q={encoded}"),
        BrowserSearchEngine::Baidu => format!("https://www.baidu.com/s?wd={encoded}"),
    }
}

fn percent_encode_query(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![*byte as char]
            }
            b' ' => vec!['+'],
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
enum BrowserSearchEngine {
    Google,
    Baidu,
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

    fn browser_search(query: String, engine: BrowserSearchEngine) -> Self {
        let url = browser_search_url(&query, engine);
        Self {
            action_type: "browser_search".to_string(),
            title: format!("浏览器搜索 {query}"),
            app_name: "Google Chrome".to_string(),
            url,
            path: String::new(),
            text: query,
            command: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{PermissionDecision, PermissionStatus};

    #[test]
    fn plans_open_downloads() {
        let action = plan_local_action("打开下载目录").expect("action");
        assert_eq!(action.action_type, "open_path");
        assert!(action.path.ends_with("Downloads"));
    }

    #[test]
    fn plans_common_folders_from_chinese_names() {
        let desktop = plan_local_action("打开桌面").expect("desktop action");
        assert_eq!(desktop.action_type, "open_path");
        assert!(desktop.path.ends_with("Desktop"));

        let documents = plan_local_action("打开文稿").expect("documents action");
        assert_eq!(documents.action_type, "open_path");
        assert!(documents.path.ends_with("Documents"));

        let applications = plan_local_action("打开应用程序").expect("applications action");
        assert_eq!(applications.action_type, "open_path");
        assert_eq!(applications.path, "/Applications");
    }

    #[test]
    fn plans_common_targets_from_english_names() {
        let browser = plan_local_action("Open my browser").expect("browser action");
        assert_eq!(browser.action_type, "open_app");
        assert_eq!(browser.app_name, "Google Chrome");

        let downloads = plan_local_action("Open my downloads").expect("downloads action");
        assert_eq!(downloads.action_type, "open_path");
        assert!(downloads.path.ends_with("Downloads"));
    }

    #[test]
    fn plans_absolute_file_with_extension_as_local_path() {
        let action = plan_local_action("打开 /tmp/report.txt").expect("action");
        assert_eq!(action.action_type, "open_path");
        assert_eq!(action.path, "/tmp/report.txt");
    }

    #[test]
    fn plans_bare_domain_as_url() {
        let action = plan_local_action("open example.com").expect("action");
        assert_eq!(action.action_type, "open_url");
        assert_eq!(action.url, "https://example.com");
    }

    #[test]
    fn plans_shell_as_high_risk_action() {
        let action = plan_local_action("运行命令 rm -rf /tmp/x").expect("action");
        assert_eq!(action.action_type, "shell");
        assert_eq!(action.command, "rm -rf /tmp/x");
    }

    #[test]
    fn blocked_decision_overrides_remembered_allow() {
        let base_decision = PermissionDecision {
            status: PermissionStatus::Deny,
            risk_level: "blocked".to_string(),
            reason: "目标路径在 blockedPaths 中".to_string(),
        };
        let remembered = Some(PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "remembered".to_string(),
            reason: "已按你的授权记录长期允许".to_string(),
        });

        let merged = merge_permission_decision(base_decision.clone(), remembered);
        assert_eq!(merged.status, PermissionStatus::Deny);
        assert_eq!(merged.risk_level, base_decision.risk_level);
    }

    #[test]
    fn high_risk_decision_overrides_remembered_allow() {
        let base_decision = PermissionDecision {
            status: PermissionStatus::RequireConfirmation,
            risk_level: "high".to_string(),
            reason: "Shell 命令可能修改系统、删除数据或访问敏感位置，必须确认".to_string(),
        };
        let remembered = Some(PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "remembered".to_string(),
            reason: "已按你的授权记录长期允许".to_string(),
        });

        let merged = merge_permission_decision(base_decision.clone(), remembered);
        assert_eq!(merged.status, PermissionStatus::RequireConfirmation);
        assert_eq!(merged.risk_level, base_decision.risk_level);
    }

    #[test]
    fn low_risk_decision_can_use_remembered_allow() {
        let base_decision = PermissionDecision {
            status: PermissionStatus::RequireConfirmation,
            risk_level: "low".to_string(),
            reason: "低风险动作需要确认".to_string(),
        };
        let remembered = Some(PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "remembered".to_string(),
            reason: "已按你的授权记录长期允许".to_string(),
        });

        let merged = merge_permission_decision(base_decision, remembered);
        assert_eq!(merged.status, PermissionStatus::Allow);
        assert_eq!(merged.risk_level, "remembered");
    }

    #[test]
    fn plans_browser_open_from_natural_sentence() {
        let action = plan_local_action("阿福我给你权限了你把我的浏览器给我打开").expect("action");
        assert_eq!(action.action_type, "open_app");
        assert_eq!(action.app_name, "Google Chrome");
    }

    #[test]
    fn preserves_original_app_name_for_unknown_apps() {
        let action = plan_local_action("打开 Notion").expect("action");
        assert_eq!(action.action_type, "open_app");
        assert_eq!(action.app_name, "Notion");
    }

    #[test]
    fn plans_basic_english_local_actions() {
        let open_action = plan_local_action("Open Notion").expect("open action");
        assert_eq!(open_action.action_type, "open_app");
        assert_eq!(open_action.app_name, "Notion");

        let copy_action =
            plan_local_action("Copy release checklist to clipboard").expect("copy action");
        assert_eq!(copy_action.action_type, "copy_text");
        assert_eq!(copy_action.text, "release checklist");

        let shell_action = plan_local_action("Run command date").expect("shell action");
        assert_eq!(shell_action.action_type, "shell");
        assert_eq!(shell_action.command, "date");

        let reminder_action =
            plan_local_action("Remind me to review the PR").expect("reminder action");
        assert_eq!(reminder_action.action_type, "create_reminder");
        assert_eq!(reminder_action.title, "review the PR");
    }

    #[test]
    fn plans_basic_english_browser_search_actions() {
        let google_action =
            plan_local_action("Search Google for afuos mvp").expect("google action");
        assert_eq!(google_action.action_type, "browser_search");
        assert_eq!(google_action.text, "afuos mvp");
        assert_eq!(
            google_action.url,
            "https://www.google.com/search?q=afuos+mvp"
        );

        let browser_action =
            plan_local_action("Search in browser for release checklist").expect("browser action");
        assert_eq!(browser_action.action_type, "browser_search");
        assert_eq!(browser_action.text, "release checklist");
        assert_eq!(
            browser_action.url,
            "https://www.google.com/search?q=release+checklist"
        );
    }

    #[test]
    fn plans_google_browser_search() {
        let action = plan_local_action("阿福在浏览器搜索 afuos mvp").expect("action");
        assert_eq!(action.action_type, "browser_search");
        assert_eq!(action.text, "afuos mvp");
        assert_eq!(action.url, "https://www.google.com/search?q=afuos+mvp");
    }

    #[test]
    fn plans_baidu_browser_search() {
        let action = plan_local_action("百度搜索 阿福 助手").expect("action");
        assert_eq!(action.action_type, "browser_search");
        assert_eq!(
            action.url,
            "https://www.baidu.com/s?wd=%E9%98%BF%E7%A6%8F+%E5%8A%A9%E6%89%8B"
        );
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

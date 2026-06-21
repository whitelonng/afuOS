use crate::config::PermissionsConfig;
use crate::db::open_database;
use crate::logs::now_ms;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
    Allow,
    RequireConfirmation,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub status: PermissionStatus,
    pub risk_level: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub id: String,
    pub action_type: String,
    pub target: String,
    pub decision: String,
    pub created_at: i64,
}

pub fn decide(
    permissions: &PermissionsConfig,
    action_type: &str,
    target_path: Option<&str>,
    shell_command: Option<&str>,
) -> PermissionDecision {
    if let Some(path) = target_path {
        if is_blocked_path(path, &permissions.blocked_paths) {
            return PermissionDecision {
                status: PermissionStatus::Deny,
                risk_level: "blocked".to_string(),
                reason: "目标路径在 blockedPaths 中".to_string(),
            };
        }
    }

    if action_type == "shell" {
        if let Some(command) = shell_command {
            if let Some(blocked_path) = blocked_shell_target(command, &permissions.blocked_paths) {
                return PermissionDecision {
                    status: PermissionStatus::Deny,
                    risk_level: "blocked".to_string(),
                    reason: format!("Shell 命令访问了 blockedPaths 中的路径：{blocked_path}"),
                };
            }
        }
    }

    match action_type {
        "open_app" | "copy_text" | "create_note" | "create_reminder" => PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "low".to_string(),
            reason: "低风险白名单动作".to_string(),
        },
        "open_url" => decide_browser_automation(permissions, "low"),
        "open_path" => PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "low".to_string(),
            reason: "只读打开文件或文件夹".to_string(),
        },
        "browser_search" => decide_browser_automation(permissions, "low"),
        "shell" => decide_shell_command(permissions, shell_command.unwrap_or_default()),
        _ => PermissionDecision {
            status: PermissionStatus::Deny,
            risk_level: "unknown".to_string(),
            reason: "未知动作类型".to_string(),
        },
    }
}

pub fn remembered_decision(decision: &str) -> Option<PermissionDecision> {
    match decision.trim().to_ascii_lowercase().as_str() {
        "allow" => Some(PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "remembered".to_string(),
            reason: "已按你的授权记录长期允许".to_string(),
        }),
        "deny" => Some(PermissionDecision {
            status: PermissionStatus::Deny,
            risk_level: "remembered".to_string(),
            reason: "已按你的规则长期拒绝".to_string(),
        }),
        _ => None,
    }
}

pub fn list_permission_rules(app: &AppHandle) -> Result<Vec<PermissionRule>, String> {
    let connection = open_database(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, action_type, target, decision, created_at
             FROM permission_rules
             ORDER BY created_at DESC",
        )
        .map_err(|error| format!("Failed to prepare permission rules query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(PermissionRule {
                id: row.get(0)?,
                action_type: row.get(1)?,
                target: row.get(2)?,
                decision: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Failed to read permission rules: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to collect permission rules: {error}"))
}

pub fn find_permission_rule(
    app: &AppHandle,
    action_type: &str,
    target: &str,
) -> Result<Option<PermissionRule>, String> {
    let connection = open_database(app)?;
    let mut statement = connection
        .prepare(
            "SELECT id, action_type, target, decision, created_at
             FROM permission_rules
             WHERE action_type = ?1 AND target = ?2
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .map_err(|error| format!("Failed to prepare permission rule query: {error}"))?;

    let mut rows = statement
        .query(params![action_type, target])
        .map_err(|error| format!("Failed to query permission rule: {error}"))?;

    let Some(row) = rows
        .next()
        .map_err(|error| format!("Failed to read permission rule row: {error}"))?
    else {
        return Ok(None);
    };

    Ok(Some(PermissionRule {
        id: row
            .get(0)
            .map_err(|error| format!("Failed to read permission rule id: {error}"))?,
        action_type: row
            .get(1)
            .map_err(|error| format!("Failed to read permission rule action type: {error}"))?,
        target: row
            .get(2)
            .map_err(|error| format!("Failed to read permission rule target: {error}"))?,
        decision: row
            .get(3)
            .map_err(|error| format!("Failed to read permission rule decision: {error}"))?,
        created_at: row
            .get(4)
            .map_err(|error| format!("Failed to read permission rule created_at: {error}"))?,
    }))
}

pub fn save_permission_rule(
    app: &AppHandle,
    action_type: &str,
    target: &str,
    decision: &str,
) -> Result<PermissionRule, String> {
    let mut connection = open_database(app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start permission rule save transaction: {error}"))?;

    transaction
        .execute(
            "DELETE FROM permission_rules WHERE action_type = ?1 AND target = ?2",
            params![action_type, target],
        )
        .map_err(|error| format!("Failed to replace permission rule: {error}"))?;

    let rule = PermissionRule {
        id: Uuid::new_v4().to_string(),
        action_type: action_type.to_string(),
        target: target.to_string(),
        decision: decision.to_string(),
        created_at: now_ms(),
    };

    transaction
        .execute(
            "INSERT INTO permission_rules (id, action_type, target, decision, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                rule.id,
                rule.action_type,
                rule.target,
                rule.decision,
                rule.created_at
            ],
        )
        .map_err(|error| format!("Failed to save permission rule: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit permission rule save: {error}"))?;

    Ok(rule)
}

pub fn delete_permission_rule(app: &AppHandle, rule_id: String) -> Result<(), String> {
    let connection = open_database(app)?;
    connection
        .execute(
            "DELETE FROM permission_rules WHERE id = ?1",
            params![rule_id],
        )
        .map_err(|error| format!("Failed to delete permission rule: {error}"))?;
    Ok(())
}

pub fn clear_permission_rules(app: &AppHandle) -> Result<(), String> {
    let connection = open_database(app)?;
    connection
        .execute("DELETE FROM permission_rules", [])
        .map_err(|error| format!("Failed to clear permission rules: {error}"))?;
    Ok(())
}

fn decide_browser_automation(
    permissions: &PermissionsConfig,
    risk: &'static str,
) -> PermissionDecision {
    if permissions.allow_browser_automation && risk == "low" {
        return PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "low".to_string(),
            reason: "已在设置中授权低风险浏览器动作".to_string(),
        };
    }

    PermissionDecision {
        status: PermissionStatus::RequireConfirmation,
        risk_level: risk.to_string(),
        reason: if risk == "low" {
            "低风险浏览器动作需要先在设置中开启自动授权".to_string()
        } else {
            "浏览器动作可能提交表单、访问账号或触发外部副作用，必须确认".to_string()
        },
    }
}

fn decide_shell_command(permissions: &PermissionsConfig, command: &str) -> PermissionDecision {
    let risk = shell_command_risk(command);
    if permissions.allow_shell && risk == "low" {
        return PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "low".to_string(),
            reason: "已在设置中授权低风险 Shell 命令".to_string(),
        };
    }

    PermissionDecision {
        status: PermissionStatus::RequireConfirmation,
        risk_level: risk.to_string(),
        reason: if risk == "low" {
            "低风险 Shell 命令需要先在设置中开启自动授权".to_string()
        } else {
            "Shell 命令可能修改系统、删除数据或访问敏感位置，必须确认".to_string()
        },
    }
}

fn shell_command_risk(command: &str) -> &'static str {
    let normalized = command.trim().to_lowercase();
    if normalized.is_empty() {
        return "unknown";
    }

    let dangerous_markers = [
        "sudo",
        " rm ",
        "rm -",
        "rm\t",
        "chmod",
        "chown",
        "dd ",
        "mkfs",
        "diskutil",
        "launchctl",
        "kill",
        "pkill",
        "security ",
        "defaults write",
        "curl ",
        "wget ",
        "|",
        "| sh",
        "|sh",
        "| bash",
        "|bash",
        "<",
        ">",
        ">>",
        "2>",
        ";",
        "&&",
        "||",
        "`",
        "$(",
    ];
    let padded = format!(" {normalized} ");
    if dangerous_markers
        .iter()
        .any(|marker| padded.contains(marker))
    {
        return "high";
    }

    let tokens = shell_tokens(command);
    let executable = tokens
        .first()
        .map(|token| token.to_lowercase())
        .unwrap_or_default();
    let low_risk_commands = [
        "date", "pwd", "whoami", "id", "uname", "sw_vers", "ls", "echo", "cat", "head", "tail",
        "wc", "find", "mdfind", "open", "mkdir",
    ];
    if !low_risk_commands.contains(&executable.as_str()) {
        return "high";
    }

    if executable == "mkdir" && !mkdir_targets_are_desktop_only(&tokens[1..]) {
        return "high";
    }

    "low"
}

fn blocked_shell_target(command: &str, blocked_paths: &[String]) -> Option<String> {
    let tokens = shell_tokens(command);
    let executable = tokens.first()?.to_lowercase();
    let arguments = &tokens[1..];
    let recursive_search = matches!(executable.as_str(), "find" | "mdfind");

    let candidate_paths = match executable.as_str() {
        "open" => collect_open_paths(arguments),
        "cat" | "head" | "tail" | "wc" | "ls" => arguments
            .iter()
            .filter(|argument| !argument.starts_with('-'))
            .cloned()
            .collect(),
        "mkdir" => collect_mkdir_paths(arguments),
        "find" => collect_find_paths(arguments),
        "mdfind" => collect_mdfind_paths(arguments),
        _ => Vec::new(),
    };

    if executable == "mdfind" && candidate_paths.is_empty() {
        return blocked_paths
            .iter()
            .find(|blocked_path| !blocked_path.trim().is_empty())
            .cloned();
    }

    candidate_paths.into_iter().find(|path| {
        !looks_like_url(path) && path_conflicts_with_blocked(path, blocked_paths, recursive_search)
    })
}

fn collect_open_paths(arguments: &[String]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut skip_next = false;

    for argument in arguments {
        if skip_next {
            skip_next = false;
            continue;
        }

        if argument == "-a" || argument == "-b" {
            skip_next = true;
            continue;
        }

        if argument.starts_with('-') {
            continue;
        }

        paths.push(argument.clone());
    }

    paths
}

fn collect_find_paths(arguments: &[String]) -> Vec<String> {
    arguments
        .iter()
        .filter(|argument| looks_like_shell_path(argument))
        .cloned()
        .collect()
}

fn collect_mdfind_paths(arguments: &[String]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == "-onlyin" {
            if let Some(path) = arguments.get(index + 1) {
                paths.push(path.clone());
            }
            index += 2;
            continue;
        }
        index += 1;
    }
    paths
}

fn collect_mkdir_paths(arguments: &[String]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut index = 0;
    let mut options_finished = false;

    while index < arguments.len() {
        let argument = &arguments[index];
        if !options_finished && argument == "--" {
            options_finished = true;
            index += 1;
            continue;
        }
        if !options_finished && argument == "-m" {
            index += 2;
            continue;
        }
        if !options_finished && argument.starts_with('-') {
            index += 1;
            continue;
        }
        paths.push(argument.clone());
        index += 1;
    }

    paths
}

fn mkdir_targets_are_desktop_only(arguments: &[String]) -> bool {
    let paths = collect_mkdir_paths(arguments);
    !paths.is_empty()
        && paths
            .iter()
            .all(|path| path_is_home_desktop_or_child(path.as_str()))
}

fn path_is_home_desktop_or_child(path: &str) -> bool {
    let trimmed = path.trim();
    if trimmed == "~/Desktop" || trimmed.starts_with("~/Desktop/") {
        return true;
    }

    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let desktop = home.join("Desktop").components().collect::<PathBuf>();
    let target = normalize_path(trimmed);
    target == desktop || target.starts_with(&desktop)
}

fn shell_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' && active_quote == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn looks_like_url(value: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    normalized.starts_with("http://") || normalized.starts_with("https://")
}

fn looks_like_shell_path(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed == "."
        || trimmed == ".."
        || trimmed.starts_with('/')
        || trimmed.starts_with("~/")
        || trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.contains('/')
}

fn is_blocked_path(path: &str, blocked_paths: &[String]) -> bool {
    path_conflicts_with_blocked(path, blocked_paths, false)
}

fn path_conflicts_with_blocked(
    path: &str,
    blocked_paths: &[String],
    include_blocked_children: bool,
) -> bool {
    let normalized_target = normalize_path(path);
    blocked_paths
        .iter()
        .filter(|blocked| !blocked.trim().is_empty())
        .map(|blocked| normalize_path(blocked))
        .any(|blocked| {
            normalized_target.starts_with(&blocked)
                || (include_blocked_children
                    && normalized_target.is_absolute()
                    && blocked.starts_with(&normalized_target))
        })
}

fn normalize_path(path: &str) -> PathBuf {
    let normalized_input = local_file_url_path(path).unwrap_or_else(|| path.trim().to_string());
    let expanded = if let Some(stripped) = normalized_input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(stripped).to_string_lossy().to_string()
        } else {
            normalized_input
        }
    } else {
        normalized_input
    };

    Path::new(&expanded).components().collect::<PathBuf>()
}

fn local_file_url_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if !trimmed.to_ascii_lowercase().starts_with("file://") {
        return None;
    }

    let without_scheme = &trimmed[7..];
    let local_path = if without_scheme.starts_with('/') {
        without_scheme.to_string()
    } else if let Some(stripped) = without_scheme.strip_prefix("localhost/") {
        format!("/{stripped}")
    } else {
        return None;
    };

    Some(percent_decode_path(&local_path))
}

fn percent_decode_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_paths_deny_nested_target() {
        let permissions = PermissionsConfig {
            allow_shell: false,
            allow_browser_automation: false,
            blocked_paths: vec!["/tmp/private".to_string()],
            trusted_skills: vec![],
        };

        let decision = decide(
            &permissions,
            "open_path",
            Some("/tmp/private/file.txt"),
            None,
        );
        assert_eq!(decision.status, PermissionStatus::Deny);
    }

    #[test]
    fn low_risk_shell_can_be_auto_allowed_when_authorized() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(&permissions, "shell", None, Some("date"));
        assert_eq!(decision.status, PermissionStatus::Allow);
        assert_eq!(decision.risk_level, "low");
    }

    #[test]
    fn mkdir_desktop_target_can_be_auto_allowed_when_authorized() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("mkdir -p ~/Desktop/Project"),
        );
        assert_eq!(decision.status, PermissionStatus::Allow);
        assert_eq!(decision.risk_level, "low");
    }

    #[test]
    fn mkdir_desktop_prefix_target_still_requires_confirmation() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(&permissions, "shell", None, Some("mkdir -p ~/Desktop2"));
        assert_eq!(decision.status, PermissionStatus::RequireConfirmation);
        assert_eq!(decision.risk_level, "high");
    }

    #[test]
    fn mkdir_non_home_desktop_target_still_requires_confirmation() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("mkdir -p /tmp/Desktop/test"),
        );
        assert_eq!(decision.status, PermissionStatus::RequireConfirmation);
        assert_eq!(decision.risk_level, "high");
    }

    #[test]
    fn dangerous_shell_still_requires_confirmation_when_authorized() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(&permissions, "shell", None, Some("rm -rf /tmp/x"));
        assert_eq!(decision.status, PermissionStatus::RequireConfirmation);
        assert_eq!(decision.risk_level, "high");
    }

    #[test]
    fn shell_pipeline_still_requires_confirmation_when_authorized() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(&permissions, "shell", None, Some("echo date | zsh"));
        assert_eq!(decision.status, PermissionStatus::RequireConfirmation);
        assert_eq!(decision.risk_level, "high");
    }

    #[test]
    fn shell_input_redirection_still_requires_confirmation_when_authorized() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("cat < ~/Secrets/plan.txt"),
        );
        assert_eq!(decision.status, PermissionStatus::RequireConfirmation);
        assert_eq!(decision.risk_level, "high");
    }

    #[test]
    fn low_risk_browser_action_can_be_auto_allowed_when_authorized() {
        let permissions = PermissionsConfig {
            allow_shell: false,
            allow_browser_automation: true,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(&permissions, "browser_search", None, None);
        assert_eq!(decision.status, PermissionStatus::Allow);
        assert_eq!(decision.risk_level, "low");
    }

    #[test]
    fn open_url_requires_browser_authorization_without_opt_in() {
        let permissions = PermissionsConfig {
            allow_shell: false,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(&permissions, "open_url", None, None);
        assert_eq!(decision.status, PermissionStatus::RequireConfirmation);
        assert_eq!(decision.risk_level, "low");
    }

    #[test]
    fn open_url_can_be_auto_allowed_when_browser_authorized() {
        let permissions = PermissionsConfig {
            allow_shell: false,
            allow_browser_automation: true,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(&permissions, "open_url", None, None);
        assert_eq!(decision.status, PermissionStatus::Allow);
        assert_eq!(decision.risk_level, "low");
    }

    #[test]
    fn browser_action_requires_confirmation_without_authorization() {
        let permissions = PermissionsConfig {
            allow_shell: false,
            allow_browser_automation: false,
            blocked_paths: vec![],
            trusted_skills: vec![],
        };

        let decision = decide(&permissions, "browser_search", None, None);
        assert_eq!(decision.status, PermissionStatus::RequireConfirmation);
        assert_eq!(decision.risk_level, "low");
    }

    #[test]
    fn blocked_paths_deny_shell_open_target() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec!["/tmp/private".to_string()],
            trusted_skills: vec![],
        };

        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("open /tmp/private/file.txt"),
        );
        assert_eq!(decision.status, PermissionStatus::Deny);
        assert_eq!(decision.risk_level, "blocked");
    }

    #[test]
    fn blocked_paths_deny_shell_open_file_url_target() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec!["/tmp/private folder".to_string()],
            trusted_skills: vec![],
        };

        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("open file:///tmp/private%20folder/file.txt"),
        );
        assert_eq!(decision.status, PermissionStatus::Deny);
        assert_eq!(decision.risk_level, "blocked");
    }

    #[test]
    fn blocked_paths_deny_shell_with_quoted_path() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec!["~/Secrets".to_string()],
            trusted_skills: vec![],
        };

        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("cat '~/Secrets/plan.txt'"),
        );
        assert_eq!(decision.status, PermissionStatus::Deny);
        assert_eq!(decision.risk_level, "blocked");
    }

    #[test]
    fn blocked_paths_deny_mdfind_onlyin_target() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec!["~/Secrets".to_string()],
            trusted_skills: vec![],
        };
        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("mdfind -onlyin ~/Secrets confidential"),
        );
        assert_eq!(decision.status, PermissionStatus::Deny);
        assert_eq!(decision.risk_level, "blocked");
    }

    #[test]
    fn blocked_paths_deny_find_with_leading_options() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec!["~/Secrets".to_string()],
            trusted_skills: vec![],
        };
        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("find -L ~/Secrets -name plan.txt"),
        );
        assert_eq!(decision.status, PermissionStatus::Deny);
        assert_eq!(decision.risk_level, "blocked");
    }

    #[test]
    fn blocked_paths_deny_recursive_find_parent_target() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec!["/tmp/private".to_string()],
            trusted_skills: vec![],
        };
        let decision = decide(
            &permissions,
            "shell",
            None,
            Some("find /tmp -name plan.txt"),
        );
        assert_eq!(decision.status, PermissionStatus::Deny);
        assert_eq!(decision.risk_level, "blocked");
    }

    #[test]
    fn blocked_paths_deny_global_mdfind_when_blocked_paths_exist() {
        let permissions = PermissionsConfig {
            allow_shell: true,
            allow_browser_automation: false,
            blocked_paths: vec!["~/Secrets".to_string()],
            trusted_skills: vec![],
        };
        let decision = decide(&permissions, "shell", None, Some("mdfind confidential"));
        assert_eq!(decision.status, PermissionStatus::Deny);
        assert_eq!(decision.risk_level, "blocked");
    }

    #[test]
    fn remembered_allow_rule_maps_to_allow_decision() {
        let decision = remembered_decision("allow").expect("remembered allow");
        assert_eq!(decision.status, PermissionStatus::Allow);
        assert_eq!(decision.risk_level, "remembered");
    }
}

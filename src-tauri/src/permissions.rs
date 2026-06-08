use crate::config::PermissionsConfig;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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

pub fn decide(
    permissions: &PermissionsConfig,
    action_type: &str,
    target_path: Option<&str>,
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

    match action_type {
        "open_app" | "open_url" | "copy_text" | "create_note" | "create_reminder" => {
            PermissionDecision {
                status: PermissionStatus::Allow,
                risk_level: "low".to_string(),
                reason: "低风险白名单动作".to_string(),
            }
        }
        "open_path" => PermissionDecision {
            status: PermissionStatus::Allow,
            risk_level: "low".to_string(),
            reason: "只读打开文件或文件夹".to_string(),
        },
        "shell" => PermissionDecision {
            status: PermissionStatus::RequireConfirmation,
            risk_level: if permissions.allow_shell {
                "high"
            } else {
                "critical"
            }
            .to_string(),
            reason: "Shell 命令可能修改系统或项目文件，必须确认".to_string(),
        },
        _ => PermissionDecision {
            status: PermissionStatus::Deny,
            risk_level: "unknown".to_string(),
            reason: "未知动作类型".to_string(),
        },
    }
}

fn is_blocked_path(path: &str, blocked_paths: &[String]) -> bool {
    let normalized_target = normalize_path(path);
    blocked_paths
        .iter()
        .filter(|blocked| !blocked.trim().is_empty())
        .map(|blocked| normalize_path(blocked))
        .any(|blocked| normalized_target.starts_with(&blocked))
}

fn normalize_path(path: &str) -> PathBuf {
    let expanded = if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(stripped).to_string_lossy().to_string()
        } else {
            path.to_string()
        }
    } else {
        path.to_string()
    };

    Path::new(&expanded).components().collect::<PathBuf>()
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

        let decision = decide(&permissions, "open_path", Some("/tmp/private/file.txt"));
        assert_eq!(decision.status, PermissionStatus::Deny);
    }
}

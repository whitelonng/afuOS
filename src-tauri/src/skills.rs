use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_SKILL_BYTES: u64 = 24 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    pub path: String,
    pub name: String,
    pub content: String,
    pub error: String,
}

pub fn read_skill_documents(paths: Vec<String>) -> Vec<SkillDocument> {
    paths
        .into_iter()
        .filter_map(|path| {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(read_skill_document(trimmed))
            }
        })
        .collect()
}

fn read_skill_document(path: &str) -> SkillDocument {
    let requested_path = expand_home(path);
    let document_path = skill_document_path(&requested_path);

    match read_limited_text(&document_path) {
        Ok(content) => SkillDocument {
            path: document_path.to_string_lossy().to_string(),
            name: skill_name(&document_path, &content),
            content,
            error: String::new(),
        },
        Err(error) => SkillDocument {
            path: document_path.to_string_lossy().to_string(),
            name: fallback_skill_name(&document_path),
            content: String::new(),
            error,
        },
    }
}

fn skill_document_path(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.join("SKILL.md")
    } else {
        path.to_path_buf()
    }
}

fn read_limited_text(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("无法读取 Skill 文件：{error}"))?
        .take(MAX_SKILL_BYTES);
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|error| format!("Skill 文件不是有效 UTF-8 文本：{error}"))?;
    Ok(content)
}

fn skill_name(path: &Path, content: &str) -> String {
    content
        .lines()
        .find_map(|line| {
            line.strip_prefix("name:")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            content.lines().find_map(|line| {
                line.strip_prefix("# ")
                    .map(str::trim)
                    .map(ToOwned::to_owned)
            })
        })
        .unwrap_or_else(|| fallback_skill_name(path))
}

fn fallback_skill_name(path: &Path) -> String {
    path.parent()
        .and_then(Path::file_name)
        .or_else(|| path.file_stem())
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Skill".to_string())
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_skill_name_from_frontmatter_line() {
        let path = PathBuf::from("/tmp/example/SKILL.md");
        assert_eq!(
            skill_name(&path, "---\nname: demo-skill\n---"),
            "demo-skill"
        );
    }

    #[test]
    fn file_path_is_used_directly_when_not_a_directory() {
        let path = PathBuf::from("/tmp/example/SKILL.md");
        assert_eq!(skill_document_path(&path), path);
    }
}

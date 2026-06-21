use crate::mcp::McpToolSummary;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::{fs, path::PathBuf, process::Command};
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "afuos";
const TEXT_MODEL_API_KEY_ACCOUNT: &str = "text-model-api-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub general: GeneralConfig,
    pub models: ModelsConfig,
    pub voice: VoiceConfig,
    pub permissions: PermissionsConfig,
    #[serde(default)]
    pub registries: RegistryConfig,
    pub memory: MemoryConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralConfig {
    #[serde(default = "default_language")]
    pub language: String,
    pub shortcut: String,
    pub window_size: String,
    pub hotword_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsConfig {
    pub text: TextModelConfig,
    #[serde(default)]
    pub profiles: Vec<ModelProfile>,
    #[serde(default)]
    pub selected_text_profile_id: String,
    #[serde(default)]
    pub selected_vision_profile_id: String,
    #[serde(default)]
    pub selected_tts_profile_id: String,
    #[serde(default)]
    pub selected_stt_profile_id: String,
    pub vision: ModelSlotConfig,
    pub tts: TtsModelConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextModelConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSlotConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsModelConfig {
    pub provider: String,
    pub base_url: String,
    pub voice: String,
    pub api_key_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsRuntimeConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub voice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttRuntimeConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default = "default_model_profile_kind")]
    pub kind: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    #[serde(default)]
    pub voice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfig {
    pub push_to_talk_enabled: bool,
    pub tts_enabled: bool,
    #[serde(default = "default_stt_mode")]
    pub stt_mode: String,
    #[serde(default = "default_stt_model")]
    pub stt_model: String,
    #[serde(default = "default_push_to_talk_key")]
    pub push_to_talk_key: String,
    #[serde(default = "default_push_to_talk_mode")]
    pub push_to_talk_mode: String,
    #[serde(default)]
    pub auto_send_on_voice_end: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsConfig {
    pub allow_shell: bool,
    pub allow_browser_automation: bool,
    pub blocked_paths: Vec<String>,
    pub trusted_skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConfig {
    pub enabled: bool,
    pub max_long_term_memories: u32,
    pub max_injected_memories: u32,
    pub max_recent_turns: u32,
    pub summary_max_chars: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConfig {
    #[serde(default)]
    pub skills: Vec<SkillRegistryEntry>,
    #[serde(default)]
    pub mcp_servers: Vec<McpRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRegistryEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRegistryEntry {
    pub id: String,
    pub name: String,
    pub command: String,
    pub enabled: bool,
    #[serde(default)]
    pub tools: Vec<McpToolSummary>,
    #[serde(default)]
    pub tool_error: String,
    #[serde(default)]
    pub checked_at: Option<u64>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            general: GeneralConfig {
                language: default_language(),
                shortcut: "Cmd+Shift+Space".to_string(),
                window_size: "medium".to_string(),
                hotword_enabled: false,
            },
            models: ModelsConfig {
                text: TextModelConfig {
                    provider: "openai-compatible".to_string(),
                    base_url: "https://api.openai.com/v1".to_string(),
                    model: "gpt-4.1-mini".to_string(),
                    api_key: String::new(),
                },
                profiles: vec![default_text_profile()],
                selected_text_profile_id: "text-default".to_string(),
                selected_vision_profile_id: String::new(),
                selected_tts_profile_id: String::new(),
                selected_stt_profile_id: String::new(),
                vision: ModelSlotConfig {
                    provider: "openai-compatible".to_string(),
                    base_url: String::new(),
                    model: String::new(),
                    api_key_ref: String::new(),
                },
                tts: TtsModelConfig {
                    provider: "openai-compatible".to_string(),
                    base_url: String::new(),
                    voice: default_tts_voice(),
                    api_key_ref: String::new(),
                },
            },
            voice: VoiceConfig {
                push_to_talk_enabled: false,
                tts_enabled: false,
                stt_mode: default_stt_mode(),
                stt_model: default_stt_model(),
                push_to_talk_key: default_push_to_talk_key(),
                push_to_talk_mode: default_push_to_talk_mode(),
                auto_send_on_voice_end: false,
            },
            permissions: PermissionsConfig {
                allow_shell: false,
                allow_browser_automation: false,
                blocked_paths: Vec::new(),
                trusted_skills: Vec::new(),
            },
            registries: RegistryConfig::default(),
            memory: MemoryConfig {
                enabled: true,
                max_long_term_memories: 100,
                max_injected_memories: 10,
                max_recent_turns: 12,
                summary_max_chars: 800,
            },
        }
    }
}

fn default_language() -> String {
    "zh-CN".to_string()
}

fn default_push_to_talk_key() -> String {
    "Space".to_string()
}

fn default_stt_model() -> String {
    "whisper-1".to_string()
}

fn default_stt_mode() -> String {
    "local".to_string()
}

fn default_tts_voice() -> String {
    "alloy".to_string()
}

fn default_push_to_talk_mode() -> String {
    "hold".to_string()
}

fn default_model_profile_kind() -> String {
    "text".to_string()
}

fn default_text_profile() -> ModelProfile {
    ModelProfile {
        id: "text-default".to_string(),
        name: "OpenAI 文字模型".to_string(),
        capabilities: vec!["text".to_string()],
        kind: "text".to_string(),
        provider: "openai-compatible".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        model: "gpt-4.1-mini".to_string(),
        api_key: String::new(),
        voice: String::new(),
    }
}

pub fn load_app_config(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        let config = AppConfig::default();
        save_app_config(app, &config)?;
        return Ok(config);
    }

    let raw =
        fs::read_to_string(&path).map_err(|error| format!("Failed to read config: {error}"))?;
    let raw_json: Value =
        serde_json::from_str(&raw).map_err(|error| format!("Failed to parse config: {error}"))?;
    let mut config: AppConfig = serde_json::from_value(raw_json.clone())
        .map_err(|error| format!("Failed to parse config: {error}"))?;

    if !config.models.text.api_key.trim().is_empty() {
        save_text_model_api_key(&config.models.text.api_key)?;
        config.models.text.api_key.clear();
        write_config_json(app, &config)?;
    }

    config.models.text.api_key = load_text_model_api_key().unwrap_or_default();
    let normalized = normalize_model_profiles(
        &mut config,
        has_model_selection_field(&raw_json, "selectedVisionProfileId"),
        has_model_selection_field(&raw_json, "selectedTtsProfileId"),
        has_model_selection_field(&raw_json, "selectedSttProfileId"),
    );
    load_profile_api_keys(&mut config);
    migrate_legacy_profile_api_keys(&mut config)?;
    if normalized {
        write_config_json(app, &persisted_config(&config))?;
    }
    Ok(config)
}

pub fn save_app_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let previous = load_persisted_config_file(app)?.unwrap_or_default();

    if !config.models.text.api_key.trim().is_empty() {
        save_text_model_api_key(&config.models.text.api_key)?;
    } else {
        delete_text_model_api_key()?;
    }

    for profile in &config.models.profiles {
        if !profile.api_key.trim().is_empty() {
            save_model_profile_api_key(&profile.id, &profile.api_key)?;
        } else {
            delete_model_profile_api_key(&profile.id)?;
        }
    }

    for stale_profile_id in stale_profile_ids(&previous.models.profiles, &config.models.profiles) {
        delete_model_profile_api_key(&stale_profile_id)?;
    }

    let persisted = persisted_config(config);
    write_config_json(app, &persisted)
}

fn persisted_config(config: &AppConfig) -> AppConfig {
    let mut persisted = config.clone();
    persisted.models.text.api_key.clear();
    for profile in &mut persisted.models.profiles {
        profile.api_key.clear();
    }
    persisted
}

impl ModelsConfig {
    pub fn active_text_model(&self) -> TextModelConfig {
        let selected = self
            .profiles
            .iter()
            .find(|profile| {
                profile.id == self.selected_text_profile_id && profile.supports_capability("text")
            })
            .or_else(|| {
                self.profiles
                    .iter()
                    .find(|profile| profile.supports_capability("text"))
            });

        if let Some(profile) = selected {
            TextModelConfig {
                provider: profile.provider.clone(),
                base_url: profile.base_url.clone(),
                model: profile.model.clone(),
                api_key: profile.api_key.clone(),
            }
        } else {
            self.text.clone()
        }
    }

    pub fn active_vision_model(&self) -> Option<TextModelConfig> {
        if self.selected_vision_profile_id.trim().is_empty() {
            return None;
        }

        let selected = self.profiles.iter().find(|profile| {
            profile.id == self.selected_vision_profile_id && profile.supports_capability("vision")
        });

        selected.map(|profile| TextModelConfig {
            provider: profile.provider.clone(),
            base_url: profile.base_url.clone(),
            model: profile.model.clone(),
            api_key: profile.api_key.clone(),
        })
    }

    pub fn selected_tts_model(&self) -> Option<TtsRuntimeConfig> {
        let selected = self.profiles.iter().find(|profile| {
            profile.id == self.selected_tts_profile_id && profile.supports_capability("tts")
        })?;

        Some(TtsRuntimeConfig {
            provider: selected.provider.clone(),
            base_url: selected.base_url.clone(),
            model: selected.model.clone(),
            api_key: selected.api_key.clone(),
            voice: normalize_tts_voice(&selected.voice),
        })
    }

    pub fn active_tts_model(&self) -> TtsRuntimeConfig {
        let selected = self.selected_tts_model().or_else(|| {
            self.profiles
                .iter()
                .find(|profile| profile.supports_capability("tts"))
                .map(|profile| TtsRuntimeConfig {
                    provider: profile.provider.clone(),
                    base_url: profile.base_url.clone(),
                    model: profile.model.clone(),
                    api_key: profile.api_key.clone(),
                    voice: normalize_tts_voice(&profile.voice),
                })
        });

        if let Some(profile) = selected {
            profile
        } else {
            TtsRuntimeConfig {
                provider: self.tts.provider.clone(),
                base_url: self.tts.base_url.clone(),
                model: String::new(),
                api_key: String::new(),
                voice: normalize_tts_voice(&self.tts.voice),
            }
        }
    }

    pub fn selected_stt_model(&self) -> Option<SttRuntimeConfig> {
        let selected = self.profiles.iter().find(|profile| {
            profile.id == self.selected_stt_profile_id && profile.supports_capability("stt")
        })?;

        Some(SttRuntimeConfig {
            provider: selected.provider.clone(),
            base_url: selected.base_url.clone(),
            model: selected.model.clone(),
            api_key: selected.api_key.clone(),
        })
    }

    pub fn active_stt_model(&self) -> SttRuntimeConfig {
        let selected = self
            .selected_stt_model()
            .or_else(|| {
                self.profiles
                    .iter()
                    .find(|profile| profile.supports_capability("stt"))
                    .map(|profile| SttRuntimeConfig {
                        provider: profile.provider.clone(),
                        base_url: profile.base_url.clone(),
                        model: profile.model.clone(),
                        api_key: profile.api_key.clone(),
                    })
            })
            .or_else(|| {
                self.profiles
                    .iter()
                    .find(|profile| profile.supports_capability("tts"))
                    .map(|profile| SttRuntimeConfig {
                        provider: profile.provider.clone(),
                        base_url: profile.base_url.clone(),
                        model: profile.model.clone(),
                        api_key: profile.api_key.clone(),
                    })
            })
            .or_else(|| {
                self.profiles
                    .iter()
                    .find(|profile| profile.supports_capability("text"))
                    .map(|profile| SttRuntimeConfig {
                        provider: profile.provider.clone(),
                        base_url: profile.base_url.clone(),
                        model: profile.model.clone(),
                        api_key: profile.api_key.clone(),
                    })
            });

        if let Some(profile) = selected {
            profile
        } else {
            let text = self.active_text_model();
            SttRuntimeConfig {
                provider: text.provider,
                base_url: text.base_url,
                model: text.model,
                api_key: text.api_key,
            }
        }
    }
}

fn normalize_tts_voice(voice: &str) -> String {
    let trimmed = voice.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
        default_tts_voice()
    } else {
        trimmed.to_string()
    }
}

impl ModelProfile {
    fn supports_capability(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|item| item == capability) || self.kind == capability
    }
}

fn normalize_model_profiles(
    config: &mut AppConfig,
    has_selected_vision_profile_id: bool,
    has_selected_tts_profile_id: bool,
    has_selected_stt_profile_id: bool,
) -> bool {
    let mut changed = false;
    if config.models.profiles.is_empty() {
        let mut profile = default_text_profile();
        profile.provider = config.models.text.provider.clone();
        profile.base_url = config.models.text.base_url.clone();
        profile.model = config.models.text.model.clone();
        profile.api_key = config.models.text.api_key.clone();
        config.models.profiles.push(profile);
        changed = true;
    }

    if !config
        .models
        .profiles
        .iter()
        .any(|profile| profile.supports_capability("vision"))
        && legacy_vision_slot_configured(&config.models.vision)
    {
        config.models.profiles.push(ModelProfile {
            id: "vision-legacy".to_string(),
            name: "迁移的多模态模型".to_string(),
            capabilities: vec!["vision".to_string()],
            kind: "vision".to_string(),
            provider: config.models.vision.provider.clone(),
            base_url: config.models.vision.base_url.clone(),
            model: config.models.vision.model.clone(),
            api_key: String::new(),
            voice: String::new(),
        });
        changed = true;
    }

    let selected_text_profile_id = resolve_selected_profile_id(
        &config.models.profiles,
        "text",
        &config.models.selected_text_profile_id,
        false,
    );
    if config.models.selected_text_profile_id != selected_text_profile_id {
        config.models.selected_text_profile_id = selected_text_profile_id;
        changed = true;
    }

    let selected_vision_profile_id = resolve_selected_profile_id(
        &config.models.profiles,
        "vision",
        &config.models.selected_vision_profile_id,
        has_selected_vision_profile_id,
    );
    if config.models.selected_vision_profile_id != selected_vision_profile_id {
        config.models.selected_vision_profile_id = selected_vision_profile_id;
        changed = true;
    }

    let selected_tts_profile_id = resolve_selected_profile_id(
        &config.models.profiles,
        "tts",
        &config.models.selected_tts_profile_id,
        has_selected_tts_profile_id,
    );
    if config.models.selected_tts_profile_id != selected_tts_profile_id {
        config.models.selected_tts_profile_id = selected_tts_profile_id;
        changed = true;
    }

    let selected_stt_profile_id = resolve_selected_profile_id(
        &config.models.profiles,
        "stt",
        &config.models.selected_stt_profile_id,
        has_selected_stt_profile_id,
    );
    if config.models.selected_stt_profile_id != selected_stt_profile_id {
        config.models.selected_stt_profile_id = selected_stt_profile_id;
        changed = true;
    }

    for profile in &mut config.models.profiles {
        let original_capabilities = profile.capabilities.clone();
        let original_kind = profile.kind.clone();
        if profile.capabilities.is_empty() {
            profile.capabilities.push(profile.kind.clone());
        }
        profile.capabilities.sort();
        profile.capabilities.dedup();
        profile.kind = profile
            .capabilities
            .first()
            .cloned()
            .unwrap_or_else(default_model_profile_kind);
        if profile.capabilities != original_capabilities || profile.kind != original_kind {
            changed = true;
        }
    }

    changed
}

fn resolve_selected_profile_id(
    profiles: &[ModelProfile],
    capability: &str,
    selected_id: &str,
    preserve_explicit_empty: bool,
) -> String {
    let trimmed = selected_id.trim();
    if !trimmed.is_empty() {
        if let Some(profile) = profiles
            .iter()
            .find(|profile| profile.id == trimmed && profile.supports_capability(capability))
        {
            return profile.id.clone();
        }
    }

    if preserve_explicit_empty && trimmed.is_empty() {
        return String::new();
    }

    profiles
        .iter()
        .find(|profile| profile.supports_capability(capability))
        .map(|profile| profile.id.clone())
        .unwrap_or_default()
}

fn legacy_vision_slot_configured(slot: &ModelSlotConfig) -> bool {
    !slot.model.trim().is_empty() || !slot.base_url.trim().is_empty()
}

fn has_model_selection_field(raw_json: &Value, field_name: &str) -> bool {
    raw_json
        .get("models")
        .and_then(Value::as_object)
        .map(|models| models.contains_key(field_name))
        .unwrap_or(false)
}

fn load_profile_api_keys(config: &mut AppConfig) {
    for profile in &mut config.models.profiles {
        if profile.api_key.trim().is_empty() {
            profile.api_key = load_model_profile_api_key(&profile.id).unwrap_or_default();
        }
    }
}

fn migrate_legacy_profile_api_keys(config: &mut AppConfig) -> Result<(), String> {
    let legacy_api_key_ref = config.models.vision.api_key_ref.trim();
    if legacy_api_key_ref.is_empty() {
        return Ok(());
    }

    let legacy_provider = config.models.vision.provider.trim().to_string();
    let legacy_base_url = config.models.vision.base_url.trim().to_string();
    let legacy_model = config.models.vision.model.trim().to_string();

    let Some(profile) = config.models.profiles.iter_mut().find(|profile| {
        profile.supports_capability("vision")
            && profile.api_key.trim().is_empty()
            && profile.provider.trim() == legacy_provider
            && profile.base_url.trim() == legacy_base_url
            && profile.model.trim() == legacy_model
    }) else {
        return Ok(());
    };

    let api_key = load_api_key(legacy_api_key_ref)?;
    if api_key.trim().is_empty() {
        return Ok(());
    }

    save_model_profile_api_key(&profile.id, &api_key)?;
    profile.api_key = api_key;
    Ok(())
}

fn write_config_json(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create config dir: {error}"))?;
    }

    let raw = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize config: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("Failed to write config: {error}"))
}

fn load_persisted_config_file(app: &AppHandle) -> Result<Option<AppConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw =
        fs::read_to_string(path).map_err(|error| format!("Failed to read config: {error}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| format!("Failed to parse config: {error}"))
}

fn save_text_model_api_key(api_key: &str) -> Result<(), String> {
    save_api_key(TEXT_MODEL_API_KEY_ACCOUNT, api_key)
}

fn load_text_model_api_key() -> Result<String, String> {
    load_api_key(TEXT_MODEL_API_KEY_ACCOUNT)
}

fn delete_text_model_api_key() -> Result<(), String> {
    delete_api_key(TEXT_MODEL_API_KEY_ACCOUNT)
}

fn save_model_profile_api_key(profile_id: &str, api_key: &str) -> Result<(), String> {
    save_api_key(&model_profile_key_account(profile_id), api_key)
}

fn load_model_profile_api_key(profile_id: &str) -> Result<String, String> {
    load_api_key(&model_profile_key_account(profile_id))
}

fn delete_model_profile_api_key(profile_id: &str) -> Result<(), String> {
    delete_api_key(&model_profile_key_account(profile_id))
}

fn model_profile_key_account(profile_id: &str) -> String {
    let safe_id: String = profile_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    format!("model-profile-{safe_id}")
}

fn save_api_key(account: &str, api_key: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .args([
                "add-generic-password",
                "-a",
                account,
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
                api_key,
                "-U",
            ])
            .output()
            .map_err(|error| format!("Failed to run Keychain command: {error}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to save API key to Keychain: {stderr}"));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = api_key;
        Err("Keychain storage is only implemented for macOS".to_string())
    }
}

fn delete_api_key(account: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .args([
                "delete-generic-password",
                "-a",
                account,
                "-s",
                KEYCHAIN_SERVICE,
            ])
            .output()
            .map_err(|error| format!("Failed to run Keychain command: {error}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("could not be found") || stderr.contains("item not found") {
            return Ok(());
        }

        Err(format!(
            "Failed to delete API key from Keychain: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        Err("Keychain storage is only implemented for macOS".to_string())
    }
}

fn load_api_key(account: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .args([
                "find-generic-password",
                "-a",
                account,
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
            ])
            .output()
            .map_err(|error| format!("Failed to run Keychain command: {error}"))?;

        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout)
                .trim_end()
                .to_string());
        }

        Ok(String::new())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(String::new())
    }
}

fn stale_profile_ids(previous: &[ModelProfile], next: &[ModelProfile]) -> Vec<String> {
    let next_ids = next
        .iter()
        .map(|profile| profile.id.trim())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>();

    previous
        .iter()
        .map(|profile| profile.id.trim())
        .filter(|id| !id.is_empty() && !next_ids.contains(id))
        .map(ToOwned::to_owned)
        .collect()
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("config.json"))
        .map_err(|error| format!("Failed to resolve config dir: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_config_removes_text_model_api_key() {
        let mut config = AppConfig::default();
        config.models.text.api_key = "dummy-text-key".to_string();
        config.models.profiles[0].api_key = "dummy-profile-key".to_string();

        let persisted = persisted_config(&config);

        assert_eq!(persisted.models.text.api_key, "");
        assert_eq!(persisted.models.profiles[0].api_key, "");
        assert_eq!(config.models.text.api_key, "dummy-text-key");
        assert_eq!(config.models.profiles[0].api_key, "dummy-profile-key");
    }

    #[test]
    fn active_text_model_accepts_multimodal_profile() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![ModelProfile {
            id: "omni".to_string(),
            name: "Omni model".to_string(),
            capabilities: vec!["text".to_string(), "vision".to_string()],
            kind: "text".to_string(),
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "omni-test".to_string(),
            api_key: "secret".to_string(),
            voice: String::new(),
        }];
        config.models.selected_text_profile_id = "omni".to_string();

        let active = config.models.active_text_model();

        assert_eq!(active.model, "omni-test");
        assert_eq!(active.api_key, "secret");
    }

    #[test]
    fn active_tts_model_maps_legacy_default_voice() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![ModelProfile {
            id: "voice".to_string(),
            name: "Voice model".to_string(),
            capabilities: vec!["tts".to_string()],
            kind: "tts".to_string(),
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "tts-1".to_string(),
            api_key: "secret".to_string(),
            voice: "default".to_string(),
        }];
        config.models.selected_tts_profile_id = "voice".to_string();

        let active = config.models.active_tts_model();

        assert_eq!(active.voice, "alloy");
    }

    #[test]
    fn selected_tts_model_returns_none_when_unselected() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![ModelProfile {
            id: "text".to_string(),
            name: "Text model".to_string(),
            capabilities: vec!["text".to_string()],
            kind: "text".to_string(),
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "text-model".to_string(),
            api_key: "text-key".to_string(),
            voice: String::new(),
        }];
        config.models.selected_tts_profile_id.clear();

        assert!(config.models.selected_tts_model().is_none());
    }

    #[test]
    fn active_stt_model_prefers_selected_stt_profile() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![
            ModelProfile {
                id: "text".to_string(),
                name: "Text model".to_string(),
                capabilities: vec!["text".to_string()],
                kind: "text".to_string(),
                provider: "openai-compatible".to_string(),
                base_url: "https://api.example.com/v1".to_string(),
                model: "text-model".to_string(),
                api_key: "text-key".to_string(),
                voice: String::new(),
            },
            ModelProfile {
                id: "stt".to_string(),
                name: "STT model".to_string(),
                capabilities: vec!["stt".to_string()],
                kind: "stt".to_string(),
                provider: "Mimo".to_string(),
                base_url: "https://token-plan-cn.xiaomimimo.com/v1".to_string(),
                model: "mimo-v2.5-asr".to_string(),
                api_key: "stt-key".to_string(),
                voice: String::new(),
            },
        ];
        config.models.selected_stt_profile_id = "stt".to_string();

        let active = config.models.active_stt_model();

        assert_eq!(active.provider, "Mimo");
        assert_eq!(active.model, "mimo-v2.5-asr");
        assert_eq!(active.api_key, "stt-key");
    }

    #[test]
    fn selected_stt_model_returns_none_when_unselected() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![ModelProfile {
            id: "text".to_string(),
            name: "Text model".to_string(),
            capabilities: vec!["text".to_string()],
            kind: "text".to_string(),
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "text-model".to_string(),
            api_key: "text-key".to_string(),
            voice: String::new(),
        }];
        config.models.selected_stt_profile_id.clear();

        assert!(config.models.selected_stt_model().is_none());
    }

    #[test]
    fn normalize_model_profiles_migrates_legacy_vision_slot() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![default_text_profile()];
        config.models.vision.provider = "openai-compatible".to_string();
        config.models.vision.base_url = "https://api.example.com/v1".to_string();
        config.models.vision.model = "gpt-4.1-mini".to_string();
        config.models.selected_vision_profile_id.clear();

        let changed = normalize_model_profiles(&mut config, false, false, false);

        assert!(changed);
        assert_eq!(config.models.selected_vision_profile_id, "vision-legacy");
        assert!(config
            .models
            .profiles
            .iter()
            .any(|profile| profile.id == "vision-legacy" && profile.supports_capability("vision")));
    }

    #[test]
    fn normalize_model_profiles_preserves_explicit_empty_stt_selection() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![
            default_text_profile(),
            ModelProfile {
                id: "stt".to_string(),
                name: "STT model".to_string(),
                capabilities: vec!["stt".to_string()],
                kind: "stt".to_string(),
                provider: "openai-compatible".to_string(),
                base_url: "https://api.example.com/v1".to_string(),
                model: "whisper-1".to_string(),
                api_key: String::new(),
                voice: String::new(),
            },
        ];
        config.models.selected_stt_profile_id.clear();

        let changed = normalize_model_profiles(&mut config, false, false, true);

        assert!(!changed);
        assert_eq!(config.models.selected_stt_profile_id, "");
    }

    #[test]
    fn normalize_model_profiles_preserves_explicit_empty_legacy_vision_selection() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![default_text_profile()];
        config.models.vision.provider = "openai-compatible".to_string();
        config.models.vision.base_url = "https://api.example.com/v1".to_string();
        config.models.vision.model = "gpt-4.1-mini".to_string();
        config.models.selected_vision_profile_id.clear();

        let changed = normalize_model_profiles(&mut config, true, false, false);

        assert!(changed);
        assert_eq!(config.models.selected_vision_profile_id, "");
        assert!(config
            .models
            .profiles
            .iter()
            .any(|profile| profile.id == "vision-legacy" && profile.supports_capability("vision")));
    }

    #[test]
    fn normalize_model_profiles_selects_existing_vision_profile_when_field_missing() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![
            default_text_profile(),
            ModelProfile {
                id: "vision".to_string(),
                name: "Vision model".to_string(),
                capabilities: vec!["vision".to_string()],
                kind: "vision".to_string(),
                provider: "openai-compatible".to_string(),
                base_url: "https://api.example.com/v1".to_string(),
                model: "gpt-4.1-mini".to_string(),
                api_key: String::new(),
                voice: String::new(),
            },
        ];
        config.models.selected_vision_profile_id.clear();

        let changed = normalize_model_profiles(&mut config, false, false, false);

        assert!(changed);
        assert_eq!(config.models.selected_vision_profile_id, "vision");
    }

    #[test]
    fn normalize_model_profiles_selects_existing_tts_profile_when_field_missing() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![
            default_text_profile(),
            ModelProfile {
                id: "tts".to_string(),
                name: "TTS model".to_string(),
                capabilities: vec!["tts".to_string()],
                kind: "tts".to_string(),
                provider: "openai-compatible".to_string(),
                base_url: "https://api.example.com/v1".to_string(),
                model: "tts-1".to_string(),
                api_key: String::new(),
                voice: "alloy".to_string(),
            },
        ];
        config.models.selected_tts_profile_id.clear();

        let changed = normalize_model_profiles(&mut config, false, false, false);

        assert!(changed);
        assert_eq!(config.models.selected_tts_profile_id, "tts");
    }

    #[test]
    fn normalize_model_profiles_replaces_stale_text_selection() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![ModelProfile {
            id: "valid-text".to_string(),
            name: "Text model".to_string(),
            capabilities: vec!["text".to_string()],
            kind: "text".to_string(),
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "gpt-4.1-mini".to_string(),
            api_key: String::new(),
            voice: String::new(),
        }];
        config.models.selected_text_profile_id = "deleted-text".to_string();

        let changed = normalize_model_profiles(&mut config, true, true, true);

        assert!(changed);
        assert_eq!(config.models.selected_text_profile_id, "valid-text");
    }

    #[test]
    fn normalize_model_profiles_preserves_explicit_empty_vision_with_existing_profile() {
        let mut config = AppConfig::default();
        config.models.profiles = vec![
            default_text_profile(),
            ModelProfile {
                id: "vision".to_string(),
                name: "Vision model".to_string(),
                capabilities: vec!["vision".to_string()],
                kind: "vision".to_string(),
                provider: "openai-compatible".to_string(),
                base_url: "https://api.example.com/v1".to_string(),
                model: "gpt-4.1-mini".to_string(),
                api_key: String::new(),
                voice: String::new(),
            },
        ];
        config.models.selected_vision_profile_id.clear();

        let changed = normalize_model_profiles(&mut config, true, true, true);

        assert!(!changed);
        assert_eq!(config.models.selected_vision_profile_id, "");
    }

    #[test]
    fn stale_profile_ids_detect_removed_profiles() {
        let previous = vec![
            ModelProfile {
                id: "text".to_string(),
                name: "Text".to_string(),
                capabilities: vec!["text".to_string()],
                kind: "text".to_string(),
                provider: "openai-compatible".to_string(),
                base_url: "https://api.example.com/v1".to_string(),
                model: "gpt-4.1-mini".to_string(),
                api_key: String::new(),
                voice: String::new(),
            },
            ModelProfile {
                id: "tts".to_string(),
                name: "TTS".to_string(),
                capabilities: vec!["tts".to_string()],
                kind: "tts".to_string(),
                provider: "openai-compatible".to_string(),
                base_url: "https://api.example.com/v1".to_string(),
                model: "tts-1".to_string(),
                api_key: String::new(),
                voice: "alloy".to_string(),
            },
        ];
        let next = vec![previous[0].clone()];

        assert_eq!(stale_profile_ids(&previous, &next), vec!["tts".to_string()]);
    }
}

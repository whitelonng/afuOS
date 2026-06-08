use crate::config::{SttRuntimeConfig, TtsRuntimeConfig};
use base64::{engine::general_purpose, Engine as _};
use reqwest::{multipart, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsAudioResponse {
    pub mime_type: String,
    pub base64_audio: String,
}

#[derive(Debug, Deserialize)]
struct TranscriptionResponse {
    text: String,
}

#[derive(Debug, Deserialize)]
struct MimoChatResponse {
    choices: Vec<MimoChatChoice>,
}

#[derive(Debug, Deserialize)]
struct MimoChatChoice {
    message: MimoChatMessage,
}

#[derive(Debug, Deserialize)]
struct MimoChatMessage {
    content: Option<String>,
    audio: Option<MimoAudioPayload>,
}

#[derive(Debug, Deserialize)]
struct MimoAudioPayload {
    data: String,
    format: Option<String>,
}

pub async fn synthesize_speech(
    config: &TtsRuntimeConfig,
    input: String,
) -> Result<TtsAudioResponse, String> {
    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return Err("missing_tts_api_key".to_string());
    }

    let base_url = config.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("missing_tts_base_url".to_string());
    }

    let model = config.model.trim();
    if model.is_empty() {
        return Err("missing_tts_model".to_string());
    }

    let text = input.trim();
    if text.is_empty() {
        return Err("missing_tts_input".to_string());
    }

    if is_mimo_provider(&config.provider, base_url, model) {
        return synthesize_mimo_speech(config, base_url, model, api_key, text).await;
    }

    let client = reqwest::Client::new();
    let response =
        post_tts_request(&client, &format!("{base_url}/audio/speech"), config, text).await?;
    let status = response.status();
    let response = if status == StatusCode::NOT_FOUND && !base_url.ends_with("/v1") {
        post_tts_request(
            &client,
            &format!("{base_url}/v1/audio/speech"),
            config,
            text,
        )
        .await?
    } else {
        response
    };

    let status = response.status();
    if status != StatusCode::OK {
        let body = response
            .text()
            .await
            .map_err(|error| format!("tts_response_read_failed: {error}"))?;
        return Err(format!("tts_http_error:{status}:{body}"));
    }

    let audio = response
        .bytes()
        .await
        .map_err(|error| format!("tts_audio_read_failed: {error}"))?;

    Ok(TtsAudioResponse {
        mime_type: "audio/mpeg".to_string(),
        base64_audio: general_purpose::STANDARD.encode(audio),
    })
}

async fn post_tts_request(
    client: &reqwest::Client,
    url: &str,
    config: &TtsRuntimeConfig,
    text: &str,
) -> Result<reqwest::Response, String> {
    client
        .post(url)
        .bearer_auth(config.api_key.trim())
        .json(&json!({
            "model": config.model.trim(),
            "voice": config.voice.trim(),
            "input": text,
            "response_format": "mp3"
        }))
        .send()
        .await
        .map_err(|error| format!("tts_request_failed: {error}"))
}

async fn synthesize_mimo_speech(
    config: &TtsRuntimeConfig,
    base_url: &str,
    model: &str,
    api_key: &str,
    text: &str,
) -> Result<TtsAudioResponse, String> {
    let client = reqwest::Client::new();
    let url = chat_completions_url(base_url);
    let response = client
        .post(&url)
        .bearer_auth(api_key)
        .header("api-key", api_key)
        .json(&json!({
            "model": model,
            "messages": [
                {
                    "role": "assistant",
                    "content": text
                }
            ],
            "modalities": ["text", "audio"],
            "audio": {
                "voice": config.voice.trim(),
                "format": "mp3"
            }
        }))
        .send()
        .await
        .map_err(|error| format!("tts_request_failed: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("tts_response_read_failed: {error}"))?;
    if status != StatusCode::OK {
        return Err(format!("tts_http_error:{status}:{body}"));
    }

    let parsed: MimoChatResponse = serde_json::from_str(&body)
        .map_err(|error| format!("tts_response_parse_failed: {error}"))?;
    let audio = parsed
        .choices
        .first()
        .and_then(|choice| choice.message.audio.as_ref())
        .ok_or_else(|| "tts_response_missing_audio".to_string())?;

    Ok(TtsAudioResponse {
        mime_type: audio_mime_type(audio.format.as_deref().unwrap_or("mp3")).to_string(),
        base64_audio: audio.data.clone(),
    })
}

pub async fn transcribe_speech(
    config: &SttRuntimeConfig,
    base64_audio: String,
    mime_type: String,
) -> Result<String, String> {
    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return Err("missing_stt_api_key".to_string());
    }

    let base_url = config.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("missing_stt_base_url".to_string());
    }

    let model = config.model.trim();
    if model.is_empty() {
        return Err("missing_stt_model".to_string());
    }

    let audio = general_purpose::STANDARD
        .decode(&base64_audio)
        .map_err(|error| format!("stt_audio_decode_failed: {error}"))?;
    if audio.is_empty() {
        return Err("missing_stt_audio".to_string());
    }

    if is_mimo_provider(&config.provider, base_url, model) {
        return transcribe_mimo_speech(base_url, api_key, model, &base64_audio, &mime_type).await;
    }

    let client = reqwest::Client::new();
    let response = post_stt_request(
        &client,
        &format!("{base_url}/audio/transcriptions"),
        api_key,
        model,
        &audio,
        &mime_type,
    )
    .await?;
    let status = response.status();
    let response = if status == StatusCode::NOT_FOUND && !base_url.ends_with("/v1") {
        post_stt_request(
            &client,
            &format!("{base_url}/v1/audio/transcriptions"),
            api_key,
            model,
            &audio,
            &mime_type,
        )
        .await?
    } else {
        response
    };

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("stt_response_read_failed: {error}"))?;
    if status != StatusCode::OK {
        return Err(format!("stt_http_error:{status}:{body}"));
    }

    let parsed: TranscriptionResponse = serde_json::from_str(&body)
        .map_err(|error| format!("stt_response_parse_failed: {error}"))?;
    Ok(parsed.text)
}

async fn post_stt_request(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    audio: &[u8],
    mime_type: &str,
) -> Result<reqwest::Response, String> {
    let extension = if mime_type.contains("mp4") {
        "mp4"
    } else if mime_type.contains("mpeg") || mime_type.contains("mp3") {
        "mp3"
    } else if mime_type.contains("wav") {
        "wav"
    } else {
        "webm"
    };
    let part = multipart::Part::bytes(audio.to_vec())
        .file_name(format!("speech.{extension}"))
        .mime_str(if mime_type.trim().is_empty() {
            "audio/webm"
        } else {
            mime_type
        })
        .map_err(|error| format!("stt_multipart_failed: {error}"))?;
    let form = multipart::Form::new()
        .text("model", model.to_string())
        .part("file", part);

    client
        .post(url)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("stt_request_failed: {error}"))
}

async fn transcribe_mimo_speech(
    base_url: &str,
    api_key: &str,
    model: &str,
    base64_audio: &str,
    mime_type: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = chat_completions_url(base_url);
    let audio_format = audio_format(mime_type);
    let response = client
        .post(&url)
        .bearer_auth(api_key)
        .header("api-key", api_key)
        .json(&json!({
            "model": normalize_mimo_stt_model(model),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": base64_audio,
                                "format": audio_format
                            }
                        }
                    ]
                }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("stt_request_failed: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("stt_response_read_failed: {error}"))?;
    if status != StatusCode::OK {
        return Err(format!("stt_http_error:{status}:{body}"));
    }

    let parsed: MimoChatResponse = serde_json::from_str(&body)
        .map_err(|error| format!("stt_response_parse_failed: {error}"))?;
    parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "stt_response_missing_text".to_string())
}

fn is_mimo_provider(provider: &str, base_url: &str, model: &str) -> bool {
    let provider = provider.to_ascii_lowercase();
    let base_url = base_url.to_ascii_lowercase();
    let model = model.to_ascii_lowercase();
    provider.contains("mimo") || base_url.contains("xiaomimimo.com") || model.starts_with("mimo-")
}

fn chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    }
}

fn normalize_mimo_stt_model(model: &str) -> &str {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed == "whisper-1" {
        "mimo-v2.5-asr"
    } else {
        trimmed
    }
}

fn audio_format(mime_type: &str) -> &'static str {
    if mime_type.contains("mp4") || mime_type.contains("mpeg") || mime_type.contains("mp3") {
        "mp3"
    } else {
        "wav"
    }
}

fn audio_mime_type(format: &str) -> &'static str {
    match format.trim().to_ascii_lowercase().as_str() {
        "wav" => "audio/wav",
        "mp3" | "mpeg" => "audio/mpeg",
        "mp4" => "audio/mp4",
        _ => "audio/mpeg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[tokio::test]
    async fn rejects_missing_tts_api_key() {
        let config = TtsRuntimeConfig {
            provider: "openai-compatible".to_string(),
            base_url: "http://127.0.0.1:1/v1".to_string(),
            model: "tts-1".to_string(),
            api_key: String::new(),
            voice: "alloy".to_string(),
        };

        let result = synthesize_speech(&config, "hello".to_string()).await;
        assert_eq!(result.unwrap_err(), "missing_tts_api_key");
    }

    #[tokio::test]
    async fn rejects_missing_stt_api_key() {
        let config = SttRuntimeConfig {
            provider: "openai-compatible".to_string(),
            base_url: "http://127.0.0.1:1/v1".to_string(),
            model: "whisper-1".to_string(),
            api_key: String::new(),
        };

        let result = transcribe_speech(&config, "abc".to_string(), "audio/webm".to_string()).await;
        assert_eq!(result.unwrap_err(), "missing_stt_api_key");
    }

    #[tokio::test]
    async fn mimo_tts_uses_chat_completions_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..size]);

            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(request.contains("api-key: test-key"));
            assert!(request.contains("\"modalities\":[\"text\",\"audio\"]"));
            assert!(request.contains("\"role\":\"assistant\""));

            let body = r#"{"choices":[{"message":{"audio":{"data":"Zm9v","format":"mp3"}}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        let config = TtsRuntimeConfig {
            provider: "Mimo".to_string(),
            base_url: format!("http://{address}/v1"),
            model: "mimo-v2.5-tts".to_string(),
            api_key: "test-key".to_string(),
            voice: "白桦".to_string(),
        };

        let result = synthesize_speech(&config, "你好".to_string())
            .await
            .expect("mimo tts response");

        assert_eq!(result.mime_type, "audio/mpeg");
        assert_eq!(result.base64_audio, "Zm9v");
    }

    #[tokio::test]
    async fn mimo_stt_maps_default_model_and_uses_chat_completions_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..size]);

            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(request.contains("api-key: test-key"));
            assert!(request.contains("\"model\":\"mimo-v2.5-asr\""));
            assert!(request.contains("\"type\":\"input_audio\""));

            let body = r#"{"choices":[{"message":{"content":"你好"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        let config = SttRuntimeConfig {
            provider: "Mimo".to_string(),
            base_url: format!("http://{address}/v1"),
            model: "whisper-1".to_string(),
            api_key: "test-key".to_string(),
        };

        let result = transcribe_speech(&config, "Zm9v".to_string(), "audio/wav".to_string())
            .await
            .expect("mimo stt response");

        assert_eq!(result, "你好");
    }

    #[test]
    fn mimo_chat_url_adds_chat_completions_once() {
        assert_eq!(
            chat_completions_url("https://token-plan-cn.xiaomimimo.com/v1"),
            "https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://token-plan-cn.xiaomimimo.com/v1/chat/completions"),
            "https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
        );
    }
}

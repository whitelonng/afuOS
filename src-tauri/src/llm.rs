use crate::config::TextModelConfig;
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: ChatMessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ChatMessageContent {
    Text(String),
    Parts(Vec<ChatMessageContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatMessageContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrlPayload },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrlPayload {
    pub url: String,
}

impl ChatMessage {
    pub fn text(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: ChatMessageContent::Text(content.into()),
        }
    }

    pub fn has_image(&self) -> bool {
        matches!(
            &self.content,
            ChatMessageContent::Parts(parts)
                if parts.iter().any(|part| matches!(part, ChatMessageContentPart::ImageUrl { .. }))
        )
    }
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: AssistantMessage,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    content: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionStreamResponse {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<Value>,
}

pub async fn chat_completion(
    config: &TextModelConfig,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return Err("missing_api_key".to_string());
    }

    let base_url = config.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("missing_base_url".to_string());
    }

    let model = config.model.trim();
    if model.is_empty() {
        return Err("missing_model".to_string());
    }

    let url = format!("{base_url}/chat/completions");
    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "messages": messages,
            "stream": false,
            "temperature": 0.7
        }))
        .send()
        .await
        .map_err(|error| format!("model_request_failed: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("model_response_read_failed: {error}"))?;

    if status != StatusCode::OK {
        return Err(model_http_error(status, &body));
    }

    let parsed: ChatCompletionResponse = serde_json::from_str(&body)
        .map_err(|error| format!("model_response_parse_failed: {error}"))?;

    parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_ref())
        .map(parse_assistant_content)
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| "empty_model_response".to_string())
}

pub async fn chat_completion_stream<F>(
    config: &TextModelConfig,
    messages: Vec<ChatMessage>,
    reasoning_mode: &str,
    on_delta: F,
    is_cancelled: impl Fn() -> bool,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return Err("missing_api_key".to_string());
    }

    let base_url = config.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("missing_base_url".to_string());
    }

    let model = config.model.trim();
    if model.is_empty() {
        return Err("missing_model".to_string());
    }

    let url = format!("{base_url}/chat/completions");
    let client = reqwest::Client::new();
    let mut request_body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "temperature": 0.4
    });

    if reasoning_mode == "thinking" {
        request_body["reasoning_effort"] = json!("medium");
        request_body["temperature"] = json!(0.7);
    }

    let mut response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|error| format!("model_request_failed: {error}"))?;

    let status = response.status();
    if status != StatusCode::OK {
        let body = response
            .text()
            .await
            .map_err(|error| format!("model_response_read_failed: {error}"))?;
        if reasoning_mode == "thinking" && is_unsupported_reasoning_effort_error(&body) {
            if let Some(object) = request_body.as_object_mut() {
                object.remove("reasoning_effort");
                object.insert("temperature".to_string(), json!(0.4));
            }
            response = client
                .post(format!("{base_url}/chat/completions"))
                .bearer_auth(api_key)
                .json(&request_body)
                .send()
                .await
                .map_err(|error| format!("model_request_failed: {error}"))?;

            let retry_status = response.status();
            if retry_status == StatusCode::OK {
                return stream_chat_response(response, on_delta, is_cancelled).await;
            }

            let retry_body = response
                .text()
                .await
                .map_err(|error| format!("model_response_read_failed: {error}"))?;
            return Err(model_http_error(retry_status, &retry_body));
        }
        return Err(model_http_error(status, &body));
    }

    stream_chat_response(response, on_delta, is_cancelled).await
}

async fn stream_chat_response<F>(
    response: reqwest::Response,
    mut on_delta: F,
    is_cancelled: impl Fn() -> bool,
) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    let mut pending = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if is_cancelled() {
            return Err("chat_cancelled".to_string());
        }

        let chunk = chunk.map_err(|error| format!("model_stream_read_failed: {error}"))?;
        let text = String::from_utf8_lossy(&chunk);
        pending.push_str(&text);

        while let Some(line_end) = pending.find('\n') {
            if is_cancelled() {
                return Err("chat_cancelled".to_string());
            }

            let line = pending[..line_end].trim().to_string();
            pending = pending[line_end + 1..].to_string();
            process_stream_line(&line, &mut on_delta)?;
        }
    }

    if !pending.trim().is_empty() {
        process_stream_line(pending.trim(), &mut on_delta)?;
    }

    Ok(())
}

fn is_unsupported_reasoning_effort_error(body: &str) -> bool {
    let normalized = body.to_lowercase();
    normalized.contains("reasoning_effort")
        && (normalized.contains("unsupported")
            || normalized.contains("unknown")
            || normalized.contains("unrecognized")
            || normalized.contains("invalid")
            || normalized.contains("not support"))
}

fn model_http_error(status: StatusCode, body: &str) -> String {
    if status == StatusCode::NOT_FOUND && is_unsupported_image_input_error(body) {
        "vision_model_unsupported".to_string()
    } else {
        format!("model_http_error:{status}:{body}")
    }
}

fn is_unsupported_image_input_error(body: &str) -> bool {
    let normalized = body.to_lowercase();
    let condensed: String = normalized
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();

    (normalized.contains("image input") || condensed.contains("imageinput"))
        && ((normalized.contains("no endpoints") || condensed.contains("noendpoints"))
            || normalized.contains("unsupported")
            || normalized.contains("not support")
            || normalized.contains("not found")
            || condensed.contains("supportimageinput")
            || condensed.contains("supportsimageinput"))
}

fn process_stream_line<F>(line: &str, on_delta: &mut F) -> Result<(), String>
where
    F: FnMut(String) -> Result<(), String>,
{
    if line.is_empty() || !line.starts_with("data:") {
        return Ok(());
    }

    let data = line.trim_start_matches("data:").trim();
    if data == "[DONE]" {
        return Ok(());
    }

    let parsed: ChatCompletionStreamResponse = serde_json::from_str(data)
        .map_err(|error| format!("model_stream_parse_failed: {error}"))?;

    for choice in parsed.choices {
        if let Some(content) = choice.delta.content.as_ref() {
            let content = parse_assistant_content(content);
            if !content.is_empty() {
                on_delta(content)?;
            }
        }
    }

    Ok(())
}

fn parse_assistant_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(parse_assistant_content_part)
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => parse_assistant_content_part(content).unwrap_or_default(),
        _ => String::new(),
    }
}

fn parse_assistant_content_part(part: &Value) -> Option<String> {
    if let Some(text) = part.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }

    let content_type = part.get("type").and_then(Value::as_str).unwrap_or_default();
    if matches!(content_type, "text" | "output_text" | "input_text") {
        return None;
    }

    let image_url = part
        .get("image_url")
        .and_then(|image_url| {
            image_url
                .get("url")
                .and_then(Value::as_str)
                .or_else(|| image_url.as_str())
        })
        .or_else(|| part.get("url").and_then(Value::as_str))
        .or_else(|| part.get("uri").and_then(Value::as_str));
    if let Some(url) = image_url {
        return Some(format!("![assistant image]({url})"));
    }

    if matches!(content_type, "image" | "output_image") {
        let mime_type = part
            .get("mimeType")
            .or_else(|| part.get("mime_type"))
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        if let Some(data) = part.get("data").and_then(Value::as_str) {
            return Some(format!(
                "![assistant image](data:{mime_type};base64,{data})"
            ));
        }
    }

    serde_json::to_string(part).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn read_http_request(stream: &mut impl Read) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];

        loop {
            let size = stream.read(&mut buffer).expect("read request");
            assert!(size > 0, "request ended before body was fully read");
            bytes.extend_from_slice(&buffer[..size]);

            let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);

            if bytes.len() >= header_end + 4 + content_length {
                break;
            }
        }

        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[tokio::test]
    async fn rejects_missing_api_key() {
        let config = TextModelConfig {
            provider: "openai-compatible".to_string(),
            base_url: "http://127.0.0.1:1".to_string(),
            model: "test-model".to_string(),
            api_key: String::new(),
        };

        let result = chat_completion(&config, vec![]).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[tokio::test]
    async fn parses_openai_compatible_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_http_request(&mut stream);
            let request_lower = request.to_ascii_lowercase();

            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(request_lower.contains("authorization: bearer test-key"));
            assert!(request.contains("\"model\":\"test-model\""));

            let body = r#"{"choices":[{"message":{"content":"可以。我来写一句简短通知。"}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        let config = TextModelConfig {
            provider: "openai-compatible".to_string(),
            base_url: format!("http://{address}/v1"),
            model: "test-model".to_string(),
            api_key: "test-key".to_string(),
        };

        let result = chat_completion(&config, vec![ChatMessage::text("user", "写一句会议通知")])
            .await
            .expect("chat response");

        assert_eq!(result, "可以。我来写一句简短通知。");
    }

    #[tokio::test]
    async fn parses_openai_compatible_array_content_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_http_request(&mut stream);

            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));

            let body = r#"{"choices":[{"message":{"content":[{"type":"text","text":"这是图片："},{"type":"image_url","image_url":{"url":"https://example.com/a.png"}}]}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        let config = TextModelConfig {
            provider: "openai-compatible".to_string(),
            base_url: format!("http://{address}/v1"),
            model: "test-model".to_string(),
            api_key: "test-key".to_string(),
        };

        let result = chat_completion(&config, vec![ChatMessage::text("user", "生成一张图")])
            .await
            .expect("chat response");

        assert_eq!(
            result,
            "这是图片：\n![assistant image](https://example.com/a.png)"
        );
    }

    #[tokio::test]
    async fn parses_openai_compatible_stream_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let request = read_http_request(&mut stream);
            let request_lower = request.to_ascii_lowercase();

            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(request_lower.contains("authorization: bearer test-key"));
            assert!(request.contains("\"stream\":true"));

            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"可以。\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"我来写。\"}}]}\n\n",
                "data: [DONE]\n\n"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        let config = TextModelConfig {
            provider: "openai-compatible".to_string(),
            base_url: format!("http://{address}/v1"),
            model: "test-model".to_string(),
            api_key: "test-key".to_string(),
        };
        let mut chunks = Vec::new();

        chat_completion_stream(
            &config,
            vec![ChatMessage::text("user", "写一句会议通知")],
            "fast",
            |delta| {
                chunks.push(delta);
                Ok(())
            },
            || false,
        )
        .await
        .expect("stream response");

        assert_eq!(chunks, vec!["可以。", "我来写。"]);
    }

    #[test]
    fn parses_stream_array_content_delta() {
        let mut chunks = Vec::new();
        process_stream_line(
            r#"data: {"choices":[{"delta":{"content":[{"type":"text","text":"图："},{"type":"image_url","image_url":{"url":"https://example.com/b.png"}}]}}]}"#,
            &mut |delta| {
                chunks.push(delta);
                Ok(())
            },
        )
        .expect("stream line");

        assert_eq!(
            chunks,
            vec!["图：\n![assistant image](https://example.com/b.png)"]
        );
    }

    #[test]
    fn detects_unsupported_reasoning_effort_errors() {
        assert!(is_unsupported_reasoning_effort_error(
            r#"{"error":{"message":"Unsupported parameter: reasoning_effort"}}"#
        ));
        assert!(!is_unsupported_reasoning_effort_error(
            r#"{"error":{"message":"missing api key"}}"#
        ));
    }

    #[test]
    fn detects_unsupported_image_input_errors_with_condensed_spacing() {
        assert!(is_unsupported_image_input_error(
            r#"{"error":{"message":"No endpoints found that supportimage input"}}"#
        ));
        assert!(!is_unsupported_image_input_error(
            r#"{"error":{"message":"missing api key"}}"#
        ));
    }

    #[test]
    fn maps_user_reported_404_image_input_error_to_vision_unsupported() {
        let body = r#"{"error:{"code":"404","message":"No endpoints found that supportimage input","param":"","type":""}}"#;
        assert_eq!(
            model_http_error(StatusCode::NOT_FOUND, body),
            "vision_model_unsupported"
        );
    }
}

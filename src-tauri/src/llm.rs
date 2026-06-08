use crate::config::TextModelConfig;
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
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
    content: Option<String>,
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
    content: Option<String>,
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
        return Err(format!("model_http_error:{status}:{body}"));
    }

    let parsed: ChatCompletionResponse = serde_json::from_str(&body)
        .map_err(|error| format!("model_response_parse_failed: {error}"))?;

    parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone())
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
            return Err(format!("model_http_error:{retry_status}:{retry_body}"));
        }
        return Err(format!("model_http_error:{status}:{body}"));
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
        if let Some(content) = choice.delta.content {
            if !content.is_empty() {
                on_delta(content)?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

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
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..size]);

            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(request.contains("authorization: Bearer test-key"));
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

        let result = chat_completion(
            &config,
            vec![ChatMessage {
                role: "user".to_string(),
                content: "写一句会议通知".to_string(),
            }],
        )
        .await
        .expect("chat response");

        assert_eq!(result, "可以。我来写一句简短通知。");
    }

    #[tokio::test]
    async fn parses_openai_compatible_stream_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..size]);

            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(request.contains("authorization: Bearer test-key"));
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
            vec![ChatMessage {
                role: "user".to_string(),
                content: "写一句会议通知".to_string(),
            }],
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
    fn detects_unsupported_reasoning_effort_errors() {
        assert!(is_unsupported_reasoning_effort_error(
            r#"{"error":{"message":"Unsupported parameter: reasoning_effort"}}"#
        ));
        assert!(!is_unsupported_reasoning_effort_error(
            r#"{"error":{"message":"missing api key"}}"#
        ));
    }
}

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolSummary {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInspectionResult {
    pub status: String,
    pub server_name: String,
    pub tools: Vec<McpToolSummary>,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallResult {
    pub status: String,
    pub content: String,
    pub raw: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolRequest {
    pub command: String,
    pub server_name: String,
    pub tool_name: String,
    pub arguments: Value,
}

const HIGH_RISK_TOOL_MARKERS: &[&str] = &[
    "delete",
    "remove",
    "destroy",
    "drop",
    "truncate",
    "write",
    "update",
    "create",
    "add",
    "set",
    "save",
    "edit",
    "patch",
    "insert",
    "upsert",
    "replace",
    "rename",
    "move",
    "copy",
    "upload",
    "send",
    "post",
    "publish",
    "submit",
    "share",
    "invite",
    "grant",
    "revoke",
    "permission",
    "chmod",
    "chown",
    "deploy",
    "release",
    "merge",
    "commit",
    "push",
    "execute",
    "exec",
    "eval",
    "run",
    "start",
    "stop",
    "restart",
    "kill",
    "install",
    "uninstall",
    "login",
    "logout",
    "auth",
    "token",
    "credential",
    "secret",
    "key",
    "sql",
    "mutation",
    "command",
    "shell",
];

pub fn classify_mcp_tool_risk(tool_name: &str) -> (&'static str, &'static str) {
    let tokens = mcp_tool_name_tokens(tool_name);
    if HIGH_RISK_TOOL_MARKERS.iter().any(|marker| {
        tokens
            .iter()
            .any(|token| token == marker || token == &format!("{marker}s"))
    }) {
        (
            "high",
            "显式用户触发的 MCP 工具调用，工具名包含写入或执行语义",
        )
    } else {
        ("low", "显式用户触发的 MCP 工具调用")
    }
}

fn mcp_tool_name_tokens(tool_name: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut previous_was_lower_or_digit = false;

    for character in tool_name.chars() {
        if !character.is_ascii_alphanumeric() {
            if !current.is_empty() {
                tokens.push(current.to_lowercase());
                current.clear();
            }
            previous_was_lower_or_digit = false;
            continue;
        }

        if character.is_ascii_uppercase() && previous_was_lower_or_digit && !current.is_empty() {
            tokens.push(current.to_lowercase());
            current.clear();
        }

        previous_was_lower_or_digit = character.is_ascii_lowercase() || character.is_ascii_digit();
        current.push(character);
    }

    if !current.is_empty() {
        tokens.push(current.to_lowercase());
    }

    tokens
}

pub fn inspect_mcp_server(command: &str) -> McpInspectionResult {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return McpInspectionResult::error("MCP 命令为空");
    }

    match inspect_stdio_mcp_server(trimmed) {
        Ok(result) => result,
        Err(error) => McpInspectionResult::error(error),
    }
}

pub fn call_mcp_tool(command: &str, tool_name: &str, arguments: Value) -> McpToolCallResult {
    let trimmed_command = command.trim();
    let trimmed_tool = tool_name.trim();
    if trimmed_command.is_empty() {
        return McpToolCallResult::error("MCP 命令为空");
    }
    if trimmed_tool.is_empty() {
        return McpToolCallResult::error("MCP 工具名为空");
    }

    match call_stdio_mcp_tool(trimmed_command, trimmed_tool, arguments) {
        Ok(result) => result,
        Err(error) => McpToolCallResult::error(error),
    }
}

fn inspect_stdio_mcp_server(command: &str) -> Result<McpInspectionResult, String> {
    let mut child = spawn_stdio_mcp_server(command)?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法写入 MCP 服务 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 MCP 服务 stdout".to_string())?;
    let stderr = child.stderr.take();
    let (stdout_tx, stdout_rx) = mpsc::channel::<String>();
    let (stderr_tx, stderr_rx) = mpsc::channel::<String>();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = stdout_tx.send(line);
        }
    });

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut lines = Vec::new();
            for line in reader.lines().map_while(Result::ok).take(8) {
                lines.push(line);
            }
            if !lines.is_empty() {
                let _ = stderr_tx.send(lines.join("\n"));
            }
        });
    }

    let timeout = Duration::from_secs(8);
    write_json_message(&mut stdin, initialize_request())?;
    let initialized = read_response(1, &stdout_rx, timeout)?;
    ensure_json_rpc_success(&initialized)?;

    write_json_message(&mut stdin, initialized_notification())?;
    write_json_message(&mut stdin, tools_list_request())?;
    let tools_response = read_response(2, &stdout_rx, timeout)?;
    ensure_json_rpc_success(&tools_response)?;

    let _ = child.kill();
    let _ = child.wait();

    let tools = parse_tools_list_response(&tools_response)?;
    let server_name = initialized
        .pointer("/result/serverInfo/name")
        .and_then(Value::as_str)
        .unwrap_or("MCP")
        .to_string();
    let stderr = stderr_rx.try_recv().unwrap_or_default();
    let status = if tools.is_empty() { "empty" } else { "ok" };

    Ok(McpInspectionResult {
        status: status.to_string(),
        server_name,
        tools,
        error: stderr,
    })
}

fn call_stdio_mcp_tool(
    command: &str,
    tool_name: &str,
    arguments: Value,
) -> Result<McpToolCallResult, String> {
    let mut child = spawn_stdio_mcp_server(command)?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法写入 MCP 服务 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 MCP 服务 stdout".to_string())?;
    let stderr = child.stderr.take();
    let (stdout_tx, stdout_rx) = mpsc::channel::<String>();
    let (stderr_tx, stderr_rx) = mpsc::channel::<String>();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = stdout_tx.send(line);
        }
    });

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut lines = Vec::new();
            for line in reader.lines().map_while(Result::ok).take(8) {
                lines.push(line);
            }
            if !lines.is_empty() {
                let _ = stderr_tx.send(lines.join("\n"));
            }
        });
    }

    let timeout = Duration::from_secs(12);
    write_json_message(&mut stdin, initialize_request())?;
    let initialized = read_response(1, &stdout_rx, timeout)?;
    ensure_json_rpc_success(&initialized)?;

    write_json_message(&mut stdin, initialized_notification())?;
    write_json_message(&mut stdin, tools_call_request(tool_name, arguments))?;
    let call_response = read_response(2, &stdout_rx, timeout)?;
    ensure_json_rpc_success(&call_response)?;

    let _ = child.kill();
    let _ = child.wait();

    let stderr = stderr_rx.try_recv().unwrap_or_default();
    let is_tool_error = call_response
        .pointer("/result/isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = parse_tool_call_content(&call_response);

    Ok(McpToolCallResult {
        status: if is_tool_error { "error" } else { "ok" }.to_string(),
        content,
        raw: call_response.to_string(),
        error: stderr,
    })
}

fn write_json_message(stdin: &mut impl Write, value: Value) -> Result<(), String> {
    writeln!(stdin, "{value}").map_err(|error| format!("写入 MCP 消息失败：{error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("刷新 MCP stdin 失败：{error}"))
}

fn read_response(id: u64, rx: &Receiver<String>, timeout: Duration) -> Result<Value, String> {
    let started = Instant::now();
    loop {
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err("等待 MCP 响应超时".to_string());
        }

        let line = rx
            .recv_timeout(timeout - elapsed)
            .map_err(|_| "等待 MCP 响应超时".to_string())?;
        let parsed: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if parsed.get("id").and_then(Value::as_u64) == Some(id) {
            return Ok(parsed);
        }
    }
}

fn ensure_json_rpc_success(response: &Value) -> Result<(), String> {
    if let Some(error) = response.get("error") {
        return Err(format!("MCP 返回错误：{error}"));
    }
    Ok(())
}

fn initialize_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "afuos",
                "version": "0.1.0"
            }
        }
    })
}

fn initialized_notification() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    })
}

fn tools_list_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    })
}

fn tools_call_request(tool_name: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        }
    })
}

fn parse_tools_list_response(response: &Value) -> Result<Vec<McpToolSummary>, String> {
    let tools = response
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "MCP tools/list 响应缺少 tools 数组".to_string())?;

    Ok(tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            Some(McpToolSummary {
                name: name.to_string(),
                description,
            })
        })
        .collect())
}

fn parse_tool_call_content(response: &Value) -> String {
    response
        .pointer("/result/content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(parse_tool_content_part)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|content| !content.trim().is_empty())
        .unwrap_or_else(|| response.to_string())
}

fn parse_tool_content_part(part: &Value) -> Option<String> {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => part
            .get("text")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        Some("image") => {
            let mime_type = part
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            part.get("data")
                .and_then(Value::as_str)
                .map(|data| format!("![MCP image](data:{mime_type};base64,{data})"))
                .or_else(|| {
                    part.get("uri")
                        .and_then(Value::as_str)
                        .map(|uri| format!("MCP 返回图片：{uri}"))
                })
        }
        Some("audio") => {
            let mime_type = part
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("audio");
            Some(format!("MCP 返回音频内容：{mime_type}"))
        }
        Some("resource") => parse_resource_content(part),
        _ => serde_json::to_string(part).ok(),
    }
}

fn parse_resource_content(part: &Value) -> Option<String> {
    let resource = part.get("resource").unwrap_or(part);
    if let Some(text) = resource.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }

    let uri = resource
        .get("uri")
        .and_then(Value::as_str)
        .unwrap_or("resource");
    let mime_type = resource
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");

    if let Some(blob) = resource.get("blob").and_then(Value::as_str) {
        return Some(format!(
            "MCP 返回资源：{uri} ({mime_type}, {} bytes base64)",
            blob.len()
        ));
    }

    Some(format!("MCP 返回资源：{uri} ({mime_type})"))
}

fn spawn_stdio_mcp_server(command: &str) -> Result<Child, String> {
    let argv = parse_mcp_command(command)?;
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| "MCP 命令为空".to_string())?;
    Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 MCP 服务：{error}"))
}

fn parse_mcp_command(command: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut in_token = false;
    let mut chars = command.trim().chars().peekable();

    while let Some(character) = chars.next() {
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
                continue;
            }
            if active_quote == '"' && character == '\\' {
                if let Some(next) = chars.next() {
                    current.push(next);
                    in_token = true;
                }
                continue;
            }
            current.push(character);
            in_token = true;
            continue;
        }

        if character.is_whitespace() {
            if in_token {
                tokens.push(std::mem::take(&mut current));
                in_token = false;
            }
            continue;
        }

        if matches!(character, '\'' | '"') {
            quote = Some(character);
            in_token = true;
            continue;
        }

        if character == '\\' {
            if let Some(next) = chars.next() {
                current.push(next);
                in_token = true;
            }
            continue;
        }

        if is_shell_control_character(character) {
            return Err("MCP 命令不允许使用 shell 控制符，请只填写程序和参数".to_string());
        }

        current.push(character);
        in_token = true;
    }

    if quote.is_some() {
        return Err("MCP 命令包含未闭合的引号".to_string());
    }
    if in_token {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err("MCP 命令为空".to_string());
    }
    Ok(tokens)
}

fn is_shell_control_character(character: char) -> bool {
    matches!(character, ';' | '|' | '&' | '>' | '<' | '`')
}

impl McpInspectionResult {
    fn error(error: impl Into<String>) -> Self {
        Self {
            status: "error".to_string(),
            server_name: String::new(),
            tools: Vec::new(),
            error: error.into(),
        }
    }
}

impl McpToolCallResult {
    fn error(error: impl Into<String>) -> Self {
        Self {
            status: "error".to_string(),
            content: String::new(),
            raw: String::new(),
            error: error.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tools_list_response() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [
                    { "name": "search", "description": "Search docs" },
                    { "name": "empty-description" }
                ]
            }
        });

        let tools = parse_tools_list_response(&response).expect("tools");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "search");
        assert_eq!(tools[0].description, "Search docs");
        assert_eq!(tools[1].name, "empty-description");
        assert_eq!(tools[1].description, "");
    }

    #[test]
    fn rejects_missing_tools_array() {
        let response = json!({ "jsonrpc": "2.0", "id": 2, "result": {} });
        assert!(parse_tools_list_response(&response).is_err());
    }

    #[test]
    fn parses_mcp_command_as_argv_without_shell() {
        let argv = parse_mcp_command(
            "node -e 'console.log(\"hello world\")' --flag value\\ with\\ spaces",
        )
        .expect("argv");
        assert_eq!(argv[0], "node");
        assert_eq!(argv[1], "-e");
        assert_eq!(argv[2], "console.log(\"hello world\")");
        assert_eq!(argv[3], "--flag");
        assert_eq!(argv[4], "value with spaces");
    }

    #[test]
    fn rejects_mcp_command_shell_control_syntax() {
        assert!(parse_mcp_command("node server.js; rm -rf /tmp/x").is_err());
        assert!(parse_mcp_command("node server.js | sh").is_err());
        assert!(parse_mcp_command("node server.js && echo done").is_err());
    }

    #[test]
    fn rejects_empty_or_unclosed_mcp_command() {
        assert!(parse_mcp_command("  ").is_err());
        assert!(parse_mcp_command("node -e 'unterminated").is_err());
    }

    #[test]
    fn inspects_stdio_mcp_server_tools() {
        let script = r#"
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" }
      }
    });
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "mock_tool", description: "Mock tool" }
        ]
      }
    });
    process.exit(0);
  }
});
"#;
        let result = inspect_mcp_server(&format!("node -e {}", shell_quote(script)));

        assert_eq!(result.status, "ok");
        assert_eq!(result.server_name, "mock-mcp");
        assert_eq!(result.tools.len(), 1);
        assert_eq!(result.tools[0].name, "mock_tool");
    }

    #[test]
    fn calls_stdio_mcp_server_tool() {
        let script = r#"
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" }
      }
    });
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: message.params.name + ":" + message.params.arguments.query
          }
        ]
      }
    });
    process.exit(0);
  }
});
"#;
        let result = call_mcp_tool(
            &format!("node -e {}", shell_quote(script)),
            "mock_tool",
            json!({ "query": "afuos" }),
        );

        assert_eq!(result.status, "ok");
        assert_eq!(result.content, "mock_tool:afuos");
        assert!(result.raw.contains("\"tools/call\"") || result.raw.contains("mock_tool"));
    }

    #[test]
    fn classifies_write_like_mcp_tool_as_high_risk() {
        let (risk, reason) = classify_mcp_tool_risk("create_issue");
        assert_eq!(risk, "high");
        assert!(reason.contains("写入") || reason.contains("执行"));
    }

    #[test]
    fn classifies_common_side_effect_mcp_tools_as_high_risk() {
        for tool_name in [
            "edit_file",
            "saveDocument",
            "add_comment",
            "set_config",
            "patch_record",
            "upload_asset",
            "deploy_site",
            "grant_permission",
            "login_user",
            "eval_script",
            "install_package",
        ] {
            let (risk, _) = classify_mcp_tool_risk(tool_name);
            assert_eq!(risk, "high", "{tool_name} should be high risk");
        }
    }

    #[test]
    fn leaves_read_only_mcp_tools_low_risk() {
        for tool_name in ["search_docs", "list_projects", "get_status", "fetch_page"] {
            let (risk, _) = classify_mcp_tool_risk(tool_name);
            assert_eq!(risk, "low", "{tool_name} should be low risk");
        }
    }

    #[test]
    fn token_matching_avoids_short_marker_false_positives() {
        for tool_name in ["get_keyboard_layout", "startup_status", "monkey_search"] {
            let (risk, _) = classify_mcp_tool_risk(tool_name);
            assert_eq!(risk, "low", "{tool_name} should be low risk");
        }

        for tool_name in ["get_api_keys", "startServer"] {
            let (risk, _) = classify_mcp_tool_risk(tool_name);
            assert_eq!(risk, "high", "{tool_name} should be high risk");
        }
    }

    #[test]
    fn parses_non_text_tool_call_content() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "content": [
                    {
                        "type": "image",
                        "mimeType": "image/png",
                        "data": "iVBORw0KGgo="
                    },
                    {
                        "type": "resource",
                        "resource": {
                            "uri": "file:///tmp/report.txt",
                            "mimeType": "text/plain",
                            "text": "resource body"
                        }
                    },
                    {
                        "type": "audio",
                        "mimeType": "audio/wav",
                        "data": "UklGRg=="
                    }
                ]
            }
        });

        let content = parse_tool_call_content(&response);
        assert!(content.contains("![MCP image](data:image/png;base64,iVBORw0KGgo=)"));
        assert!(content.contains("resource body"));
        assert!(content.contains("MCP 返回音频内容：audio/wav"));
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

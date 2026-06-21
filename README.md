# afuOS - Local-first macOS AI Desktop Assistant

[中文 README](README.zh-CN.md)

afuOS is a local-first macOS AI desktop assistant built with Tauri, Rust, React, and TypeScript.

It provides a compact floating assistant for text, voice, and image interaction, OpenAI-compatible chat, local desktop actions, speech playback, conversation history, execution logs, and user-managed memory.

Use afuOS as a private Mac AI assistant for everyday desktop automation, multimodal chat, voice input, speech output, skill loading, MCP tools, and permission-aware local actions.

## Contents

- [Concept](#concept)
- [Features](#features)
- [Use Cases](#use-cases)
- [Requirements](#requirements)
- [Development](#development)
- [Configuration](#configuration)
- [Multimodal Images](#multimodal-images)
- [Local Permissions](#local-permissions)
- [Skills and MCP](#skills-and-mcp)
- [Privacy](#privacy)

## Concept

afuOS is inspired by Alfred, Batman's always-available butler. The goal is to bring that "call anytime" assistant experience to everyday Mac users.

It feels as easy to wake as a mobile assistant, but is designed to be smarter and more capable on the desktop. afuOS can remember your preferences, understand your working context, and help with practical tasks instead of only answering one-off questions.

## Features

- Floating assistant window with global shortcut wake and hide.
- OpenAI-compatible chat streaming.
- Multiple model profiles for text, vision, speech synthesis, and speech recognition.
- Image attachments in chat. User images are sent to the selected vision-capable profile as OpenAI-compatible `image_url` content, and assistant replies can render Markdown, remote, local, and data URL images.
- macOS native speech recognition or model-based speech recognition.
- Optional text-to-speech replies.
- Local actions for opening apps, URLs, files, folders, notes, reminders, clipboard text, and confirmed shell commands.
- Permission controls for local actions. Low-risk shell and browser actions can be auto-approved from settings or remembered for a specific target, while higher-risk actions always require explicit confirmation.
- Blocked paths that override saved permissions for file, shell, `file://`, recursive search, and MCP access.
- Skill and MCP registries with enable/disable controls. Trusted skills can inject local `SKILL.md` content, untrusted skills expose metadata only, and MCP servers can be inspected and called with permission checks.
- Local SQLite history, image attachments, execution logs, permission rules, and memory records.
- Editable memory and assistant profile files.
- API keys stored through macOS Keychain instead of plaintext config files.

## Use Cases

- Run a local-first macOS AI assistant without sending desktop data anywhere except the model endpoints you configure.
- Chat with OpenAI-compatible text and vision models from a compact floating window.
- Use voice input, native macOS speech recognition, model-based transcription, and text-to-speech replies.
- Execute permission-aware Mac automation for apps, URLs, files, folders, notes, reminders, clipboard text, shell commands, and MCP tools.
- Keep private conversation history, memories, image metadata, permission rules, and execution logs in local SQLite storage.
- Load trusted local `SKILL.md` files and connect MCP servers for tool-using AI workflows.

## Requirements

- macOS
- Node.js 20+
- Rust stable
- Xcode Command Line Tools

## Development

Install dependencies:

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run tauri -- dev
```

Build the frontend:

```bash
npm run build
```

Run the Rust test suite:

```bash
cd src-tauri
cargo test
```

Format the Rust sources:

```bash
cd src-tauri
cargo fmt
```

Build the macOS app bundle:

```bash
npm run tauri -- build --bundles app
```

The app bundle is generated at:

```text
src-tauri/target/release/bundle/macos/afuos.app
```

## Configuration

Model settings are configured inside the app. API keys are saved in macOS Keychain. The local config file stores model metadata and user preferences, but does not persist model API keys in plaintext. Stale plaintext keys are removed from local config during normal saves.

Profiles can be assigned separate roles for text chat, vision, speech recognition, and speech synthesis. Empty role selections are preserved, so users can intentionally disable a specific capability without the app silently falling back to another profile.

### Multimodal Images

To send images to a model, configure a profile with the `vision` capability and select it as the multimodal profile. The configured endpoint must support OpenAI-compatible image input. If the provider returns an error such as `No endpoints found that support image input`, afuOS surfaces it as an unsupported vision endpoint error instead of treating it as a generic model failure.

When a conversation contains image attachments, afuOS routes the request through the selected vision profile and sends the images as OpenAI-compatible content parts. Text-only conversations continue to use the selected text profile.

Assistant-generated or assistant-linked images are displayed when the reply contains standard Markdown image syntax:

```md
![description](https://example.com/image.png)
```

Local image paths can also render inside the desktop app when they are valid absolute file paths that the app can access.

Assistant responses that use OpenAI-style non-text content arrays are normalized before display. Text parts are rendered as text, and image parts are converted into Markdown image tags so they are visible in the chat.

### Voice Permissions

Voice input needs macOS Microphone and Speech Recognition permissions. If speech recognition is denied, allow `afuos` in macOS System Settings > Privacy & Security > Microphone and Speech Recognition, then restart the app.

### Local Permissions

Settings include separate authorization switches for low-risk shell commands and low-risk browser actions. Examples of low-risk shell commands include read-only commands such as `pwd`, `ls`, `date`, and desktop folder creation. Commands that can delete data, modify system settings, run downloaded scripts, or access blocked paths still require confirmation or are denied.

High-risk shell commands are never auto-approved by the settings switches or remembered permission rules. This includes commands with shell pipes or input/output redirection, command substitution, destructive file operations, system control commands, network download execution patterns, credential tooling, and commands that touch blocked paths.

Blocked paths are enforced across direct file targets, shell command paths, decoded `file://` URLs, recursive `find` scopes, and global metadata searches. If a blocked path would be included by a recursive command, the command is denied even when a broader parent path was previously allowed.

Saved permission rules are target-specific and are only used for low-risk actions. If a later action is classified as high-risk, it still requires explicit user confirmation.

### Skills and MCP

The skill registry stores local skill paths and trust state. Trusted enabled skills can inject their `SKILL.md` content into model context. Untrusted skills expose only name and path metadata until the user explicitly trusts them.

MCP servers are stored in the local registry and launched from parsed argv, not through a shell. Server commands containing shell control characters are rejected. MCP tools can be inspected, called, edited, deleted, and cleared from the app.

MCP tool calls use the same permission model as local actions. Read-only or low-risk tools may be remembered for a specific server/tool pair, while high-risk tools always require confirmation. Tool output that contains images, text resources, or audio is converted into chat-visible content where possible.

MCP command metadata sent to the model is redacted for API keys, bearer tokens, passwords, secrets, and common `--token value` style arguments.

## Privacy

afuOS is designed as a local-first desktop app. Local actions, conversation history, image attachment metadata, logs, permission rules, and memory data are stored on the user's machine in the local SQLite database. Model requests are sent only to the provider endpoints configured by the user.

Logs redact bearer tokens, API keys, passwords, secrets, and query-string credentials. Clipboard, note, and reminder contents are hidden in logs. Shell logs summarize the executable instead of storing the full command line, and MCP logs store the server/tool target without raw arguments.

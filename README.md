# afuOS

afuOS is a lightweight macOS desktop assistant built with Tauri, Rust, React, and TypeScript.

It provides a compact floating interface for text and voice interaction, model-backed chat, local desktop actions, speech playback, conversation history, execution logs, and user-managed memory.

## Features

- Floating assistant window with global shortcut wake and hide.
- OpenAI-compatible chat streaming.
- Multiple model profiles for text, vision, speech synthesis, and speech recognition.
- macOS native speech recognition or model-based speech recognition.
- Optional text-to-speech replies.
- Local actions for opening apps, URLs, files, folders, notes, reminders, clipboard text, and confirmed shell commands.
- Confirmation cards for higher-risk actions.
- Local SQLite history, execution logs, and memory records.
- Editable memory and assistant profile files.
- API keys stored through macOS Keychain instead of plaintext config files.

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

Build the macOS app bundle:

```bash
npm run tauri -- build --bundles app
```

The app bundle is generated at:

```text
src-tauri/target/release/bundle/macos/afuos.app
```

## Configuration

Model settings are configured inside the app. API keys are saved in macOS Keychain. The local config file stores model metadata and user preferences, but does not persist model API keys in plaintext.

## Privacy

afuOS is designed as a local-first desktop app. Local actions, history, logs, and memory data are stored on the user's machine. Model requests are sent only to the provider endpoints configured by the user.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AppConfig,
  ChatMessage,
  ConversationSnapshot,
  ExecutionLog,
  LocalActionRequest,
  LocalActionResponse,
  MemoryItem,
  ModelProfile
} from "./types";

const defaultTextProfile: ModelProfile = {
  id: "text-default",
  name: "OpenAI 文字模型",
  capabilities: ["text"],
  kind: "text",
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: ""
};

const defaultConfig: AppConfig = {
  general: {
    language: "zh-CN",
    shortcut: "Cmd+Shift+Space",
    windowSize: "medium",
    hotwordEnabled: false
  },
  models: {
    text: {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: ""
    },
    profiles: [defaultTextProfile],
    selectedTextProfileId: "text-default",
    selectedVisionProfileId: "",
    selectedTtsProfileId: "",
    selectedSttProfileId: "",
    vision: {
      provider: "openai-compatible",
      baseUrl: "",
      model: "",
      apiKeyRef: ""
    },
    tts: {
      provider: "openai-compatible",
      baseUrl: "",
      voice: "alloy",
      apiKeyRef: ""
    }
  },
  voice: {
    pushToTalkEnabled: false,
    ttsEnabled: false,
    sttMode: "local",
    sttModel: "whisper-1",
    pushToTalkKey: "Space",
    pushToTalkMode: "hold",
    autoSendOnVoiceEnd: false
  },
  permissions: {
    allowShell: false,
    allowBrowserAutomation: false,
    blockedPaths: [],
    trustedSkills: []
  },
  memory: {
    enabled: true,
    maxLongTermMemories: 100,
    maxInjectedMemories: 10,
    maxRecentTurns: 12,
    summaryMaxChars: 800
  }
};

const mockStorageKey = "afuos.config";
const defaultSoulContent = `你是阿福，也可以叫 afu。
你运行在 afuos 这款 macOS 软件里，是用户的本地管家。

核心性格：
- 简短、可靠、少废话。
- 先帮助用户完成眼前任务，不主动炫耀能力。
- 不确定时直接澄清，不编造。
- 涉及高风险本地动作时，先说明影响并要求确认。
- 尊重用户的权限、禁区目录和长期偏好。

交互风格：
- 中文为主，除非用户切换语言或明确要求英文。
- 可以亲切，但不要油腻、夸张或过度拟人。
- 执行完成后给出清楚结果；失败时说明原因和下一步。
`;

export type MemoryFileKind = "memory" | "soul";

export interface MemoryFile {
  kind: MemoryFileKind;
  path: string;
  content: string;
}

export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export async function loadConfig(): Promise<AppConfig> {
  if (isTauriRuntime()) {
    return normalizeConfig(await invoke<AppConfig>("load_config"));
  }

  const saved = localStorage.getItem(mockStorageKey);
  return saved ? normalizeConfig(JSON.parse(saved)) : defaultConfig;
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  if (isTauriRuntime()) {
    return invoke<AppConfig>("save_config", { config });
  }

  localStorage.setItem(mockStorageKey, JSON.stringify(config));
  return config;
}

export async function validateShortcut(shortcut: string): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>("validate_shortcut", { shortcut });
  }

  const normalized = shortcut.trim() || defaultConfig.general.shortcut;
  if (!normalized.includes("+")) {
    throw new Error("快捷键需要包含修饰键，例如 Cmd+Shift+Space");
  }
  return normalized;
}

interface StreamPayload {
  requestId: string;
  content?: string | null;
}

interface SendChatStreamOptions {
  messages: ChatMessage[];
  requestId: string;
  reasoningMode?: "fast" | "thinking";
  onDelta: (chunk: string) => void;
}

export async function sendChatStream({
  messages,
  requestId,
  reasoningMode = "fast",
  onDelta
}: SendChatStreamOptions): Promise<void> {
  const payload = messages.map(({ role, content }) => ({ role, content }));

  if (isTauriRuntime()) {
    const unlistenDelta = await listen<StreamPayload>("assistant://chat-delta", (event) => {
      if (event.payload.requestId === requestId && event.payload.content) {
        onDelta(event.payload.content);
      }
    });
    const unlistenFinished = await listen<StreamPayload>("assistant://chat-finished", () => undefined);

    try {
      await invoke("send_chat_stream", { requestId, messages: payload, reasoningMode });
    } finally {
      unlistenDelta();
      unlistenFinished();
    }
    return;
  }

  const previewChunks = [
    "这是浏览器预览模式的模拟流式回复。",
    "运行 Tauri 桌面端后，",
    "会通过已保存的 OpenAI-compatible 配置调用云端模型，",
    "并把 SSE delta 逐块写入当前回复。"
  ];

  for (const chunk of previewChunks) {
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    onDelta(chunk);
  }
}

export async function classifyReasoningMode(text: string): Promise<"fast" | "thinking"> {
  if (!isTauriRuntime()) {
    return "fast";
  }

  const mode = await invoke<string>("classify_reasoning_mode_command", { text });
  return mode === "thinking" ? "thinking" : "fast";
}

export async function cancelChatStream(requestId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("cancel_chat_stream", { requestId });
  }
}

export async function planLocalAction(text: string): Promise<LocalActionRequest | null> {
  if (isTauriRuntime()) {
    return invoke<LocalActionRequest | null>("plan_local_action_command", { text });
  }
  return null;
}

export async function executeLocalAction(
  action: LocalActionRequest,
  confirmed = false
): Promise<LocalActionResponse> {
  if (isTauriRuntime()) {
    return invoke<LocalActionResponse>("execute_local_action_command", { action, confirmed });
  }

  if (action.actionType === "shell" && !confirmed) {
    return {
      status: "requiresConfirmation",
      message: "Shell 命令需要确认",
      action,
      confirmation: {
        title: action.title,
        description: "浏览器预览模式不会真正执行 Shell 命令。",
        riskLevel: "high",
        command: action.command,
        target: action.command
      }
    };
  }

  return {
    status: "completed",
    message: `浏览器预览模式：${action.title}`,
    action,
    log: null
  };
}

export async function listExecutionLogs(limit = 80): Promise<ExecutionLog[]> {
  if (isTauriRuntime()) {
    return invoke<ExecutionLog[]>("list_execution_logs_command", { limit });
  }
  return [];
}

interface SaveConversationPayload {
  id: string;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{
    id: string;
    role: ChatMessage["role"];
    content: string;
    createdAt: number;
  }>;
}

export async function saveConversation(conversation: SaveConversationPayload): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("save_conversation_command", { conversation });
  }
}

export async function listConversations(limit = 40): Promise<ConversationSnapshot[]> {
  if (isTauriRuntime()) {
    return invoke<ConversationSnapshot[]>("list_conversations_command", { limit });
  }
  return [];
}

export async function listMemories(): Promise<MemoryItem[]> {
  if (isTauriRuntime()) {
    return invoke<MemoryItem[]>("list_memories_command");
  }
  return JSON.parse(localStorage.getItem("afuos.memories") || "[]") as MemoryItem[];
}

export async function addMemory(content: string): Promise<MemoryItem> {
  if (isTauriRuntime()) {
    return invoke<MemoryItem>("add_memory_command", { content, source: "manual" });
  }
  const now = Date.now();
  const memory: MemoryItem = {
    id: crypto.randomUUID(),
    content,
    source: "manual",
    createdAt: now,
    updatedAt: now
  };
  const memories = await listMemories();
  localStorage.setItem("afuos.memories", JSON.stringify([memory, ...memories]));
  return memory;
}

export async function deleteMemory(id: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("delete_memory_command", { id });
    return;
  }
  const memories = await listMemories();
  localStorage.setItem("afuos.memories", JSON.stringify(memories.filter((memory) => memory.id !== id)));
}

export async function clearMemories(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("clear_memories_command");
    return;
  }
  localStorage.removeItem("afuos.memories");
}

export async function loadMemoryFile(kind: MemoryFileKind): Promise<MemoryFile> {
  if (isTauriRuntime()) {
    return invoke<MemoryFile>("read_memory_file_command", { kind });
  }

  const storageKey = `afuos.${kind}File`;
  const content = localStorage.getItem(storageKey) ?? (kind === "soul" ? defaultSoulContent : "");
  return {
    kind,
    path: `browser-preview:${kind}.md`,
    content
  };
}

export async function saveMemoryFile(kind: MemoryFileKind, content: string): Promise<MemoryFile> {
  if (isTauriRuntime()) {
    return invoke<MemoryFile>("write_memory_file_command", { kind, content });
  }

  localStorage.setItem(`afuos.${kind}File`, content);
  return {
    kind,
    path: `browser-preview:${kind}.md`,
    content
  };
}

export interface TtsAudioResponse {
  mimeType: string;
  base64Audio: string;
}

export async function synthesizeSpeech(input: string): Promise<TtsAudioResponse> {
  if (isTauriRuntime()) {
    return invoke<TtsAudioResponse>("synthesize_speech_command", { input });
  }
  throw new Error("cloud_tts_requires_tauri_runtime");
}

export async function transcribeSpeech(audio: Blob): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("cloud_stt_requires_tauri_runtime");
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("audio_read_failed"));
    reader.readAsDataURL(audio);
  });
  const [meta, base64Audio] = dataUrl.split(",", 2);
  const mimeType = audio.type || meta.match(/^data:(.*);base64$/)?.[1] || "audio/webm";
  return invoke<string>("transcribe_speech_command", { base64Audio, mimeType });
}

export async function toggleAssistantWindow() {
  if (isTauriRuntime()) {
    await invoke("toggle_assistant_window");
  }
}

export async function hideAssistantWindow() {
  if (isTauriRuntime()) {
    await invoke("hide_assistant_window");
  }
}

export async function startWindowDrag(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  try {
    await getCurrentWindow().startDragging();
  } catch {
    await invoke("start_window_drag");
  }
}

export async function onAssistantWakeup(callback: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  return listen("assistant://wakeup", callback);
}

export async function onOpenSettings(callback: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  return listen("assistant://open-settings", callback);
}

function normalizeConfig(config: AppConfig): AppConfig {
  const legacyTextProfile: ModelProfile = {
    ...defaultTextProfile,
    provider: config.models?.text?.provider || defaultTextProfile.provider,
    baseUrl: config.models?.text?.baseUrl || defaultTextProfile.baseUrl,
    model: config.models?.text?.model || defaultTextProfile.model,
    apiKey: config.models?.text?.apiKey || ""
  };
  const profiles = (config.models?.profiles?.length ? config.models.profiles : [legacyTextProfile]).map((profile) => {
    const legacyKind = profile.kind || "text";
    const capabilities =
      Array.isArray(profile.capabilities) && profile.capabilities.length > 0 ? profile.capabilities : [legacyKind];

    return {
      ...profile,
      kind: capabilities[0] || legacyKind,
      capabilities,
      apiKey: profile.apiKey || ""
    };
  });
  const selectedTextProfileId =
    config.models?.selectedTextProfileId || profiles.find((profile) => profile.capabilities.includes("text"))?.id || "";
  const selectedSttProfileId =
    config.models?.selectedSttProfileId || profiles.find((profile) => profile.capabilities.includes("stt"))?.id || "";

  return {
    ...defaultConfig,
    ...config,
    general: {
      ...defaultConfig.general,
      ...config.general,
      language: config.general?.language === "en-US" ? "en-US" : "zh-CN"
    },
    models: {
      ...defaultConfig.models,
      ...config.models,
      profiles,
      selectedTextProfileId,
      selectedVisionProfileId: config.models?.selectedVisionProfileId || "",
      selectedTtsProfileId: config.models?.selectedTtsProfileId || "",
      selectedSttProfileId,
      text: { ...defaultConfig.models.text, ...config.models?.text },
      vision: { ...defaultConfig.models.vision, ...config.models?.vision },
      tts: {
        ...defaultConfig.models.tts,
        ...config.models?.tts,
        voice:
          !config.models?.tts?.voice || config.models.tts.voice === "default" ? "alloy" : config.models.tts.voice
      }
    },
    voice: {
      ...defaultConfig.voice,
      ...config.voice,
      sttMode: config.voice?.sttMode === "model" ? "model" : "local",
      sttModel: config.voice?.sttModel || "whisper-1",
      pushToTalkMode: config.voice?.pushToTalkMode === "toggle" ? "toggle" : "hold",
      pushToTalkKey: config.voice?.pushToTalkKey || "Space",
      autoSendOnVoiceEnd: Boolean(config.voice?.autoSendOnVoiceEnd)
    },
    permissions: { ...defaultConfig.permissions, ...config.permissions },
    memory: { ...defaultConfig.memory, ...config.memory }
  };
}

import {
  ArrowLeft,
  Bell,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Command,
  FileText,
  History,
  KeyRound,
  Mic,
  Minus,
  Plus,
  Play,
  Send,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Volume2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addMemory,
  cancelChatStream,
  classifyReasoningMode,
  clearMemories,
  deleteMemory,
  executeLocalAction,
  hideAssistantWindow,
  listConversations,
  listExecutionLogs,
  listMemories,
  loadMemoryFile,
  loadConfig,
  onOpenSettings,
  onAssistantWakeup,
  planLocalAction,
  saveMemoryFile,
  saveConfig,
  saveConversation,
  sendChatStream,
  startWindowDrag,
  synthesizeSpeech,
  transcribeSpeech,
  validateShortcut
} from "./tauri";
import type { MemoryFileKind } from "./tauri";
import type {
  AppConfig,
  AssistantStatus,
  ChatMessage,
  ExecutionLog,
  LocalActionRequest,
  MemoryItem,
  ModelProfile,
  ModelProfileKind
} from "./types";

const fallbackSoulPrompt =
  "你是阿福，也可以叫 afu。你运行在 afuos 这款 macOS 软件里，是用户的本地管家。回答简短、可靠、少废话。涉及高风险本地动作时先说明影响并要求确认。";

const statusCopy: Record<AssistantStatus, string> = {
  idle: "待命",
  listening: "聆听",
  thinking: "思考",
  speaking: "回复",
  executing: "执行",
  confirming: "确认",
  error: "错误"
};

const settingsSections = [
  { id: "general", icon: Command },
  { id: "models", icon: Brain },
  { id: "speech", icon: Mic },
  { id: "sound", icon: Volume2 },
  { id: "permissions", icon: Shield },
  { id: "skills", icon: Sparkles },
  { id: "mcp", icon: Terminal },
  { id: "history", icon: History },
  { id: "logs", icon: FileText },
  { id: "memory", icon: Bot }
] as const;

type SettingsSectionId = (typeof settingsSections)[number]["id"];
type Language = AppConfig["general"]["language"];

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly results: SpeechRecognitionResultList & {
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  readonly error?: string;
  readonly type?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface SpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface ChatSession {
  id: string;
  title: string;
  summary: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ConversationState {
  activeSessionId: string;
  messages: ChatMessage[];
  sessions: ChatSession[];
}

interface PendingConfirmation {
  action: LocalActionRequest;
  assistantMessageId: string;
  title: string;
  description: string;
  command: string;
  target: string;
  riskLevel: string;
}

interface SkillEntry {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
}

interface McpEntry {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
}

const conversationsStorageKey = "afuos.conversations";
const lastActivityStorageKey = "afuos.lastActivityAt";
const skillsStorageKey = "afuos.skills";
const mcpStorageKey = "afuos.mcpServers";
const autoNewConversationAfterMs = 60 * 60 * 1000;
const wakeSpeechSilenceTimeoutMs = 3000;
const modelSpeechSilenceTimeoutMs = 3000;
const speechActivityPollMs = 180;
const speechActivityRmsThreshold = 5;
const defaultRecentTurns = 12;
const defaultSummaryMaxChars = 800;

async function convertAudioBlobToWav(blob: Blob): Promise<Blob> {
  const audioContextConstructor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!audioContextConstructor) {
    return blob;
  }

  const audioContext = new audioContextConstructor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    return new Blob([encodeWav(audioBuffer)], { type: "audio/wav" });
  } catch {
    return blob;
  } finally {
    void audioContext.close();
  }
}

function encodeWav(audioBuffer: AudioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const sampleCount = audioBuffer.length;
  const byteRate = sampleRate * channelCount * 2;
  const blockAlign = channelCount * 2;
  const buffer = new ArrayBuffer(44 + sampleCount * blockAlign);
  const view = new DataView(buffer);
  let offset = 0;

  const writeString = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index));
      offset += 1;
    }
  };

  writeString("RIFF");
  view.setUint32(offset, 36 + sampleCount * blockAlign, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channelCount, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, byteRate, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, sampleCount * blockAlign, true);
  offset += 4;

  const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index));
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channelIndex][sampleIndex]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return buffer;
}

const uiCopy = {
  "zh-CN": {
    status: statusCopy,
    nav: {
      general: "通用",
      models: "模型",
      speech: "语音识别",
      sound: "声音",
      permissions: "权限",
      skills: "技能",
      mcp: "MCP",
      history: "历史",
      logs: "日志",
      memory: "记忆"
    },
    activate: "唤醒阿福",
    openSettings: "打开设置",
    hideWindow: "隐藏窗口",
    assistantAria: "阿福助手",
    settingsAria: "阿福设置",
    closeSettings: "关闭设置",
    assistantName: "阿福",
    emptyTitle: "阿福在这里",
    emptyCopy: "按下 Cmd Shift Space 唤醒后直接说话，也可以点击输入。",
    inputPlaceholder: "问阿福...",
    pushToTalk: "按住说话",
    roles: { user: "你", assistant: "阿福" },
    newConversation: "新对话",
    previousConversation: "上一次",
    noPreviousConversation: "暂无上一次对话",
    continueConversation: "继续",
    historyEmptyTitle: "还没有历史对话",
    historyEmptyCopy: "开始一次对话后，它会出现在这里。",
    missingApiReply: "还没有配置模型 API Key。打开设置里的模型后保存即可。",
    chatFailurePrefix: "模型调用失败：",
    configureApiKey: "配置模型 API Key",
    viewModelConfig: "查看模型配置",
    viewSpeechConfig: "查看语音识别设置",
    viewSoundConfig: "查看声音设置",
    settings: "设置",
    revert: "还原",
    save: "保存",
    saved: "已保存",
    addModel: "添加新模型",
    createSttProfile: "创建语音识别模型",
    allowOnce: "允许一次",
    cancel: "取消",
    confirmationTitle: "需要确认",
    noLogsTitle: "还没有执行日志",
    noLogsCopy: "打开应用、复制文本或运行命令后，记录会显示在这里。",
    noFilteredLogsTitle: "没有匹配的日志",
    noFilteredLogsCopy: "换个关键词，或调整状态和风险筛选。",
    logSearchPlaceholder: "搜索标题、类型、目标或原因...",
    allStatuses: "全部状态",
    allRisks: "全部风险",
    addMemory: "添加记忆",
    clearMemory: "清空记忆",
    memoryFileTitle: "记忆文件",
    soulFileTitle: "灵魂文件",
    saveMemoryFile: "保存文件",
    resetFileDraft: "还原文件",
    confirmFileSaveTitle: "确认修改文件",
    confirmFileSaveCopy: "这会写入本地文件，并影响后续对话的长期记忆或阿福人格。",
    confirmSaveFile: "确认写入",
    memoryInputPlaceholder: "写下阿福应该长期记住的偏好...",
    noMemoriesTitle: "还没有记忆",
    noMemoriesCopy: "添加稳定偏好后，后续对话可以注入这些信息。",
    addSkill: "添加技能",
    addMcp: "添加 MCP",
    skillPathPlaceholder: "本地 Skill 文件夹路径",
    mcpCommandPlaceholder: "启动命令，例如 npx -y @modelcontextprotocol/server-filesystem",
    testStt: "测试语音识别",
    testTts: "测试 TTS",
    stopVoice: "停止",
    captureGlobalShortcut: "点击后按一个主键",
    capturingGlobalShortcut: "现在按下主键",
    capturePushToTalkKey: "点击后按一个键",
    capturingPushToTalkKey: "现在按下要绑定的键",
    sttListening: "正在听，请说一句话...",
    sttUnsupported: "当前环境不支持所选语音识别方式。",
    sttPermissionDenied: "语音识别权限被拒绝。请到 macOS 系统设置 > 隐私与安全性 > 麦克风和语音识别，允许 afuos 后重启应用。",
    sttNoSpeech: "3 秒内没有识别到语音。请检查麦克风/语音识别权限，或靠近麦克风再试一次。",
    sttNoProfileCopy: "大模型语音识别需要一个带语音识别能力的模型配置。",
    sttFailed: "语音识别失败：",
    sttResultPrefix: "识别结果：",
    ttsUnsupported: "当前环境不支持语音播放。",
    ttsPlaying: "正在播放测试语音...",
    ttsFinished: "TTS 测试播放完成。",
    ttsFailed: "TTS 播放失败：",
    labels: {
      language: "语言",
      globalShortcut: "全局快捷键",
      windowSize: "窗口大小",
      hotwordWakeup: "热词唤醒",
      profileName: "配置名称",
      profileKind: "模型能力",
      textModelSelect: "文字模型",
      visionModelSelect: "多模态模型",
      ttsModelSelect: "语音模型",
      sttModelSelect: "语音识别模型",
      sttMode: "识别方式",
      noModelSelected: "不使用",
      provider: "服务商",
      apiBaseUrl: "API 地址",
      model: "模型名",
      apiKey: "API Key",
      voice: "声音",
      pushToTalk: "按住说话",
      sttModel: "语音识别模型",
      ttsReplies: "语音回复",
      autoSendOnVoiceEnd: "语音结束自动发送",
      pushToTalkKey: "说话按键",
      pushToTalkMode: "触发方式",
      allowShell: "允许 Shell",
      browserAutomation: "浏览器自动化",
      blockedPaths: "阻止访问路径",
      memoryEnabled: "启用记忆",
      recentTurns: "最近轮数",
      summaryChars: "摘要字符数",
      longTermMemories: "长期记忆数"
    },
    options: {
      chinese: "中文",
      english: "English",
      small: "小",
      medium: "中",
      large: "大"
    },
    modelKinds: {
      text: "文字",
      vision: "多模态",
      tts: "语音",
      stt: "语音识别"
    },
    sttModes: {
      local: "本地语音识别",
      model: "大模型语音识别"
    },
    voiceModes: {
      hold: "一直按住说话",
      toggle: "按一下开始，再按一下结束"
    },
    placeholders: {
      skills: {
        title: "本地技能注册表",
        copy: "管理本地技能入口和启用状态。"
      },
      mcp: {
        title: "MCP 配置",
        copy: "管理外部 MCP 服务的命令和启用状态。"
      },
      history: {
        title: "对话历史",
        copy: "本地保存的对话会显示在这里。"
      },
      logs: {
        title: "执行日志",
        copy: "工具和权限日志会显示在这里，不记录 API Key 或敏感文件内容。"
      }
    }
  },
  "en-US": {
    status: {
      idle: "Idle",
      listening: "Listening",
      thinking: "Thinking",
      speaking: "Replying",
      executing: "Executing",
      confirming: "Confirming",
      error: "Error"
    },
    nav: {
      general: "General",
      models: "Models",
      speech: "Speech recognition",
      sound: "Sound",
      permissions: "Permissions",
      skills: "Skills",
      mcp: "MCP",
      history: "History",
      logs: "Logs",
      memory: "Memory"
    },
    activate: "Activate afu",
    openSettings: "Open settings",
    hideWindow: "Hide window",
    assistantAria: "afu assistant",
    settingsAria: "afuos settings",
    closeSettings: "Close settings",
    assistantName: "afu",
    emptyTitle: "afu is here",
    emptyCopy: "Press Cmd Shift Space to wake afu and speak, or click to type.",
    inputPlaceholder: "Ask afu...",
    pushToTalk: "Push to talk",
    roles: { user: "You", assistant: "afu" },
    newConversation: "New chat",
    previousConversation: "Previous",
    noPreviousConversation: "No previous chat",
    continueConversation: "Continue",
    historyEmptyTitle: "No conversation history yet",
    historyEmptyCopy: "Start a chat and it will appear here.",
    missingApiReply: "No model API key is configured yet. Open Models in settings, then save.",
    chatFailurePrefix: "Model call failed: ",
    configureApiKey: "Configure model API key",
    viewModelConfig: "View model config",
    viewSpeechConfig: "View speech settings",
    viewSoundConfig: "View sound settings",
    settings: "Settings",
    revert: "Revert",
    save: "Save",
    saved: "Saved",
    addModel: "Add model",
    createSttProfile: "Create STT model",
    allowOnce: "Allow once",
    cancel: "Cancel",
    confirmationTitle: "Confirmation required",
    noLogsTitle: "No execution logs yet",
    noLogsCopy: "Open apps, copy text, or run commands and the records will appear here.",
    noFilteredLogsTitle: "No matching logs",
    noFilteredLogsCopy: "Try another keyword, status, or risk filter.",
    logSearchPlaceholder: "Search title, type, target, or reason...",
    allStatuses: "All statuses",
    allRisks: "All risks",
    addMemory: "Add memory",
    clearMemory: "Clear memory",
    memoryFileTitle: "Memory file",
    soulFileTitle: "Soul file",
    saveMemoryFile: "Save file",
    resetFileDraft: "Revert file",
    confirmFileSaveTitle: "Confirm file change",
    confirmFileSaveCopy: "This writes to a local file and changes future long-term memory or afu's personality.",
    confirmSaveFile: "Write file",
    memoryInputPlaceholder: "Write a stable preference afu should remember...",
    noMemoriesTitle: "No memories yet",
    noMemoriesCopy: "Add stable preferences and future chats can use them.",
    addSkill: "Add skill",
    addMcp: "Add MCP",
    skillPathPlaceholder: "Local Skill folder path",
    mcpCommandPlaceholder: "Launch command, e.g. npx -y @modelcontextprotocol/server-filesystem",
    testStt: "Test speech recognition",
    testTts: "Test TTS",
    stopVoice: "Stop",
    captureGlobalShortcut: "Click, then press one key",
    capturingGlobalShortcut: "Press the main key",
    capturePushToTalkKey: "Click, then press a key",
    capturingPushToTalkKey: "Press the key to bind",
    sttListening: "Listening. Say one sentence...",
    sttUnsupported: "This runtime does not support the selected speech recognition mode.",
    sttPermissionDenied: "Speech recognition permission was denied. Allow afuos in macOS System Settings > Privacy & Security > Microphone and Speech Recognition, then restart the app.",
    sttNoSpeech: "No speech was recognized within 3 seconds. Check microphone/speech recognition permission or move closer to the microphone.",
    sttNoProfileCopy: "Model speech recognition needs a profile with speech recognition capability.",
    sttFailed: "Speech recognition failed: ",
    sttResultPrefix: "Recognized: ",
    ttsUnsupported: "This runtime does not support speech playback.",
    ttsPlaying: "Playing test speech...",
    ttsFinished: "TTS test playback finished.",
    ttsFailed: "TTS playback failed: ",
    labels: {
      language: "Language",
      globalShortcut: "Global shortcut",
      windowSize: "Window size",
      hotwordWakeup: "Hotword wakeup",
      profileName: "Profile name",
      profileKind: "Model capabilities",
      textModelSelect: "Text model",
      visionModelSelect: "Vision model",
      ttsModelSelect: "Speech model",
      sttModelSelect: "Speech recognition model",
      sttMode: "Recognition mode",
      noModelSelected: "None",
      provider: "Provider",
      apiBaseUrl: "API Base URL",
      model: "Model",
      apiKey: "API Key",
      voice: "Voice",
      pushToTalk: "Push to talk",
      sttModel: "Speech recognition model",
      ttsReplies: "TTS replies",
      autoSendOnVoiceEnd: "Auto-send after voice",
      pushToTalkKey: "Talk key",
      pushToTalkMode: "Trigger mode",
      allowShell: "Allow shell",
      browserAutomation: "Browser automation",
      blockedPaths: "Blocked paths",
      memoryEnabled: "Memory enabled",
      recentTurns: "Recent turns",
      summaryChars: "Summary chars",
      longTermMemories: "Long-term memories"
    },
    options: {
      chinese: "中文",
      english: "English",
      small: "Small",
      medium: "Medium",
      large: "Large"
    },
    modelKinds: {
      text: "Text",
      vision: "Vision",
      tts: "Speech",
      stt: "Speech recognition"
    },
    sttModes: {
      local: "Local speech recognition",
      model: "Model speech recognition"
    },
    voiceModes: {
      hold: "Hold to talk",
      toggle: "Press once to start, press again to stop"
    },
    placeholders: {
      skills: {
        title: "Local skill registry",
        copy: "Manage local skill entries and enabled state."
      },
      mcp: {
        title: "MCP configurations",
        copy: "Manage external MCP service commands and enabled state."
      },
      history: {
        title: "Conversation history",
        copy: "Saved local conversations appear here."
      },
      logs: {
        title: "Execution logs",
        copy: "Tool and permission logs will appear here without API keys or sensitive file contents."
      }
    }
  }
} as const;

function createMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content
  };
}

function createSession(messages: ChatMessage[] = []): ChatSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: deriveSessionTitle(messages),
    summary: "",
    messages,
    createdAt: now,
    updatedAt: now
  };
}

function deriveSessionTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content.trim();
  if (!firstUserMessage) {
    return "新对话";
  }

  return firstUserMessage.length > 22 ? `${firstUserMessage.slice(0, 22)}...` : firstUserMessage;
}

function normalizeInlineText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 1) {
    return value.slice(0, Math.max(0, maxChars));
  }

  return `${value.slice(0, maxChars - 1)}…`;
}

function createSystemPrompt(soulContent: string): ChatMessage {
  return {
    id: "system",
    role: "system",
    content: soulContent.trim() || fallbackSoulPrompt
  };
}

function recentMessageLimit(config?: AppConfig["memory"]) {
  const recentTurns = Math.max(1, config?.maxRecentTurns || defaultRecentTurns);
  return recentTurns * 2;
}

function createConversationSummary(messages: ChatMessage[], config?: AppConfig["memory"]) {
  if (!config?.enabled) {
    return "";
  }

  const messageLimit = recentMessageLimit(config);
  if (messages.length <= messageLimit) {
    return "";
  }

  const summaryMaxChars = Math.max(120, config.summaryMaxChars || defaultSummaryMaxChars);
  const olderMessages = messages.slice(0, -messageLimit);
  const lines = olderMessages
    .map((message) => {
      const label = message.role === "user" ? "用户" : message.role === "assistant" ? "阿福" : "系统";
      const content = normalizeInlineText(message.content);
      return content ? `${label}: ${truncateText(content, 180)}` : "";
    })
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  const summary = `已压缩 ${olderMessages.length} 条较早消息：\n${lines.join("\n")}`;
  return truncateText(summary, summaryMaxChars);
}

function buildModelMessages(
  config: AppConfig,
  memories: MemoryItem[],
  soulContent: string,
  memoryFileContent: string,
  sessionSummary: string,
  messages: ChatMessage[]
): ChatMessage[] {
  if (!config.memory.enabled) {
    return [createSystemPrompt(soulContent), ...messages];
  }

  const memoryConfig = config.memory;
  const recentMessages = messages.slice(-recentMessageLimit(memoryConfig));
  const contextMessages: ChatMessage[] = [createSystemPrompt(soulContent)];
  const summary = sessionSummary || createConversationSummary(messages, memoryConfig);

  if (summary.trim()) {
    contextMessages.push({
      id: "conversation-summary",
      role: "system",
      content: `以下是较早对话摘要，只用于延续上下文，不要逐字复述：\n${summary}`
    });
  }

  const injectedMemories = memories
    .slice(0, Math.max(0, memoryConfig.maxInjectedMemories))
    .map((memory) => truncateText(normalizeInlineText(memory.content), 200))
    .filter(Boolean);

  if (injectedMemories.length > 0) {
    contextMessages.push({
      id: "long-term-memory",
      role: "system",
      content: `以下是用户明确保存的长期偏好。不要把权限规则或敏感信息当作记忆：\n- ${injectedMemories.join("\n- ")}`
    });
  }

  if (memoryFileContent.trim()) {
    contextMessages.push({
      id: "memory-file",
      role: "system",
      content: `以下是用户在设置中维护的记忆文件。只把它当作长期上下文，不要逐字复述：\n${truncateText(memoryFileContent.trim(), 4000)}`
    });
  }

  return [...contextMessages, ...recentMessages];
}

function createInitialConversationState(): ConversationState {
  const saved = localStorage.getItem(conversationsStorageKey);
  if (saved) {
    try {
      const sessions = (JSON.parse(saved) as ChatSession[])
        .filter((session) => session.id && Array.isArray(session.messages))
        .map((session) => ({
          ...session,
          summary: session.summary || ""
        }))
        .sort((first, second) => second.updatedAt - first.updatedAt);
      if (sessions.length > 0) {
        return {
          activeSessionId: sessions[0].id,
          messages: sessions[0].messages,
          sessions
        };
      }
    } catch {
      localStorage.removeItem(conversationsStorageKey);
    }
  }

  const session = createSession();
  return {
    activeSessionId: session.id,
    messages: [],
    sessions: [session]
  };
}

function persistSessions(sessions: ChatSession[]) {
  localStorage.setItem(conversationsStorageKey, JSON.stringify(sessions.slice(0, 40)));
}

function markConversationActivity() {
  localStorage.setItem(lastActivityStorageKey, String(Date.now()));
}

function selectedProfile(config: AppConfig, kind: ModelProfileKind) {
  const selectedId =
    kind === "text"
      ? config.models.selectedTextProfileId
      : kind === "vision"
        ? config.models.selectedVisionProfileId
        : kind === "tts"
          ? config.models.selectedTtsProfileId
          : config.models.selectedSttProfileId;

  return config.models.profiles.find((profile) => profile.id === selectedId && profile.capabilities.includes(kind));
}

function createModelProfile(kind: ModelProfileKind = "text"): ModelProfile {
  const now = Date.now();
  return {
    id: `${kind}-${now}`,
    name: "新模型",
    capabilities: [kind],
    kind,
    provider: "openai-compatible",
    baseUrl: kind === "text" ? "https://api.openai.com/v1" : "",
    model: "",
    apiKey: "",
    voice: kind === "tts" ? "alloy" : ""
  };
}

function keyboardCodeLabel(code: string) {
  if (!code) {
    return "";
  }

  if (code === "Space") {
    return "Space";
  }

  if (code.startsWith("Key")) {
    return code.slice(3);
  }

  if (code.startsWith("Digit")) {
    return code.slice(5);
  }

  return code.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function shortcutDisplayLabel(shortcut: string) {
  return shortcut
    .trim()
    .split("+")
    .map((part) => {
      const normalized = normalizeShortcutPart(part);
      if (normalized === "Cmd") {
        return "⌘";
      }
      if (normalized === "Alt") {
        return "⌥";
      }
      if (normalized === "Ctrl") {
        return "⌃";
      }
      if (normalized === "Shift") {
        return "⇧";
      }
      return keyboardCodeLabel(normalized);
    })
    .join(" ");
}

const macShortcutModifierOrder = ["Cmd", "Alt", "Ctrl", "Shift"] as const;

type MacShortcutModifier = (typeof macShortcutModifierOrder)[number];

const macShortcutModifierLabels: Record<MacShortcutModifier, string> = {
  Cmd: "Command",
  Alt: "Option",
  Ctrl: "Control",
  Shift: "Shift"
};

function normalizeShortcutPart(part: string) {
  const normalized = part.trim().toLowerCase();
  if (normalized === "command" || normalized === "cmd" || normalized === "meta") {
    return "Cmd";
  }
  if (normalized === "option" || normalized === "alt") {
    return "Alt";
  }
  if (normalized === "control" || normalized === "ctrl") {
    return "Ctrl";
  }
  if (normalized === "shift") {
    return "Shift";
  }
  return part.trim();
}

function parseMacShortcut(shortcut: string) {
  const parts = shortcut
    .split("+")
    .map(normalizeShortcutPart)
    .filter(Boolean);
  const modifiers = new Set<MacShortcutModifier>();
  let key = "Space";

  for (const part of parts) {
    if ((macShortcutModifierOrder as readonly string[]).includes(part)) {
      modifiers.add(part as MacShortcutModifier);
    } else {
      key = part;
    }
  }

  if (modifiers.size === 0) {
    modifiers.add("Cmd");
    modifiers.add("Shift");
  }

  return { modifiers, key };
}

function buildMacShortcut(modifiers: Set<MacShortcutModifier>, key: string) {
  const activeModifiers = macShortcutModifierOrder.filter((modifier) => modifiers.has(modifier));
  const normalizedKey = key.trim() || "Space";
  return [...activeModifiers, normalizedKey].join("+");
}

function shortcutWithModifier(shortcut: string, modifier: MacShortcutModifier, enabled: boolean) {
  const parsed = parseMacShortcut(shortcut);
  if (enabled) {
    parsed.modifiers.add(modifier);
  } else if (parsed.modifiers.size > 1) {
    parsed.modifiers.delete(modifier);
  }
  return buildMacShortcut(parsed.modifiers, parsed.key);
}

function shortcutWithKey(shortcut: string, key: string) {
  const parsed = parseMacShortcut(shortcut);
  return buildMacShortcut(parsed.modifiers, key);
}

function isModifierKeyboardEvent(event: KeyboardEvent) {
  return ["Alt", "Control", "Meta", "Shift"].includes(event.key);
}

function shortcutKeyFromEvent(event: KeyboardEvent) {
  const code = event.code || event.key;
  if (code === "Space") {
    return "Space";
  }
  if (code.startsWith("Key")) {
    return code.slice(3);
  }
  if (code.startsWith("Digit")) {
    return code.slice(5);
  }
  return event.key.length === 1 ? event.key.toUpperCase() : code;
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isWindowDragBlockedTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("button, input, textarea, select, a, [contenteditable='true'], [data-no-window-drag]"));
}

function normalizedSpeechText(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function settingsTargetForError(error: string): SettingsSectionId {
  const normalized = error.toLowerCase();
  if (
    normalized.includes("语音识别") ||
    normalized.includes("speech recognition") ||
    normalized.includes("stt") ||
    normalized.includes("native_speech") ||
    normalized.includes("media_recorder") ||
    normalized.includes("no-speech") ||
    normalized.includes("not-allowed") ||
    normalized.includes("permission denied")
  ) {
    return "speech";
  }

  if (normalized.includes("tts") || normalized.includes("语音播放") || normalized.includes("声音")) {
    return "sound";
  }

  return "models";
}

function errorActionCopy(error: string, copy: (typeof uiCopy)[Language]) {
  if (error === "missing_api_key") {
    return copy.configureApiKey;
  }

  const target = settingsTargetForError(error);
  if (target === "speech") {
    return copy.viewSpeechConfig;
  }
  if (target === "sound") {
    return copy.viewSoundConfig;
  }

  return copy.viewModelConfig;
}

function reasoningModeForInput(text: string): "fast" | "thinking" {
  const normalized = text.trim();
  if (normalized.length > 120) {
    return "thinking";
  }

  const thinkingMarkers = [
    "分析",
    "思考",
    "推理",
    "规划",
    "方案",
    "设计",
    "架构",
    "排查",
    "调试",
    "复杂",
    "对比",
    "为什么",
    "怎么实现",
    "帮我判断",
    "代码"
  ];

  return thinkingMarkers.some((marker) => normalized.includes(marker)) ? "thinking" : "fast";
}

function stripModelToolCalls(text: string) {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[\s\S]*?<\/function>/gi, "")
    .replace(/<tool_call>[\s\S]*$/gi, "")
    .replace(/<function=[\s\S]*$/gi, "")
    .trim();
}

function assistantTextForDisplay(text: string) {
  const stripped = stripModelToolCalls(text).replace(/\n{3,}/g, "\n\n").trim();
  if (stripped) {
    return stripped;
  }

  if (/<\s*(tool_call|function=)/i.test(text)) {
    return "这条回复包含未执行的工具调用，已隐藏。请直接告诉阿福要执行的动作。";
  }

  return text;
}

function speechTextFromAssistantText(text: string) {
  return stripModelToolCalls(text)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\b(run_command|run_apple_script|tool_call|function|parameter|timeout|script)\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function resolveReasoningMode(text: string): Promise<"fast" | "thinking"> {
  const localMode = reasoningModeForInput(text);
  if (localMode === "thinking") {
    return "thinking";
  }

  try {
    return await classifyReasoningMode(text);
  } catch {
    return "fast";
  }
}

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [draftConfig, setDraftConfig] = useState<AppConfig | null>(null);
  const [conversationState, setConversationState] = useState<ConversationState>(createInitialConversationState);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeSettings, setActiveSettings] = useState<SettingsSectionId>("general");
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>([]);
  const [logSearch, setLogSearch] = useState("");
  const [logStatusFilter, setLogStatusFilter] = useState("");
  const [logRiskFilter, setLogRiskFilter] = useState("");
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryFileContent, setMemoryFileContent] = useState("");
  const [memoryFileDraft, setMemoryFileDraft] = useState("");
  const [memoryFilePath, setMemoryFilePath] = useState("");
  const [soulFileContent, setSoulFileContent] = useState(fallbackSoulPrompt);
  const [soulFileDraft, setSoulFileDraft] = useState(fallbackSoulPrompt);
  const [soulFilePath, setSoulFilePath] = useState("");
  const [pendingMemoryFileSave, setPendingMemoryFileSave] = useState<MemoryFileKind | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [mcpServers, setMcpServers] = useState<McpEntry[]>([]);
  const [skillDraft, setSkillDraft] = useState("");
  const [mcpDraft, setMcpDraft] = useState("");
  const [sttTestResult, setSttTestResult] = useState("");
  const [ttsTestResult, setTtsTestResult] = useState("");
  const [speechProcessing, setSpeechProcessing] = useState(false);
  const [activeChatRequestId, setActiveChatRequestId] = useState("");
  const [capturingGlobalShortcut, setCapturingGlobalShortcut] = useState(false);
  const [capturingPushToTalkKey, setCapturingPushToTalkKey] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const statusRef = useRef(status);
  const conversationRef = useRef(conversationState);
  const configRef = useRef<AppConfig | null>(config);
  const draftConfigRef = useRef<AppConfig | null>(draftConfig);
  const capturingGlobalShortcutRef = useRef(capturingGlobalShortcut);
  const capturingPushToTalkKeyRef = useRef(capturingPushToTalkKey);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechSilenceTimerRef = useRef<number | undefined>();
  const speechActivityPollerRef = useRef<number | undefined>();
  const speechAudioContextRef = useRef<AudioContext | null>(null);
  const recognizedSpeechRef = useRef(false);
  const speechProcessingRef = useRef(false);
  const speechRequestIdRef = useRef(0);
  const cancelledSpeechRequestIdRef = useRef(0);
  const latestSpeechTranscriptRef = useRef("");
  const activeChatRequestIdRef = useRef("");
  const cancelledChatRequestIdRef = useRef("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const submittedSpeechTextRef = useRef("");
  const submittedSpeechAtRef = useRef(0);
  const micHoldActiveRef = useRef(false);
  const keyHoldActiveRef = useRef(false);
  const suppressNextMicClickRef = useRef(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    conversationRef.current = conversationState;
  }, [conversationState]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    draftConfigRef.current = draftConfig;
  }, [draftConfig]);

  useEffect(() => {
    capturingGlobalShortcutRef.current = capturingGlobalShortcut;
  }, [capturingGlobalShortcut]);

  useEffect(() => {
    capturingPushToTalkKeyRef.current = capturingPushToTalkKey;
  }, [capturingPushToTalkKey]);

  useEffect(() => {
    speechProcessingRef.current = speechProcessing;
  }, [speechProcessing]);

  useEffect(() => {
    activeChatRequestIdRef.current = activeChatRequestId;
  }, [activeChatRequestId]);

  function updateConversationState(updater: (current: ConversationState) => ConversationState) {
    setConversationState((current) => {
      const next = updater(current);
      persistSessions(next.sessions);
      syncActiveConversation(next);
      conversationRef.current = next;
      return next;
    });
  }

  function syncActiveConversation(state: ConversationState) {
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    if (!session || session.messages.length === 0) {
      return;
    }

    void saveConversation({
      id: session.id,
      title: session.title,
      summary: session.summary,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map((message, index) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: session.createdAt + index
      }))
    });
  }

  function updateActiveMessages(updater: (messages: ChatMessage[]) => ChatMessage[]) {
    updateConversationState((current) => {
      const messages = updater(current.messages);
      const now = Date.now();
      const sessions = current.sessions
        .map((session) =>
          session.id === current.activeSessionId
            ? {
                ...session,
                title: deriveSessionTitle(messages),
                summary: createConversationSummary(messages, config?.memory),
                messages,
                updatedAt: now
              }
            : session
        )
        .sort((first, second) => second.updatedAt - first.updatedAt);

      return { ...current, messages, sessions };
    });
    markConversationActivity();
  }

  function startNewConversation() {
    if (conversationRef.current.messages.length === 0) {
      setInput("");
      setError("");
      setIsExpanded(true);
      markConversationActivity();
      window.setTimeout(() => inputRef.current?.focus(), 80);
      return;
    }

    const session = createSession();
    updateConversationState((current) => ({
      activeSessionId: session.id,
      messages: [],
      sessions: [session, ...current.sessions].slice(0, 40)
    }));
    setInput("");
    setError("");
    setStatus((current) => (current === "error" ? "idle" : current));
    setIsExpanded(true);
    markConversationActivity();
    window.setTimeout(() => inputRef.current?.focus(), 80);
  }

  function resumeConversation(sessionId: string) {
    const session = conversationRef.current.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    updateConversationState((current) => ({
      ...current,
      activeSessionId: session.id,
      messages: session.messages
    }));
    setInput("");
    setError("");
    setSettingsOpen(false);
    setIsExpanded(true);
    markConversationActivity();
    window.setTimeout(() => inputRef.current?.focus(), 80);
  }

  function resumePreviousConversation() {
    const previous = conversationRef.current.sessions.find(
      (session) => session.id !== conversationRef.current.activeSessionId && session.messages.length > 0
    );
    if (previous) {
      resumeConversation(previous.id);
    }
  }

  function maybeStartNewConversationAfterIdle() {
    const lastActivityAt = Number(localStorage.getItem(lastActivityStorageKey) || 0);
    const hasActiveMessages = conversationRef.current.messages.length > 0;
    if (hasActiveMessages && lastActivityAt > 0 && Date.now() - lastActivityAt > autoNewConversationAfterMs) {
      startNewConversation();
      return;
    }

    markConversationActivity();
  }

  async function refreshExecutionLogs() {
    try {
      setExecutionLogs(await listExecutionLogs());
    } catch (logsError) {
      setError(String(logsError));
      setStatus("error");
    }
  }

  async function refreshMemories() {
    try {
      setMemories(await listMemories());
    } catch (memoryError) {
      setError(String(memoryError));
      setStatus("error");
    }
  }

  async function refreshMemoryFiles() {
    try {
      const [memoryFile, soulFile] = await Promise.all([loadMemoryFile("memory"), loadMemoryFile("soul")]);
      setMemoryFileContent(memoryFile.content);
      setMemoryFileDraft(memoryFile.content);
      setMemoryFilePath(memoryFile.path);
      setSoulFileContent(soulFile.content);
      setSoulFileDraft(soulFile.content);
      setSoulFilePath(soulFile.path);
    } catch (fileError) {
      setError(String(fileError));
      setStatus("error");
    }
  }

  async function confirmMemoryFileSave() {
    if (!pendingMemoryFileSave) {
      return;
    }

    const kind = pendingMemoryFileSave;
    const content = kind === "memory" ? memoryFileDraft : soulFileDraft;

    try {
      const saved = await saveMemoryFile(kind, content);
      if (kind === "memory") {
        setMemoryFileContent(saved.content);
        setMemoryFileDraft(saved.content);
        setMemoryFilePath(saved.path);
      } else {
        setSoulFileContent(saved.content);
        setSoulFileDraft(saved.content);
        setSoulFilePath(saved.path);
      }
      setPendingMemoryFileSave(null);
      setError("");
      setStatus((current) => (current === "error" ? "idle" : current));
    } catch (fileError) {
      setError(String(fileError));
      setStatus("error");
    }
  }

  function loadLocalRegistries() {
    try {
      setSkills(JSON.parse(localStorage.getItem(skillsStorageKey) || "[]") as SkillEntry[]);
      setMcpServers(JSON.parse(localStorage.getItem(mcpStorageKey) || "[]") as McpEntry[]);
    } catch {
      localStorage.removeItem(skillsStorageKey);
      localStorage.removeItem(mcpStorageKey);
    }
  }

  function updateSkills(next: SkillEntry[]) {
    setSkills(next);
    localStorage.setItem(skillsStorageKey, JSON.stringify(next));
  }

  function updateMcpServers(next: McpEntry[]) {
    setMcpServers(next);
    localStorage.setItem(mcpStorageKey, JSON.stringify(next));
  }

  function addSkillEntry() {
    const path = skillDraft.trim();
    if (!path) {
      return;
    }
    updateSkills([
      {
        id: crypto.randomUUID(),
        name: path.split("/").filter(Boolean).pop() || "Skill",
        path,
        enabled: true
      },
      ...skills
    ]);
    setSkillDraft("");
  }

  function addMcpEntry() {
    const command = mcpDraft.trim();
    if (!command) {
      return;
    }
    updateMcpServers([
      {
        id: crypto.randomUUID(),
        name: command.split(/\s+/)[0] || "MCP",
        command,
        enabled: true
      },
      ...mcpServers
    ]);
    setMcpDraft("");
  }

  function clearSpeechSilenceTimer() {
    if (speechSilenceTimerRef.current) {
      window.clearTimeout(speechSilenceTimerRef.current);
      speechSilenceTimerRef.current = undefined;
    }
  }

  function resetSpeechSilenceTimer(timeoutMs: number) {
    clearSpeechSilenceTimer();
    speechSilenceTimerRef.current = window.setTimeout(stopListening, timeoutMs);
  }

  function stopSpeechActivityMonitor() {
    if (speechActivityPollerRef.current) {
      window.clearInterval(speechActivityPollerRef.current);
      speechActivityPollerRef.current = undefined;
    }

    if (speechAudioContextRef.current) {
      void speechAudioContextRef.current.close();
      speechAudioContextRef.current = null;
    }
  }

  function startSpeechActivityMonitor(stream: MediaStream, timeoutMs: number) {
    stopSpeechActivityMonitor();
    resetSpeechSilenceTimer(timeoutMs);

    const audioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!audioContextConstructor) {
      return;
    }

    const audioContext = new audioContextConstructor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    speechAudioContextRef.current = audioContext;

    speechActivityPollerRef.current = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let squared = 0;
      for (const sample of samples) {
        const centered = sample - 128;
        squared += centered * centered;
      }
      const rms = Math.sqrt(squared / samples.length);
      if (rms >= speechActivityRmsThreshold) {
        resetSpeechSilenceTimer(timeoutMs);
      }
    }, speechActivityPollMs);
  }

  function markSubmittedSpeechText(text: string) {
    submittedSpeechTextRef.current = normalizedSpeechText(text);
    submittedSpeechAtRef.current = Date.now();
  }

  function shouldIgnoreSpeechTranscript(transcript: string) {
    const submittedText = submittedSpeechTextRef.current;
    if (!submittedText) {
      return false;
    }

    return Date.now() - submittedSpeechAtRef.current < 5000 && normalizedSpeechText(transcript) === submittedText;
  }

  function cancelSpeechProcessing() {
    cancelledSpeechRequestIdRef.current = speechRequestIdRef.current;
    setSpeechProcessing(false);
    stopListening();
    setStatus((current) => (current === "thinking" || current === "listening" ? "idle" : current));
  }

  function shouldAutoSendVoice(updateTestResult: boolean) {
    if (updateTestResult) {
      return false;
    }

    return Boolean((draftConfigRef.current ?? configRef.current)?.voice.autoSendOnVoiceEnd);
  }

  function scheduleVoiceAutoSend(updateTestResult: boolean, transcript: string) {
    if (!shouldAutoSendVoice(updateTestResult)) {
      return;
    }

    const text = transcript.trim();
    if (!text) {
      return;
    }

    window.setTimeout(() => {
      void handleSend(text);
    }, 80);
  }

  async function cancelModelResponse() {
    const requestId = activeChatRequestIdRef.current;
    if (!requestId) {
      stopTts();
      return;
    }

    cancelledChatRequestIdRef.current = requestId;
    activeChatRequestIdRef.current = "";
    setActiveChatRequestId("");
    setStatus("idle");
    stopTts();
    try {
      await cancelChatStream(requestId);
    } catch (cancelError) {
      setError(String(cancelError));
      setStatus("error");
    }
  }

  function stopListening() {
    clearSpeechSilenceTimer();
    stopSpeechActivityMonitor();
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }

    const recognition = speechRecognitionRef.current;

    if (recognition) {
      try {
        recognition.stop();
      } catch {
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        speechRecognitionRef.current = null;
        recognition.abort();
        setStatus((current) => (current === "listening" ? "idle" : current));
      }
      return;
    }

    setStatus((current) => (current === "listening" ? "idle" : current));
  }

  function stopTts() {
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.currentTime = 0;
      ttsAudioRef.current = null;
    }
    setStatus((current) => (current === "speaking" ? "idle" : current));
  }

  async function playTts(text: string): Promise<void> {
    const enabled = config?.voice.ttsEnabled;
    const speechText = speechTextFromAssistantText(text);
    if (!enabled || !speechText) {
      return;
    }

    try {
      const audio = await prepareCloudTtsAudio(speechText);
      await playPreparedAudio(audio);
    } catch (ttsError) {
      setError(`${copy.ttsFailed}${String(ttsError)}`);
      setStatus("idle");
    }
  }

  async function prepareCloudTtsAudio(text: string): Promise<HTMLAudioElement | null> {
    if (!text.trim()) {
      return null;
    }

    stopTts();
    setStatus("speaking");

    try {
      const audioResponse = await synthesizeSpeech(text);
      return new Audio(`data:${audioResponse.mimeType};base64,${audioResponse.base64Audio}`);
    } catch (ttsError) {
      setStatus("error");
      throw ttsError;
    }
  }

  async function playPreparedAudio(audio: HTMLAudioElement | null): Promise<void> {
    if (!audio) {
      setStatus("idle");
      return;
    }

    try {
      ttsAudioRef.current = audio;
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error(copy.ttsFailed));
        void audio.play().catch(reject);
      });
      setStatus("idle");
    } catch (ttsError) {
      setStatus("error");
      throw ttsError;
    } finally {
      ttsAudioRef.current = null;
    }
  }

  async function testTtsPlayback() {
    setTtsTestResult(copy.ttsPlaying);
    try {
      const audio = await prepareCloudTtsAudio(
        (draftConfig?.general.language ?? config?.general.language) === "en-US"
          ? "afu cloud voice test is connected."
          : "阿福云端语音测试已连通。"
      );
      await playPreparedAudio(audio);
      setTtsTestResult(copy.ttsFinished);
    } catch (ttsError) {
      setTtsTestResult(`${copy.ttsFailed}${String(ttsError)}`);
      setStatus("idle");
    }
  }

  function formatSttError(error: unknown) {
    const message = String(error);
    if (
      message.includes("not-allowed") ||
      message.includes("NotAllowedError") ||
      message.includes("Permission denied") ||
      message.includes("permission denied")
    ) {
      return `${copy.sttFailed}${copy.sttPermissionDenied}`;
    }

    if (message.includes("native_speech_unsupported") || message.includes("media_recorder_unsupported")) {
      return `${copy.sttFailed}${copy.sttUnsupported}`;
    }

    return `${copy.sttFailed}${message}`;
  }

  async function transcribeRecordedAudio(blob: Blob, updateTestResult: boolean) {
    const requestId = speechRequestIdRef.current + 1;
    speechRequestIdRef.current = requestId;
    cancelledSpeechRequestIdRef.current = 0;

    if (blob.size === 0) {
      if (updateTestResult) {
        setSttTestResult(copy.sttNoSpeech);
      }
      setSpeechProcessing(false);
      setStatus("idle");
      return;
    }

    setSpeechProcessing(true);
    setStatus("thinking");
    try {
      const speechAudio = await convertAudioBlobToWav(blob);
      const transcript = (await transcribeSpeech(speechAudio)).trim();
      if (cancelledSpeechRequestIdRef.current === requestId) {
        return;
      }

      if (!transcript) {
        if (updateTestResult) {
          setSttTestResult(copy.sttNoSpeech);
        }
        setSpeechProcessing(false);
        setStatus("idle");
        return;
      }

      if (shouldIgnoreSpeechTranscript(transcript)) {
        setSpeechProcessing(false);
        setStatus("idle");
        return;
      }

      recognizedSpeechRef.current = true;
      latestSpeechTranscriptRef.current = transcript;
      setInput(transcript);
      setIsExpanded(true);
      if (updateTestResult) {
        setSttTestResult(`${copy.sttResultPrefix}${transcript}`);
      }
      setSpeechProcessing(false);
      setStatus("idle");
      window.setTimeout(() => inputRef.current?.focus(), 40);
      scheduleVoiceAutoSend(updateTestResult, transcript);
    } catch (sttError) {
      if (cancelledSpeechRequestIdRef.current === requestId) {
        return;
      }

      setSpeechProcessing(false);
      setStatus("error");
      const message = `${copy.sttFailed}${String(sttError)}`;
      if (updateTestResult) {
        setSttTestResult(message);
      } else {
        setError(message);
      }
    }
  }

  async function startModelSpeechRecognition(updateTestResult = false) {
    stopListening();
    setSpeechProcessing(false);
    recognizedSpeechRef.current = false;
    setStatus("listening");
    if (updateTestResult) {
      setSttTestResult(copy.sttListening);
    }

    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("media_recorder_unsupported");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"].find((candidate) =>
        MediaRecorder.isTypeSupported(candidate)
      );
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        clearSpeechSilenceTimer();
        stopSpeechActivityMonitor();
        stream.getTracks().forEach((track) => track.stop());
        if (mediaStreamRef.current === stream) {
          mediaStreamRef.current = null;
        }
        const audio = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        void transcribeRecordedAudio(audio, updateTestResult);
      };

      recorder.start();
      startSpeechActivityMonitor(stream, modelSpeechSilenceTimeoutMs);
    } catch (recordingError) {
      stopListening();
      setStatus("error");
      const message = formatSttError(recordingError);
      if (updateTestResult) {
        setSttTestResult(message);
      } else {
        setError(message);
      }
    }
  }

  function startNativeSpeechRecognition(updateTestResult = false) {
    stopListening();
    setSpeechProcessing(false);
    recognizedSpeechRef.current = false;
    setStatus("listening");
    if (updateTestResult) {
      setSttTestResult(copy.sttListening);
    }

    try {
      const SpeechRecognition =
        (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition;
      if (!SpeechRecognition) {
        throw new Error("native_speech_unsupported");
      }

      const recognition = new SpeechRecognition();
      const recognitionLanguage =
        (draftConfig?.general.language ?? config?.general.language) === "en-US" ? "en-US" : "zh-CN";
      recognition.lang = recognitionLanguage;
      recognition.continuous = true;
      recognition.interimResults = true;
      speechRecognitionRef.current = recognition;

      recognition.onresult = (event) => {
        const parts: string[] = [];
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result?.[0]?.transcript) {
            parts.push(result[0].transcript.trim());
          }
        }
        const transcript =
          recognitionLanguage === "en-US"
            ? parts.join(" ").replace(/\s+/g, " ").trim()
            : parts.join("").replace(/\s+/g, "").trim();
        if (!transcript) {
          return;
        }

        if (shouldIgnoreSpeechTranscript(transcript)) {
          return;
        }

        recognizedSpeechRef.current = true;
        latestSpeechTranscriptRef.current = transcript;
        setInput(transcript);
        setIsExpanded(true);
        clearSpeechSilenceTimer();
        if (updateTestResult) {
          setSttTestResult(`${copy.sttResultPrefix}${transcript}`);
        }
        resetSpeechSilenceTimer(wakeSpeechSilenceTimeoutMs);
        window.setTimeout(() => inputRef.current?.focus(), 40);
      };

      recognition.onend = () => {
        clearSpeechSilenceTimer();
        speechRecognitionRef.current = null;
        setStatus("idle");
        if (!recognizedSpeechRef.current && updateTestResult) {
          setSttTestResult(copy.sttNoSpeech);
        }
        if (recognizedSpeechRef.current) {
          scheduleVoiceAutoSend(updateTestResult, latestSpeechTranscriptRef.current);
        }
      };

      recognition.onerror = (event) => {
        clearSpeechSilenceTimer();
        speechRecognitionRef.current = null;
        setStatus(event.error === "no-speech" ? "idle" : "error");
        if (event.error === "no-speech") {
          if (updateTestResult) {
            setSttTestResult(copy.sttNoSpeech);
          }
          return;
        }
        const message = formatSttError(event.error || event.type || "native_speech_failed");
        if (updateTestResult) {
          setSttTestResult(message);
        } else {
          setError(message);
        }
      };

      recognition.start();
      resetSpeechSilenceTimer(wakeSpeechSilenceTimeoutMs);
    } catch (recordingError) {
      stopListening();
      setStatus("error");
      const message = formatSttError(recordingError);
      if (updateTestResult) {
        setSttTestResult(message);
      } else {
        setError(message);
      }
    }
  }

  function startListeningFromWakeup() {
    const currentConfig = draftConfigRef.current ?? configRef.current;
    if (currentConfig?.voice.sttMode === "model") {
      void startModelSpeechRecognition(false);
      return;
    }
    startNativeSpeechRecognition(false);
  }

  function testSpeechRecognition() {
    const currentConfig = draftConfigRef.current ?? configRef.current ?? draftConfig ?? config;
    if (currentConfig?.voice.sttMode === "model") {
      void startModelSpeechRecognition(true);
      return;
    }
    startNativeSpeechRecognition(true);
  }

  function toggleNativeSpeechRecognition() {
    if (suppressNextMicClickRef.current) {
      suppressNextMicClickRef.current = false;
      return;
    }

    if (speechProcessingRef.current) {
      cancelSpeechProcessing();
      return;
    }

    if (status === "listening") {
      stopListening();
      return;
    }
    startListeningFromWakeup();
  }

  function isHoldPushToTalkEnabled() {
    const voiceConfig = (draftConfigRef.current ?? configRef.current ?? draftConfig ?? config)?.voice;
    return Boolean(voiceConfig?.pushToTalkEnabled && voiceConfig.pushToTalkMode === "hold");
  }

  function isPushToTalkEvent(event: KeyboardEvent) {
    const voiceConfig = (draftConfigRef.current ?? configRef.current)?.voice;
    if (!voiceConfig?.pushToTalkEnabled || !voiceConfig.pushToTalkKey) {
      return false;
    }

    return event.code === voiceConfig.pushToTalkKey || event.key === voiceConfig.pushToTalkKey;
  }

  function startVoiceFromKeyboard() {
    maybeStartNewConversationAfterIdle();
    setSettingsOpen(false);
    setIsExpanded(false);
    setStatus((current) => (current === "error" ? "idle" : current));
    startListeningFromWakeup();
  }

  function handlePushToTalkKeyDown(event: KeyboardEvent) {
    if (capturingGlobalShortcutRef.current) {
      return applyCapturedGlobalShortcut(event);
    }

    if (capturingPushToTalkKeyRef.current) {
      event.preventDefault();
      if (event.key === "Escape") {
        setCapturingPushToTalkKey(false);
        return true;
      }

      updateDraft((current) => ({
        ...current,
        voice: { ...current.voice, pushToTalkKey: event.code || event.key }
      }));
      setCapturingPushToTalkKey(false);
      return true;
    }

    const voiceConfig = (draftConfigRef.current ?? configRef.current)?.voice;
    if (!voiceConfig?.pushToTalkEnabled || !isPushToTalkEvent(event) || isEditableKeyboardTarget(event.target)) {
      return false;
    }

    event.preventDefault();
    if (voiceConfig.pushToTalkMode === "hold") {
      if (!event.repeat && !keyHoldActiveRef.current) {
        keyHoldActiveRef.current = true;
        startVoiceFromKeyboard();
      }
      return true;
    }

    if (!event.repeat) {
      if (statusRef.current === "listening") {
        stopListening();
      } else {
        startVoiceFromKeyboard();
      }
    }
    return true;
  }

  function handlePushToTalkKeyUp(event: KeyboardEvent) {
    const voiceConfig = (draftConfigRef.current ?? configRef.current)?.voice;
    if (
      voiceConfig?.pushToTalkEnabled &&
      voiceConfig.pushToTalkMode === "hold" &&
      isPushToTalkEvent(event) &&
      keyHoldActiveRef.current
    ) {
      event.preventDefault();
      keyHoldActiveRef.current = false;
      stopListening();
      return true;
    }

    return false;
  }

  function startMicHold(event: React.PointerEvent<HTMLButtonElement>) {
    if (!isHoldPushToTalkEnabled()) {
      return;
    }

    event.preventDefault();
    suppressNextMicClickRef.current = true;
    micHoldActiveRef.current = true;
    if (status !== "listening") {
      startListeningFromWakeup();
    }
  }

  function stopMicHold() {
    if (!micHoldActiveRef.current) {
      return;
    }

    micHoldActiveRef.current = false;
    stopListening();
    window.setTimeout(() => {
      suppressNextMicClickRef.current = false;
    }, 0);
  }

  function wakeForVoice() {
    maybeStartNewConversationAfterIdle();
    setSettingsOpen(false);
    setIsExpanded(false);
    setStatus((current) => (current === "error" ? "idle" : current));
    window.setTimeout(startListeningFromWakeup, 60);
  }

  useEffect(() => {
    loadConfig()
      .then((loaded) => {
        setConfig(loaded);
        setDraftConfig(loaded);
      })
      .catch((loadError) => {
        setError(String(loadError));
        setStatus("error");
      });

    void listConversations()
      .then((snapshots) => {
        if (snapshots.length === 0) {
          return;
        }
        const sessions = snapshots.map((snapshot) => ({
          id: snapshot.conversation.id,
          title: snapshot.conversation.title,
          summary: snapshot.conversation.summary,
          createdAt: snapshot.conversation.createdAt,
          updatedAt: snapshot.conversation.updatedAt,
          messages: snapshot.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content
          }))
        }));
        const [activeSession] = sessions;
        setConversationState({
          activeSessionId: activeSession.id,
          messages: activeSession.messages,
          sessions
        });
        conversationRef.current = {
          activeSessionId: activeSession.id,
          messages: activeSession.messages,
          sessions
        };
      })
      .catch(() => undefined);
    void refreshExecutionLogs();
    void refreshMemories();
    void refreshMemoryFiles();
    loadLocalRegistries();
  }, []);

  useEffect(() => {
    let cleanupWakeup: (() => void) | undefined;
    let cleanupOpenSettings: (() => void) | undefined;

    void onAssistantWakeup(() => {
      wakeForVoice();
    }).then((cleanup) => {
      cleanupWakeup = cleanup;
    });

    void onOpenSettings(() => {
      setSettingsOpen(true);
      setActiveSettings("general");
      setIsExpanded(true);
    }).then((cleanup) => {
      cleanupOpenSettings = cleanup;
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (handlePushToTalkKeyDown(event)) {
        return;
      }

      if (event.key === "Escape") {
        setCapturingGlobalShortcut(false);
        setCapturingPushToTalkKey(false);
        stopListening();
        stopTts();
        setSettingsOpen(false);
        void hideAssistantWindow();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      handlePushToTalkKeyUp(event);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      stopListening();
      stopTts();
      cleanupWakeup?.();
      cleanupOpenSettings?.();
    };
  }, []);

  const visibleMessages = useMemo(() => conversationState.messages.slice(-6), [conversationState.messages]);
  const previousConversation = conversationState.sessions.find(
    (session) => session.id !== conversationState.activeSessionId && session.messages.length > 0
  );
  const language = draftConfig?.general.language ?? config?.general.language ?? "zh-CN";
  const copy = uiCopy[language];
  const activeSettingsLabel = copy.nav[activeSettings];
  const voiceBusy = status === "listening" || speechProcessing;

  function handleWindowDragStart(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0 || isWindowDragBlockedTarget(event.target)) {
      return;
    }

    void startWindowDrag().catch(() => undefined);
  }

  async function handleSend(textOverride?: string) {
    const trimmed = (textOverride ?? input).trim();
    if (!trimmed || (status === "thinking" && !speechProcessingRef.current)) {
      return;
    }

    markSubmittedSpeechText(trimmed);
    if (speechProcessingRef.current) {
      cancelSpeechProcessing();
    } else if (statusRef.current === "listening" || speechRecognitionRef.current || mediaRecorderRef.current) {
      stopListening();
    }
    stopTts();
    const plannedAction = await planLocalAction(trimmed);
    if (plannedAction) {
      const nextUserMessage = createMessage("user", trimmed);
      const assistantMessage = createMessage("assistant", "");

      updateActiveMessages(() => [...conversationRef.current.messages, nextUserMessage, assistantMessage]);
      setInput("");
      setError("");
      setPendingConfirmation(null);
      setStatus("executing");

      try {
        const response = await executeLocalAction(plannedAction, false);
        if (response.status === "requiresConfirmation" && response.confirmation && response.action) {
          setPendingConfirmation({
            action: response.action,
            assistantMessageId: assistantMessage.id,
            title: response.confirmation.title,
            description: response.confirmation.description,
            command: response.confirmation.command,
            target: response.confirmation.target,
            riskLevel: response.confirmation.riskLevel
          });
          setStatus("confirming");
          updateActiveMessages((current) =>
            current.map((item) =>
              item.id === assistantMessage.id
                ? { ...item, content: `${copy.confirmationTitle}：${response.confirmation?.title}` }
                : item
            )
          );
          return;
        }

        setStatus(response.status === "completed" ? "idle" : "error");
        updateActiveMessages((current) =>
          current.map((item) => (item.id === assistantMessage.id ? { ...item, content: response.message } : item))
        );
        await refreshExecutionLogs();
        if (response.status === "completed") {
          await playTts(response.message);
        }
      } catch (localActionError) {
        const message = String(localActionError);
        setError(message);
        setStatus("error");
        updateActiveMessages((current) =>
          current.map((item) => (item.id === assistantMessage.id ? { ...item, content: message } : item))
        );
      }
      return;
    }

    if (!config) {
      setError("missing_api_key");
      setStatus("error");
      setSettingsOpen(true);
      setActiveSettings("models");
      return;
    }

    const activeTextProfile = selectedProfile(config, "text");
    if (!activeTextProfile?.apiKey.trim()) {
      setError("missing_api_key");
      setStatus("error");
      setSettingsOpen(true);
      setActiveSettings("models");
      return;
    }

    const nextUserMessage = createMessage("user", trimmed);
    const nextMessages = [...conversationRef.current.messages, nextUserMessage];
    const assistantMessage = createMessage("assistant", "");
    const requestId = crypto.randomUUID();

    updateActiveMessages(() => [...nextMessages, assistantMessage]);
    setInput("");
    setError("");
    cancelledChatRequestIdRef.current = "";
    activeChatRequestIdRef.current = requestId;
    setActiveChatRequestId(requestId);
    setStatus("thinking");

    try {
      const ttsEnabled = Boolean(config?.voice.ttsEnabled);
      const reasoningMode = await resolveReasoningMode(trimmed);
      setStatus("thinking");
      let responseText = "";
      await sendChatStream({
        requestId,
        reasoningMode,
        messages: buildModelMessages(
          config,
          memories,
          soulFileContent,
          memoryFileContent,
          createConversationSummary(nextMessages, config.memory),
          nextMessages
        ),
        onDelta: (chunk) => {
          if (cancelledChatRequestIdRef.current === requestId) {
            return;
          }

          responseText = `${responseText}${chunk}`;
          if (!ttsEnabled) {
            const displayText = assistantTextForDisplay(responseText);
            updateActiveMessages((current) =>
              current.map((item) =>
                item.id === assistantMessage.id ? { ...item, content: displayText } : item
              )
            );
          }
        }
      });
      if (cancelledChatRequestIdRef.current === requestId) {
        setStatus("idle");
        return;
      }

      const displayText = assistantTextForDisplay(responseText);
      if (ttsEnabled) {
        const speechText = speechTextFromAssistantText(displayText);
        let audio: HTMLAudioElement | null = null;
        if (speechText) {
          try {
            audio = await prepareCloudTtsAudio(speechText);
          } catch (ttsError) {
            setError(`${copy.ttsFailed}${String(ttsError)}`);
          }
        }
        updateActiveMessages((current) =>
          current.map((item) => (item.id === assistantMessage.id ? { ...item, content: displayText } : item))
        );
        if (audio) {
          try {
            await playPreparedAudio(audio);
          } catch (ttsError) {
            setError(`${copy.ttsFailed}${String(ttsError)}`);
            setStatus("idle");
          }
        } else {
          setStatus("idle");
        }
      } else {
        updateActiveMessages((current) =>
          current.map((item) => (item.id === assistantMessage.id ? { ...item, content: displayText } : item))
        );
        setStatus("idle");
      }
    } catch (chatError) {
      const message = String(chatError);
      if (message.includes("chat_cancelled") || cancelledChatRequestIdRef.current === requestId) {
        setStatus("idle");
        return;
      }

      setError(message);
      setStatus("error");
      updateActiveMessages((current) =>
        current.map((item) =>
          item.id === assistantMessage.id
            ? {
                ...item,
                content:
                  message === "missing_api_key"
                    ? copy.missingApiReply
                    : `${copy.chatFailurePrefix}${message}`
          }
            : item
        )
      );
    } finally {
      if (activeChatRequestIdRef.current === requestId) {
        activeChatRequestIdRef.current = "";
        setActiveChatRequestId("");
      }
    }
  }

  async function confirmPendingAction() {
    if (!pendingConfirmation) {
      return;
    }

    setStatus("executing");
    try {
      const response = await executeLocalAction(pendingConfirmation.action, true);
      updateActiveMessages((current) =>
        current.map((item) =>
          item.id === pendingConfirmation.assistantMessageId ? { ...item, content: response.message } : item
        )
      );
      setPendingConfirmation(null);
      setStatus(response.status === "completed" ? "idle" : "error");
      await refreshExecutionLogs();
      if (response.status === "completed") {
        await playTts(response.message);
      }
    } catch (confirmationError) {
      const message = String(confirmationError);
      setError(message);
      setStatus("error");
      updateActiveMessages((current) =>
        current.map((item) =>
          item.id === pendingConfirmation.assistantMessageId ? { ...item, content: message } : item
        )
      );
    }
  }

  function cancelPendingAction() {
    if (!pendingConfirmation) {
      return;
    }

    updateActiveMessages((current) =>
      current.map((item) =>
        item.id === pendingConfirmation.assistantMessageId ? { ...item, content: "已取消执行。" } : item
      )
    );
    setPendingConfirmation(null);
    setStatus("idle");
  }

  async function handleSaveSettings() {
    if (!draftConfig) {
      return;
    }

    try {
      const shortcut = await validateShortcut(draftConfig.general.shortcut);
      const nextConfig = {
        ...draftConfig,
        general: { ...draftConfig.general, shortcut }
      };
      const saved = await saveConfig(nextConfig);
      setConfig(saved);
      setDraftConfig(saved);
      setError("");
      setStatus((current) => (current === "error" ? "idle" : current));
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1400);
    } catch (saveError) {
      setError(String(saveError));
      setStatus("error");
    }
  }

  function updateDraft(updater: (current: AppConfig) => AppConfig) {
    setDraftConfig((current) => (current ? updater(current) : current));
  }

  function applyCapturedGlobalShortcut(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setCapturingGlobalShortcut(false);
      return true;
    }

    if (isModifierKeyboardEvent(event)) {
      return true;
    }

    const key = shortcutKeyFromEvent(event);
    updateDraft((current) => ({
      ...current,
      general: { ...current.general, shortcut: shortcutWithKey(current.general.shortcut, key) }
    }));
    setCapturingGlobalShortcut(false);
    return true;
  }

  useEffect(() => {
    if (!capturingGlobalShortcut) {
      return undefined;
    }

    const onShortcutKeyDown = (event: KeyboardEvent) => {
      applyCapturedGlobalShortcut(event);
    };

    window.addEventListener("keydown", onShortcutKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onShortcutKeyDown, true);
    };
  }, [capturingGlobalShortcut]);

  const hasConversation = visibleMessages.length > 0;

  return (
    <main className="app-shell">
      <section
        className={`assistant-surface ${isExpanded ? "is-expanded" : "is-collapsed"}`}
        aria-label={copy.assistantAria}
        onMouseEnter={() => setIsExpanded(true)}
        onMouseLeave={() => {
          if (!settingsOpen) {
            setIsExpanded(false);
          }
        }}
      >
        <header className="notch-bar" data-tauri-drag-region onMouseDown={handleWindowDragStart}>
          <button
            className="orb-button"
            onClick={() => {
              setIsExpanded(true);
              window.setTimeout(() => inputRef.current?.focus(), 40);
            }}
            aria-label={copy.activate}
          >
            <span className={`orb orb-${status}`}>
              <span />
              <span />
              <span />
            </span>
          </button>
          <div className="notch-copy" data-tauri-drag-region>
            <strong>{copy.assistantName}</strong>
            <span>{copy.status[status]}</span>
          </div>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label={copy.openSettings}>
            <Settings size={17} />
          </button>
          <button className="icon-button" onClick={() => void hideAssistantWindow()} aria-label={copy.hideWindow}>
            <Minus size={17} />
          </button>
        </header>

        {isExpanded ? (
          <div className="command-panel">
            <div className="conversation-toolbar">
              <button
                className="text-button"
                onClick={resumePreviousConversation}
                disabled={!previousConversation}
                title={previousConversation ? previousConversation.title : copy.noPreviousConversation}
              >
                <ArrowLeft size={15} />
                <span>{copy.previousConversation}</span>
              </button>
              <button className="text-button" onClick={startNewConversation}>
                <Plus size={15} />
                <span>{copy.newConversation}</span>
              </button>
            </div>

            <div className="assistant-current">
              {!hasConversation ? (
                <div className="empty-state">
                  <Sparkles size={22} />
                  <h1>{copy.emptyTitle}</h1>
                  <p>{copy.emptyCopy}</p>
                </div>
              ) : (
                <div className="message-stack">
                  {visibleMessages.map((message) => (
                    <article key={message.id} className={`message message-${message.role}`}>
                      <span>{message.role === "user" ? copy.roles.user : copy.roles.assistant}</span>
                      <p>{message.content || "..."}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>

            {error ? (
              <button
                className="error-strip"
                onClick={() => {
                  setSettingsOpen(true);
                  setActiveSettings(settingsTargetForError(error));
                }}
              >
                <KeyRound size={15} />
                <span>{errorActionCopy(error, copy)}</span>
                <ChevronRight size={15} />
              </button>
            ) : null}

            {pendingConfirmation ? (
              <div className="confirmation-card">
                <div>
                  <span>{copy.confirmationTitle}</span>
                  <strong>{pendingConfirmation.title}</strong>
                  <p>{pendingConfirmation.description}</p>
                  {pendingConfirmation.command ? <code>{pendingConfirmation.command}</code> : null}
                  {pendingConfirmation.target && !pendingConfirmation.command ? <code>{pendingConfirmation.target}</code> : null}
                </div>
                <div className="confirmation-actions">
                  <button className="secondary-button dark-surface" onClick={cancelPendingAction} type="button">
                    {copy.cancel}
                  </button>
                  <button className="primary-button light-surface" onClick={() => void confirmPendingAction()} type="button">
                    <Check size={15} />
                    <span>{copy.allowOnce}</span>
                  </button>
                </div>
              </div>
            ) : null}

            <div className="input-row">
              <button
                className={`mic-button ${voiceBusy ? "is-active" : ""}`}
                onPointerDown={voiceBusy ? undefined : startMicHold}
                onPointerUp={voiceBusy ? undefined : stopMicHold}
                onPointerCancel={voiceBusy ? undefined : stopMicHold}
                onPointerLeave={voiceBusy ? undefined : stopMicHold}
                onClick={toggleNativeSpeechRecognition}
                aria-label={voiceBusy ? copy.stopVoice : copy.testStt}
              >
                {voiceBusy ? <X size={18} /> : <Mic size={18} />}
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={copy.inputPlaceholder}
                rows={1}
              />
              <button
                className={`send-button ${activeChatRequestId ? "is-active" : ""}`}
                onClick={() => {
                  if (activeChatRequestId) {
                    void cancelModelResponse();
                    return;
                  }
                  void handleSend();
                }}
                disabled={!activeChatRequestId && !input.trim()}
                aria-label={activeChatRequestId ? copy.stopVoice : undefined}
              >
                {activeChatRequestId ? <X size={17} /> : <Send size={17} />}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {settingsOpen && draftConfig ? (
        <aside className="settings-panel" aria-label={copy.settingsAria}>
          <div className="settings-sidebar">
            <div className="settings-title" data-tauri-drag-region onMouseDown={handleWindowDragStart}>
              <Settings size={18} />
              <strong>{copy.settings}</strong>
            </div>
            <nav>
              {settingsSections.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={activeSettings === item.id ? "is-selected" : ""}
                    onClick={() => setActiveSettings(item.id)}
                  >
                    <Icon size={16} />
                    <span>{copy.nav[item.id]}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="settings-content">
            <div className="settings-header" data-tauri-drag-region onMouseDown={handleWindowDragStart}>
              <div data-tauri-drag-region>
                <span>afuos</span>
                <h2>{activeSettingsLabel}</h2>
              </div>
              <button className="icon-button dark" onClick={() => setSettingsOpen(false)} aria-label={copy.closeSettings}>
                <X size={17} />
              </button>
            </div>

            <SettingsSection
              active={activeSettings}
              config={draftConfig}
              copy={copy}
              sessions={conversationState.sessions}
              activeSessionId={conversationState.activeSessionId}
              executionLogs={executionLogs}
              logSearch={logSearch}
              logStatusFilter={logStatusFilter}
              logRiskFilter={logRiskFilter}
              memories={memories}
              memoryDraft={memoryDraft}
              memoryFileContent={memoryFileContent}
              memoryFileDraft={memoryFileDraft}
              memoryFilePath={memoryFilePath}
              soulFileContent={soulFileContent}
              soulFileDraft={soulFileDraft}
              soulFilePath={soulFilePath}
              pendingMemoryFileSave={pendingMemoryFileSave}
              skills={skills}
              skillDraft={skillDraft}
              mcpServers={mcpServers}
              mcpDraft={mcpDraft}
              sttTestResult={sttTestResult}
              ttsTestResult={ttsTestResult}
              capturingGlobalShortcut={capturingGlobalShortcut}
              capturingPushToTalkKey={capturingPushToTalkKey}
              resumeConversation={resumeConversation}
              requestMemoryFileSave={setPendingMemoryFileSave}
              confirmMemoryFileSave={confirmMemoryFileSave}
              cancelMemoryFileSave={() => setPendingMemoryFileSave(null)}
              setLogSearch={setLogSearch}
              setLogStatusFilter={setLogStatusFilter}
              setLogRiskFilter={setLogRiskFilter}
              setMemoryDraft={setMemoryDraft}
              setMemoryFileDraft={setMemoryFileDraft}
              setSoulFileDraft={setSoulFileDraft}
              setCapturingGlobalShortcut={setCapturingGlobalShortcut}
              setCapturingPushToTalkKey={setCapturingPushToTalkKey}
              addMemory={async () => {
                if (!memoryDraft.trim()) {
                  return;
                }
                await addMemory(memoryDraft);
                setMemoryDraft("");
                await refreshMemories();
              }}
              deleteMemory={async (id) => {
                await deleteMemory(id);
                await refreshMemories();
              }}
              clearMemories={async () => {
                await clearMemories();
                await refreshMemories();
              }}
              setSkillDraft={setSkillDraft}
              addSkill={addSkillEntry}
              toggleSkill={(id) =>
                updateSkills(skills.map((skill) => (skill.id === id ? { ...skill, enabled: !skill.enabled } : skill)))
              }
              setMcpDraft={setMcpDraft}
              addMcp={addMcpEntry}
              toggleMcp={(id) =>
                updateMcpServers(
                  mcpServers.map((server) => (server.id === id ? { ...server, enabled: !server.enabled } : server))
                )
              }
              testSpeechRecognition={testSpeechRecognition}
              testTtsPlayback={testTtsPlayback}
              stopVoice={() => {
                cancelSpeechProcessing();
                stopTts();
              }}
              updateDraft={updateDraft}
            />

            <footer className="settings-actions">
              <button className="secondary-button" onClick={() => setDraftConfig(config)}>
                {copy.revert}
              </button>
              <button className="primary-button" onClick={() => void handleSaveSettings()}>
                {saveState === "saved" ? <Check size={16} /> : <Play size={16} />}
                <span>{saveState === "saved" ? copy.saved : copy.save}</span>
              </button>
            </footer>
          </div>
        </aside>
      ) : null}
    </main>
  );
}

interface SettingsSectionProps {
  active: SettingsSectionId;
  config: AppConfig;
  copy: (typeof uiCopy)[Language];
  sessions: ChatSession[];
  activeSessionId: string;
  executionLogs: ExecutionLog[];
  logSearch: string;
  logStatusFilter: string;
  logRiskFilter: string;
  memories: MemoryItem[];
  memoryDraft: string;
  memoryFileContent: string;
  memoryFileDraft: string;
  memoryFilePath: string;
  soulFileContent: string;
  soulFileDraft: string;
  soulFilePath: string;
  pendingMemoryFileSave: MemoryFileKind | null;
  skills: SkillEntry[];
  skillDraft: string;
  mcpServers: McpEntry[];
  mcpDraft: string;
  sttTestResult: string;
  ttsTestResult: string;
  capturingGlobalShortcut: boolean;
  capturingPushToTalkKey: boolean;
  resumeConversation: (sessionId: string) => void;
  requestMemoryFileSave: (kind: MemoryFileKind) => void;
  confirmMemoryFileSave: () => Promise<void>;
  cancelMemoryFileSave: () => void;
  setLogSearch: (value: string) => void;
  setLogStatusFilter: (value: string) => void;
  setLogRiskFilter: (value: string) => void;
  setMemoryDraft: (value: string) => void;
  setMemoryFileDraft: (value: string) => void;
  setSoulFileDraft: (value: string) => void;
  setCapturingGlobalShortcut: (value: boolean) => void;
  setCapturingPushToTalkKey: (value: boolean) => void;
  addMemory: () => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  clearMemories: () => Promise<void>;
  setSkillDraft: (value: string) => void;
  addSkill: () => void;
  toggleSkill: (id: string) => void;
  setMcpDraft: (value: string) => void;
  addMcp: () => void;
  toggleMcp: (id: string) => void;
  testSpeechRecognition: () => void;
  testTtsPlayback: () => void;
  stopVoice: () => void;
  updateDraft: (updater: (current: AppConfig) => AppConfig) => void;
}

function SettingsSection({
  active,
  config,
  copy,
  sessions,
  activeSessionId,
  executionLogs,
  logSearch,
  logStatusFilter,
  logRiskFilter,
  memories,
  memoryDraft,
  memoryFileContent,
  memoryFileDraft,
  memoryFilePath,
  soulFileContent,
  soulFileDraft,
  soulFilePath,
  pendingMemoryFileSave,
  skills,
  skillDraft,
  mcpServers,
  mcpDraft,
  sttTestResult,
  ttsTestResult,
  capturingGlobalShortcut,
  capturingPushToTalkKey,
  resumeConversation,
  requestMemoryFileSave,
  confirmMemoryFileSave,
  cancelMemoryFileSave,
  setLogSearch,
  setLogStatusFilter,
  setLogRiskFilter,
  setMemoryDraft,
  setMemoryFileDraft,
  setSoulFileDraft,
  setCapturingGlobalShortcut,
  setCapturingPushToTalkKey,
  addMemory,
  deleteMemory,
  clearMemories,
  setSkillDraft,
  addSkill,
  toggleSkill,
  setMcpDraft,
  addMcp,
  toggleMcp,
  testSpeechRecognition,
  testTtsPlayback,
  stopVoice,
  updateDraft
}: SettingsSectionProps) {
  const [shortcutOptionsOpen, setShortcutOptionsOpen] = useState(false);
  const profiles = config.models.profiles;
  const profileOptions = (kind: ModelProfileKind) => profiles.filter((profile) => profile.capabilities.includes(kind));
  const addProfileWithKind = (kind: ModelProfileKind = "text") => {
    const profile = createModelProfile(kind);
    updateDraft((current) => ({
      ...current,
      models: {
        ...current.models,
        profiles: [...current.models.profiles, profile],
        selectedTextProfileId:
          kind === "text" && !current.models.selectedTextProfileId
            ? profile.id
            : current.models.selectedTextProfileId,
        selectedVisionProfileId: kind === "vision" ? profile.id : current.models.selectedVisionProfileId,
        selectedTtsProfileId: kind === "tts" ? profile.id : current.models.selectedTtsProfileId,
        selectedSttProfileId: kind === "stt" ? profile.id : current.models.selectedSttProfileId
      }
    }));
  };

  if (active === "general") {
    const globalShortcut = parseMacShortcut(config.general.shortcut);

    return (
      <div className="settings-card">
        <Field label={copy.labels.language}>
          <select
            value={config.general.language}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                general: { ...current.general, language: event.target.value as Language }
              }))
            }
          >
            <option value="zh-CN">{copy.options.chinese}</option>
            <option value="en-US">{copy.options.english}</option>
          </select>
        </Field>
        <Field label={copy.labels.globalShortcut}>
          <div className="mac-shortcut-builder">
            <div className="shortcut-recorder-row">
              <button
                className={`shortcut-recorder ${capturingGlobalShortcut ? "is-capturing" : ""}`}
                onClick={(event) => {
                  event.currentTarget.focus();
                  setCapturingPushToTalkKey(false);
                  setCapturingGlobalShortcut(true);
                }}
                autoFocus={capturingGlobalShortcut}
                type="button"
              >
                <strong>
                  {capturingGlobalShortcut ? copy.capturingGlobalShortcut : shortcutDisplayLabel(config.general.shortcut)}
                </strong>
                <span>{copy.captureGlobalShortcut}</span>
              </button>
              <button
                className={`shortcut-options-button ${shortcutOptionsOpen ? "is-selected" : ""}`}
                onClick={() => setShortcutOptionsOpen((current) => !current)}
                type="button"
                aria-label={copy.labels.globalShortcut}
              >
                <Settings size={16} />
              </button>
            </div>
            {shortcutOptionsOpen ? (
              <div className="shortcut-modifier-row">
                {macShortcutModifierOrder.map((modifier) => (
                  <button
                    key={modifier}
                    className={globalShortcut.modifiers.has(modifier) ? "is-selected" : ""}
                    onClick={() =>
                      updateDraft((current) => ({
                        ...current,
                        general: {
                          ...current.general,
                          shortcut: shortcutWithModifier(
                            current.general.shortcut,
                            modifier,
                            !globalShortcut.modifiers.has(modifier)
                          )
                        }
                      }))
                    }
                    type="button"
                  >
                    {globalShortcut.modifiers.has(modifier) ? <Check size={14} /> : <Plus size={13} />}
                    <span>{macShortcutModifierLabels[modifier]}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </Field>
        <Field label={copy.labels.windowSize}>
          <select
            value={config.general.windowSize}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                general: { ...current.general, windowSize: event.target.value }
              }))
            }
          >
            <option value="small">{copy.options.small}</option>
            <option value="medium">{copy.options.medium}</option>
            <option value="large">{copy.options.large}</option>
          </select>
        </Field>
        <Toggle
          label={copy.labels.hotwordWakeup}
          checked={config.general.hotwordEnabled}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              general: { ...current.general, hotwordEnabled: checked }
            }))
          }
        />
      </div>
    );
  }

  if (active === "models") {
    const updateProfile = (profileId: string, updater: (profile: ModelProfile) => ModelProfile) => {
      updateDraft((current) => ({
        ...current,
        models: {
          ...current.models,
          profiles: current.models.profiles.map((profile) => (profile.id === profileId ? updater(profile) : profile))
        }
      }));
    };

    const updateProfileCapability = (profile: ModelProfile, kind: ModelProfileKind, enabled: boolean) => {
      const nextCapabilities = enabled
        ? Array.from(new Set([...profile.capabilities, kind]))
        : profile.capabilities.filter((capability) => capability !== kind);
      const capabilities = nextCapabilities.length > 0 ? nextCapabilities : [kind];

      updateProfile(profile.id, (item) => ({
        ...item,
        capabilities,
        kind: capabilities[0]
      }));
    };

    return (
      <div className="settings-card">
        <div className="model-select-grid">
          <Field label={copy.labels.textModelSelect}>
            <select
              value={config.models.selectedTextProfileId}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  models: { ...current.models, selectedTextProfileId: event.target.value }
                }))
              }
            >
              {profileOptions("text").map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={copy.labels.visionModelSelect}>
            <select
              value={config.models.selectedVisionProfileId}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  models: { ...current.models, selectedVisionProfileId: event.target.value }
                }))
              }
            >
              <option value="">{copy.labels.noModelSelected}</option>
              {profileOptions("vision").map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={copy.labels.ttsModelSelect}>
            <select
              value={config.models.selectedTtsProfileId}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  models: { ...current.models, selectedTtsProfileId: event.target.value }
                }))
              }
            >
              <option value="">{copy.labels.noModelSelected}</option>
              {profileOptions("tts").map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={copy.labels.sttModelSelect}>
            <select
              value={config.models.selectedSttProfileId}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  models: { ...current.models, selectedSttProfileId: event.target.value }
                }))
              }
            >
              <option value="">{copy.labels.noModelSelected}</option>
              {profileOptions("stt").map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="model-add-row">
          <button className="model-add-button" onClick={() => addProfileWithKind("text")} type="button">
            <Plus size={15} />
            <span>{copy.addModel}</span>
          </button>
        </div>

        <div className="model-profile-list">
          {profiles.map((profile) => (
            <section key={profile.id} className="model-profile-card">
              <div className="model-profile-header">
                <strong>{profile.name || copy.labels.profileName}</strong>
                <div className="model-capability-tags">
                  {profile.capabilities.map((capability) => (
                    <span key={capability}>{copy.modelKinds[capability]}</span>
                  ))}
                </div>
              </div>
              <div className="model-profile-fields">
                <Field label={copy.labels.profileName}>
                  <input
                    value={profile.name}
                    onChange={(event) => updateProfile(profile.id, (item) => ({ ...item, name: event.target.value }))}
                  />
                </Field>
                <div className="field">
                  <span>{copy.labels.profileKind}</span>
                  <div className="model-capability-picker">
                    {(["text", "vision", "tts", "stt"] as const).map((capability) => (
                      <button
                        key={capability}
                        className={profile.capabilities.includes(capability) ? "is-selected" : ""}
                        type="button"
                        onClick={() =>
                          updateProfileCapability(profile, capability, !profile.capabilities.includes(capability))
                        }
                      >
                        {profile.capabilities.includes(capability) ? <Check size={14} /> : <Plus size={13} />}
                        <span>{copy.modelKinds[capability]}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <Field label={copy.labels.provider}>
                  <input
                    value={profile.provider}
                    onChange={(event) => updateProfile(profile.id, (item) => ({ ...item, provider: event.target.value }))}
                  />
                </Field>
                <Field label={copy.labels.apiBaseUrl}>
                  <input
                    value={profile.baseUrl}
                    onChange={(event) => updateProfile(profile.id, (item) => ({ ...item, baseUrl: event.target.value }))}
                  />
                </Field>
                <Field label={copy.labels.model}>
                  <input
                    value={profile.model}
                    onChange={(event) => updateProfile(profile.id, (item) => ({ ...item, model: event.target.value }))}
                  />
                </Field>
                {profile.capabilities.includes("tts") ? (
                  <Field label={copy.labels.voice}>
                    <input
                      value={profile.voice || ""}
                      onChange={(event) => updateProfile(profile.id, (item) => ({ ...item, voice: event.target.value }))}
                    />
                  </Field>
                ) : null}
                <Field label={copy.labels.apiKey}>
                  <input
                    type="password"
                    value={profile.apiKey}
                    onChange={(event) => updateProfile(profile.id, (item) => ({ ...item, apiKey: event.target.value }))}
                  />
                </Field>
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  }

  if (active === "speech") {
    const sttProfiles = profileOptions("stt");

    return (
      <div className="settings-card">
        <Field label={copy.labels.sttMode}>
          <select
            value={config.voice.sttMode}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                voice: { ...current.voice, sttMode: event.target.value as AppConfig["voice"]["sttMode"] }
              }))
            }
          >
            <option value="local">{copy.sttModes.local}</option>
            <option value="model">{copy.sttModes.model}</option>
          </select>
        </Field>
        {config.voice.sttMode === "model" ? (
          sttProfiles.length > 0 ? (
            <Field label={copy.labels.sttModelSelect}>
              <select
                value={config.models.selectedSttProfileId}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    models: { ...current.models, selectedSttProfileId: event.target.value }
                  }))
                }
              >
                <option value="">{copy.labels.noModelSelected}</option>
                {sttProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="inline-empty">
              <strong>{copy.labels.sttModelSelect}</strong>
              <p>{copy.sttNoProfileCopy}</p>
              <button className="secondary-button" onClick={() => addProfileWithKind("stt")} type="button">
                <Plus size={15} />
                <span>{copy.createSttProfile}</span>
              </button>
            </div>
          )
        ) : null}
        <Toggle
          label={copy.labels.pushToTalk}
          checked={config.voice.pushToTalkEnabled}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              voice: { ...current.voice, pushToTalkEnabled: checked }
            }))
          }
        />
        <Toggle
          label={copy.labels.autoSendOnVoiceEnd}
          checked={config.voice.autoSendOnVoiceEnd}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              voice: { ...current.voice, autoSendOnVoiceEnd: checked }
            }))
          }
        />
        <Field label={copy.labels.pushToTalkKey}>
          <button
            className={`key-capture-button ${capturingPushToTalkKey ? "is-capturing" : ""}`}
            onClick={(event) => {
              event.currentTarget.focus();
              setCapturingGlobalShortcut(false);
              setCapturingPushToTalkKey(true);
            }}
            type="button"
          >
            <strong>{capturingPushToTalkKey ? copy.capturingPushToTalkKey : keyboardCodeLabel(config.voice.pushToTalkKey)}</strong>
            <span>{copy.capturePushToTalkKey}</span>
          </button>
        </Field>
        <Field label={copy.labels.pushToTalkMode}>
          <select
            value={config.voice.pushToTalkMode}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                voice: { ...current.voice, pushToTalkMode: event.target.value as AppConfig["voice"]["pushToTalkMode"] }
              }))
            }
          >
            <option value="hold">{copy.voiceModes.hold}</option>
            <option value="toggle">{copy.voiceModes.toggle}</option>
          </select>
        </Field>
        <div className="voice-test-panel">
          <div className="voice-test-row">
            <button className="secondary-button" onClick={testSpeechRecognition} type="button">
              <Mic size={15} />
              <span>{copy.testStt}</span>
            </button>
            <button className="secondary-button" onClick={stopVoice} type="button">
              <X size={15} />
              <span>{copy.stopVoice}</span>
            </button>
          </div>
          {sttTestResult ? <p>{sttTestResult}</p> : null}
        </div>
      </div>
    );
  }

  if (active === "sound") {
    return (
      <div className="settings-card">
        <Field label={copy.labels.ttsModelSelect}>
          <select
            value={config.models.selectedTtsProfileId}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                models: { ...current.models, selectedTtsProfileId: event.target.value }
              }))
            }
          >
            <option value="">{copy.labels.noModelSelected}</option>
            {profileOptions("tts").map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </Field>
        <Toggle
          label={copy.labels.ttsReplies}
          checked={config.voice.ttsEnabled}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              voice: { ...current.voice, ttsEnabled: checked }
            }))
          }
        />
        <div className="voice-test-panel">
          <div className="voice-test-row">
            <button className="secondary-button" onClick={testTtsPlayback} type="button">
              <Volume2 size={15} />
              <span>{copy.testTts}</span>
            </button>
            <button className="secondary-button" onClick={stopVoice} type="button">
              <X size={15} />
              <span>{copy.stopVoice}</span>
            </button>
          </div>
          {ttsTestResult ? <p>{ttsTestResult}</p> : null}
        </div>
      </div>
    );
  }

  if (active === "permissions") {
    return (
      <div className="settings-card">
        <Toggle
          label={copy.labels.allowShell}
          checked={config.permissions.allowShell}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              permissions: { ...current.permissions, allowShell: checked }
            }))
          }
        />
        <Toggle
          label={copy.labels.browserAutomation}
          checked={config.permissions.allowBrowserAutomation}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              permissions: { ...current.permissions, allowBrowserAutomation: checked }
            }))
          }
        />
        <Field label={copy.labels.blockedPaths}>
          <textarea
            value={config.permissions.blockedPaths.join("\n")}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                permissions: {
                  ...current.permissions,
                  blockedPaths: event.target.value.split("\n").filter(Boolean)
                }
              }))
            }
            rows={5}
          />
        </Field>
      </div>
    );
  }

  if (active === "skills") {
    return (
      <div className="settings-card registry-card">
        <div className="registry-input-row">
          <input
            value={skillDraft}
            onChange={(event) => setSkillDraft(event.target.value)}
            placeholder={copy.skillPathPlaceholder}
          />
          <button className="primary-button" onClick={addSkill} type="button">
            <Plus size={15} />
            <span>{copy.addSkill}</span>
          </button>
        </div>
        <RegistryList
          items={skills.map((skill) => ({
            id: skill.id,
            title: skill.name,
            detail: skill.path,
            enabled: skill.enabled
          }))}
          onToggle={toggleSkill}
        />
      </div>
    );
  }

  if (active === "mcp") {
    return (
      <div className="settings-card registry-card">
        <div className="registry-input-row">
          <input
            value={mcpDraft}
            onChange={(event) => setMcpDraft(event.target.value)}
            placeholder={copy.mcpCommandPlaceholder}
          />
          <button className="primary-button" onClick={addMcp} type="button">
            <Plus size={15} />
            <span>{copy.addMcp}</span>
          </button>
        </div>
        <RegistryList
          items={mcpServers.map((server) => ({
            id: server.id,
            title: server.name,
            detail: server.command,
            enabled: server.enabled
          }))}
          onToggle={toggleMcp}
        />
      </div>
    );
  }

  if (active === "memory") {
    return (
      <div className="settings-card">
        <Toggle
          label={copy.labels.memoryEnabled}
          checked={config.memory.enabled}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              memory: { ...current.memory, enabled: checked }
            }))
          }
        />
        <NumberField
          label={copy.labels.recentTurns}
          value={config.memory.maxRecentTurns}
          field="maxRecentTurns"
          updateDraft={updateDraft}
        />
        <NumberField
          label={copy.labels.summaryChars}
          value={config.memory.summaryMaxChars}
          field="summaryMaxChars"
          updateDraft={updateDraft}
        />
        <NumberField
          label={copy.labels.longTermMemories}
          value={config.memory.maxLongTermMemories}
          field="maxLongTermMemories"
          updateDraft={updateDraft}
        />
        <div className="memory-file-grid">
          <section className="memory-file-editor">
            <div className="memory-file-header">
              <div>
                <strong>{copy.soulFileTitle}</strong>
                {soulFilePath ? <code>{soulFilePath}</code> : null}
              </div>
              <div className="memory-file-actions">
                <button
                  className="secondary-button"
                  disabled={soulFileDraft === soulFileContent}
                  onClick={() => setSoulFileDraft(soulFileContent)}
                  type="button"
                >
                  {copy.resetFileDraft}
                </button>
                <button
                  className="primary-button"
                  disabled={soulFileDraft === soulFileContent}
                  onClick={() => requestMemoryFileSave("soul")}
                  type="button"
                >
                  {copy.saveMemoryFile}
                </button>
              </div>
            </div>
            <textarea value={soulFileDraft} onChange={(event) => setSoulFileDraft(event.target.value)} rows={8} />
          </section>

          <section className="memory-file-editor">
            <div className="memory-file-header">
              <div>
                <strong>{copy.memoryFileTitle}</strong>
                {memoryFilePath ? <code>{memoryFilePath}</code> : null}
              </div>
              <div className="memory-file-actions">
                <button
                  className="secondary-button"
                  disabled={memoryFileDraft === memoryFileContent}
                  onClick={() => setMemoryFileDraft(memoryFileContent)}
                  type="button"
                >
                  {copy.resetFileDraft}
                </button>
                <button
                  className="primary-button"
                  disabled={memoryFileDraft === memoryFileContent}
                  onClick={() => requestMemoryFileSave("memory")}
                  type="button"
                >
                  {copy.saveMemoryFile}
                </button>
              </div>
            </div>
            <textarea value={memoryFileDraft} onChange={(event) => setMemoryFileDraft(event.target.value)} rows={8} />
          </section>
        </div>
        {pendingMemoryFileSave ? (
          <div className="confirmation-card settings-confirmation">
            <div>
              <span>{copy.confirmFileSaveTitle}</span>
              <strong>{pendingMemoryFileSave === "soul" ? copy.soulFileTitle : copy.memoryFileTitle}</strong>
              <p>{copy.confirmFileSaveCopy}</p>
            </div>
            <div className="confirmation-actions">
              <button className="secondary-button dark-surface" onClick={cancelMemoryFileSave} type="button">
                {copy.cancel}
              </button>
              <button className="primary-button light-surface" onClick={() => void confirmMemoryFileSave()} type="button">
                <Check size={15} />
                <span>{copy.confirmSaveFile}</span>
              </button>
            </div>
          </div>
        ) : null}
        <div className="memory-manager">
          <div className="memory-input-row">
            <input
              value={memoryDraft}
              onChange={(event) => setMemoryDraft(event.target.value)}
              placeholder={copy.memoryInputPlaceholder}
            />
            <button className="primary-button" onClick={() => void addMemory()} type="button">
              <Plus size={15} />
              <span>{copy.addMemory}</span>
            </button>
          </div>
          {memories.length === 0 ? (
            <div className="inline-empty">
              <strong>{copy.noMemoriesTitle}</strong>
              <p>{copy.noMemoriesCopy}</p>
            </div>
          ) : (
            <>
              <div className="memory-list">
                {memories.map((memory) => (
                  <article key={memory.id} className="memory-item">
                    <p>{memory.content}</p>
                    <button className="icon-button memory-delete" onClick={() => void deleteMemory(memory.id)} type="button">
                      <X size={14} />
                    </button>
                  </article>
                ))}
              </div>
              <button className="secondary-button danger-button" onClick={() => void clearMemories()} type="button">
                {copy.clearMemory}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (active === "logs") {
    const normalizedSearch = logSearch.trim().toLowerCase();
    const statusOptions = Array.from(new Set(executionLogs.map((log) => log.status).filter(Boolean))).sort();
    const riskOptions = Array.from(new Set(executionLogs.map((log) => log.riskLevel).filter(Boolean))).sort();
    const filteredLogs = executionLogs.filter((log) => {
      const matchesStatus = !logStatusFilter || log.status === logStatusFilter;
      const matchesRisk = !logRiskFilter || log.riskLevel === logRiskFilter;
      const searchable = [log.title, log.actionType, log.target, log.status, log.riskLevel, log.reason]
        .join(" ")
        .toLowerCase();
      const matchesSearch = !normalizedSearch || searchable.includes(normalizedSearch);
      return matchesStatus && matchesRisk && matchesSearch;
    });

    if (executionLogs.length === 0) {
      return (
        <div className="settings-card placeholder-card">
          <FileText size={24} />
          <h3>{copy.noLogsTitle}</h3>
          <p>{copy.noLogsCopy}</p>
        </div>
      );
    }

    return (
      <div className="settings-card logs-card">
        <div className="log-filter-row">
          <input
            value={logSearch}
            onChange={(event) => setLogSearch(event.target.value)}
            placeholder={copy.logSearchPlaceholder}
          />
          <select value={logStatusFilter} onChange={(event) => setLogStatusFilter(event.target.value)}>
            <option value="">{copy.allStatuses}</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <select value={logRiskFilter} onChange={(event) => setLogRiskFilter(event.target.value)}>
            <option value="">{copy.allRisks}</option>
            {riskOptions.map((risk) => (
              <option key={risk} value={risk}>
                {risk}
              </option>
            ))}
          </select>
        </div>
        {filteredLogs.length === 0 ? (
          <div className="inline-empty">
            <strong>{copy.noFilteredLogsTitle}</strong>
            <p>{copy.noFilteredLogsCopy}</p>
          </div>
        ) : (
          <div className="log-list">
            {filteredLogs.map((log) => (
              <article key={log.id} className="log-item">
                <div>
                  <strong>{log.title}</strong>
                  <span>{log.actionType} · {log.status} · {log.riskLevel}</span>
                  {log.target ? <code>{log.target}</code> : null}
                  {log.reason ? <p>{log.reason}</p> : null}
                </div>
                <time>
                  {new Intl.DateTimeFormat(undefined, {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit"
                  }).format(new Date(log.createdAt))}
                </time>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (active === "history") {
    const sessionsWithMessages = sessions.filter((session) => session.messages.length > 0);

    if (sessionsWithMessages.length === 0) {
      return (
        <div className="settings-card placeholder-card">
          <History size={24} />
          <h3>{copy.historyEmptyTitle}</h3>
          <p>{copy.historyEmptyCopy}</p>
        </div>
      );
    }

    return (
      <div className="settings-card history-list">
        {sessionsWithMessages.map((session) => (
          <button
            key={session.id}
            className={`history-item ${session.id === activeSessionId ? "is-active" : ""}`}
            onClick={() => resumeConversation(session.id)}
          >
            <strong>{session.title}</strong>
            <span>
              {new Intl.DateTimeFormat(undefined, {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              }).format(new Date(session.updatedAt))}
            </span>
            <em>{copy.continueConversation}</em>
          </button>
        ))}
      </div>
    );
  }

  const placeholderMap: Record<string, { icon: typeof Bell; title: string; copy: string }> = {
  };

  const placeholder = placeholderMap[active];
  const Icon = placeholder.icon;

  return (
    <div className="settings-card placeholder-card">
      <Icon size={24} />
      <h3>{placeholder.title}</h3>
      <p>{placeholder.copy}</p>
    </div>
  );
}

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

interface RegistryListProps {
  items: Array<{
    id: string;
    title: string;
    detail: string;
    enabled: boolean;
  }>;
  onToggle: (id: string) => void;
}

function RegistryList({ items, onToggle }: RegistryListProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="registry-list">
      {items.map((item) => (
        <article key={item.id} className="registry-item">
          <div>
            <strong>{item.title}</strong>
            <code>{item.detail}</code>
          </div>
          <button className={`toggle ${item.enabled ? "is-on" : ""}`} onClick={() => onToggle(item.id)} type="button">
            <span />
          </button>
        </article>
      ))}
    </div>
  );
}

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <button className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)} type="button">
        <span />
      </button>
    </label>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  field: keyof AppConfig["memory"];
  updateDraft: (updater: (current: AppConfig) => AppConfig) => void;
}

function NumberField({ label, value, field, updateDraft }: NumberFieldProps) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(event) =>
          updateDraft((current) => ({
            ...current,
            memory: { ...current.memory, [field]: Number(event.target.value) }
          }))
        }
      />
    </Field>
  );
}

export default App;

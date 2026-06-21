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
  ImagePlus,
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
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  addMemory,
  callMcpTool,
  cancelChatStream,
  classifyReasoningMode,
  clearConversations,
  clearExecutionLogs,
  clearMemories,
  clearPermissionRules,
  deleteConversation,
  deleteExecutionLog,
  deleteMemory,
  deletePermissionRule,
  executeLocalAction,
  hideAssistantWindow,
  importMemories,
  inspectMcpServer,
  listConversations,
  listExecutionLogs,
  listMemories,
  listPermissionRules,
  loadSkillDocuments,
  loadMemoryFile,
  loadConfig,
  isTauriRuntime,
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
  validateShortcut,
  writeExecutionLog
} from "./tauri";
import type { MemoryFileKind } from "./tauri";
import type {
  AppConfig,
  AssistantStatus,
  ChatMessage,
  ExecutionLog,
  ImageAttachment,
  LocalActionRequest,
  MemoryItem,
  PermissionRule,
  McpRegistryEntry,
  McpToolSummary,
  McpToolRequest,
  ModelProfile,
  ModelProfileKind,
  SkillRegistryEntry,
  SkillDocument
} from "./types";

const fallbackSoulPrompt =
  "你是阿福，也可以叫 afu。你运行在 afuos 这款 macOS 软件里，是用户的本地管家。回答简短、可靠、少废话。涉及高风险本地动作时先说明影响并要求确认。如果需要返回图片，请使用 Markdown 图片语法 ![描述](图片 URL 或本地绝对路径)。";

const defaultSoulTemplate = `你是阿福，也可以叫 afu。
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
- 执行完成后给出清楚结果；失败时说明原因和下一步。`;

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
type ConversationSavePayload = Parameters<typeof saveConversation>[0];

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
  kind: "local" | "mcp";
  action?: LocalActionRequest;
  request?: McpToolRequest;
  assistantMessageId: string;
  title: string;
  description: string;
  command: string;
  target: string;
  riskLevel: string;
}

const conversationsStorageKey = "afuos.conversations";
const lastActivityStorageKey = "afuos.lastActivityAt";
const skillsStorageKey = "afuos.skills";
const mcpStorageKey = "afuos.mcpServers";
const memoriesStorageKey = "afuos.memories";
const memoryFileStorageKey = "afuos.memoryFile";
const soulFileStorageKey = "afuos.soulFile";
const autoNewConversationAfterMs = 60 * 60 * 1000;
const wakeSpeechSilenceTimeoutMs = 3000;
const modelSpeechSilenceTimeoutMs = 3000;
const speechActivityPollMs = 180;
const speechActivityRmsThreshold = 5;
const defaultRecentTurns = 12;
const defaultSummaryMaxChars = 800;
const maxImageAttachments = 4;
const maxImageAttachmentBytes = 8 * 1024 * 1024;

function normalizeRegistrySkills(skills: SkillRegistryEntry[]): SkillRegistryEntry[] {
  return skills
    .filter((skill) => skill && typeof skill.path === "string" && skill.path.trim())
    .map((skill) => ({
      id: skill.id || crypto.randomUUID(),
      name: skill.name || skill.path.split("/").filter(Boolean).pop() || "Skill",
      path: skill.path,
      enabled: Boolean(skill.enabled)
    }));
}

function normalizeRegistryMcpServers(servers: McpRegistryEntry[]): McpRegistryEntry[] {
  return servers
    .filter((server) => server && typeof server.command === "string" && server.command.trim())
    .map((server) => ({
      id: server.id || crypto.randomUUID(),
      name: server.name || server.command.split(/\s+/)[0] || "MCP",
      command: server.command,
      enabled: Boolean(server.enabled),
      tools: Array.isArray(server.tools) ? server.tools : [],
      toolError: server.toolError || "",
      checkedAt: typeof server.checkedAt === "number" ? server.checkedAt : undefined
    }));
}

function clearLegacyLocalRegistries() {
  localStorage.removeItem(skillsStorageKey);
  localStorage.removeItem(mcpStorageKey);
}

function clearLegacyConversationSessions() {
  localStorage.removeItem(conversationsStorageKey);
}

function clearLegacyMemories() {
  localStorage.removeItem(memoriesStorageKey);
}

function clearLegacyMemoryFile(kind: MemoryFileKind) {
  localStorage.removeItem(kind === "memory" ? memoryFileStorageKey : soulFileStorageKey);
}

function normalizeLegacyMemories(memories: MemoryItem[]) {
  return memories
    .filter((memory) => memory && typeof memory.content === "string" && memory.content.trim())
    .map((memory) => ({
      id: memory.id || crypto.randomUUID(),
      content: memory.content.trim(),
      source: memory.source || "manual",
      createdAt: memory.createdAt || Date.now(),
      updatedAt: memory.updatedAt || memory.createdAt || Date.now()
    }));
}

function loadLegacyMemories() {
  try {
    return normalizeLegacyMemories(JSON.parse(localStorage.getItem(memoriesStorageKey) || "[]") as MemoryItem[]);
  } catch {
    clearLegacyMemories();
    return [];
  }
}

function loadLegacyMemoryFile(kind: MemoryFileKind) {
  try {
    return localStorage.getItem(kind === "memory" ? memoryFileStorageKey : soulFileStorageKey) ?? "";
  } catch {
    clearLegacyMemoryFile(kind);
    return "";
  }
}

function normalizeStoredText(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}

function loadLegacyLocalRegistries() {
  try {
    return {
      skills: normalizeRegistrySkills(JSON.parse(localStorage.getItem(skillsStorageKey) || "[]") as SkillRegistryEntry[]),
      mcpServers: normalizeRegistryMcpServers(
        JSON.parse(localStorage.getItem(mcpStorageKey) || "[]") as McpRegistryEntry[]
      )
    };
  } catch {
    clearLegacyLocalRegistries();
    return {
      skills: [],
      mcpServers: []
    };
  }
}

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
    attachImage: "添加图片",
    removeImage: "移除图片",
    imageOnlyPrompt: "请分析这张图片。",
    imageAttachmentLabel: "图片",
    unsupportedImage: "只能添加 PNG、JPEG、GIF 或 WebP 图片。",
    imageTooLarge: "单张图片不能超过 8 MB。",
    imageLimitReached: "一次最多添加 4 张图片。",
    pushToTalk: "按住说话",
    roles: { user: "你", assistant: "阿福" },
    newConversation: "新对话",
    previousConversation: "上一次",
    noPreviousConversation: "暂无上一次对话",
    continueConversation: "继续",
    historyEmptyTitle: "还没有历史对话",
    historyEmptyCopy: "开始一次对话后，它会出现在这里。",
    missingApiReply: "还没有配置模型 API Key。打开设置里的模型后保存即可。",
    missingModelConfigReply: "当前模型配置不完整。请在设置 > 模型里补全 API 地址、模型名和 API Key。",
    missingVisionReply: "这条消息包含图片。请在设置 > 模型里选择一个支持图片输入的多模态模型。",
    visionUnsupportedReply: "当前多模态模型或服务端点不支持图片输入。请换成支持 vision/image input 的模型或 API 地址。",
    modelAuthReply: "模型服务鉴权失败。请检查当前模型的 API Key 是否正确。",
    modelRateLimitReply: "模型服务当前限流或额度不足，请稍后再试。",
    modelEndpointReply: "模型服务地址或接口不存在。请检查 Base URL 和所选模型是否匹配。",
    modelServiceReply: "模型服务暂时不可用，请稍后再试。",
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
    createTtsProfile: "创建语音模型",
    deleteModel: "删除模型",
    allowOnce: "允许一次",
    cancel: "取消",
    cancelledExecution: "已取消执行。",
    cancelledReason: "用户取消确认",
    confirmationTitle: "需要确认",
    noLogsTitle: "还没有执行日志",
    noLogsCopy: "打开应用、复制文本或运行命令后，记录会显示在这里。",
    noFilteredLogsTitle: "没有匹配的日志",
    noFilteredLogsCopy: "换个关键词，或调整状态和风险筛选。",
    unavailableSectionCopy: "这个设置分区暂不可用。",
    logSearchPlaceholder: "搜索标题、类型、目标或原因...",
    allStatuses: "全部状态",
    allRisks: "全部风险",
    addMemory: "添加记忆",
    deleteConversation: "删除对话",
    clearMemory: "清空记忆",
    clearHistory: "清空历史",
    clearLogs: "清空日志",
    deleteLog: "删除日志",
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
    inspectMcp: "检测工具",
    inspectingMcp: "检测中",
    mcpToolsLabel: "工具",
    mcpNoTools: "未发现工具",
    trustedSkill: "受信任",
    trustedSkillHelp: "受信任的 Skill 会把 SKILL.md 内容注入模型；未受信任时只暴露名称和路径。",
    trustedSkillOnlyMeta: "未信任，仅注入名称和路径",
    registryNamePlaceholder: "名称",
    rememberAllow: "始终允许",
    savedRulesTitle: "长期授权",
    savedRulesEmpty: "还没有保存的长期授权规则。",
    clearPermissionRules: "清空长期授权",
    deletePermissionRule: "删除授权",
    permissionsHelp: "开启自动授权后，只会直接放行低风险动作。高风险 Shell、可能提交表单的浏览器操作，以及命中阻止路径的访问仍然需要确认或会被拒绝。",
    blockedPathsHelp: "每行一个绝对路径。命中后会直接拒绝，不走自动授权。",
    skillPathPlaceholder: "本地 Skill 文件夹路径",
    mcpCommandPlaceholder: "启动命令，例如 npx -y @modelcontextprotocol/server-filesystem",
    testStt: "测试语音识别",
    testTts: "测试 TTS",
    stopVoice: "停止",
    captureGlobalShortcut: "点击后按一个主键",
    capturingGlobalShortcut: "现在按下主键",
    capturePushToTalkKey: "点击后按一个键",
    capturingPushToTalkKey: "现在按下要绑定的键",
    stopReply: "停止回复",
    sttListening: "正在听，请说一句话...",
    sttUnsupported: "当前环境不支持所选语音识别方式。",
    sttPermissionDenied: "语音识别权限被拒绝。请到 macOS 系统设置 > 隐私与安全性 > 麦克风和语音识别，允许 afuos 后重启应用。",
    sttNoSpeech: "3 秒内没有识别到语音。请检查麦克风/语音识别权限，或靠近麦克风再试一次。",
    sttNoProfileCopy: "大模型语音识别需要一个带语音识别能力的模型配置。",
    sttConfigIncompleteCopy: "语音识别模型配置不完整。请补全 API 地址、模型名和 API Key。",
    ttsNoProfileCopy: "语音回复需要一个带语音能力的模型配置。",
    ttsConfigIncompleteCopy: "语音模型配置不完整。请补全 API 地址、模型名和 API Key。",
    speechAuthCopy: "语音服务鉴权失败。请检查所选语音模型的 API Key 是否正确。",
    speechRateLimitCopy: "语音服务当前限流或额度不足，请稍后再试。",
    speechEndpointCopy: "语音服务地址或接口不存在。请检查 Base URL 和模型配置。",
    speechServiceUnavailableCopy: "语音服务暂时不可用，请稍后再试。",
    ttsLegacyConfigHint: "检测到旧版语音配置，但旧结构没有模型字段。请新建一个语音模型，并补全 model、Base URL 和 API Key。",
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
      allowShell: "自动执行低风险 Shell",
      browserAutomation: "自动执行低风险浏览器动作",
      blockedPaths: "阻止访问路径",
      memoryEnabled: "启用记忆",
      recentTurns: "最近轮数",
      summaryChars: "摘要字符数",
      longTermMemories: "长期记忆数",
      injectedMemories: "注入记忆数"
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
        copy: "管理本地技能入口和启用状态。启用项会注入后续对话上下文。"
      },
      mcp: {
        title: "MCP 配置",
        copy: "管理外部 MCP 服务的命令和启用状态。启用项会注入后续对话上下文。"
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
    attachImage: "Add image",
    removeImage: "Remove image",
    imageOnlyPrompt: "Please analyze this image.",
    imageAttachmentLabel: "Image",
    unsupportedImage: "Only PNG, JPEG, GIF, or WebP images can be attached.",
    imageTooLarge: "Each image must be 8 MB or smaller.",
    imageLimitReached: "Attach up to 4 images per message.",
    pushToTalk: "Push to talk",
    roles: { user: "You", assistant: "afu" },
    newConversation: "New chat",
    previousConversation: "Previous",
    noPreviousConversation: "No previous chat",
    continueConversation: "Continue",
    historyEmptyTitle: "No conversation history yet",
    historyEmptyCopy: "Start a chat and it will appear here.",
    missingApiReply: "No model API key is configured yet. Open Models in settings, then save.",
    missingModelConfigReply: "The active model config is incomplete. Fill in the API base URL, model name, and API key in Settings > Models.",
    missingVisionReply: "This message includes images. Select a vision-capable model in Settings > Models.",
    visionUnsupportedReply: "The selected vision model or endpoint does not support image input. Use a model/API endpoint with vision support.",
    modelAuthReply: "Model authentication failed. Check whether the current model API key is valid.",
    modelRateLimitReply: "The model service is rate-limited or out of quota. Try again later.",
    modelEndpointReply: "The model endpoint or route was not found. Check the Base URL and selected model.",
    modelServiceReply: "The model service is temporarily unavailable. Try again later.",
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
    createTtsProfile: "Create speech model",
    deleteModel: "Delete model",
    allowOnce: "Allow once",
    cancel: "Cancel",
    cancelledExecution: "Execution cancelled.",
    cancelledReason: "User cancelled confirmation",
    confirmationTitle: "Confirmation required",
    noLogsTitle: "No execution logs yet",
    noLogsCopy: "Open apps, copy text, or run commands and the records will appear here.",
    noFilteredLogsTitle: "No matching logs",
    noFilteredLogsCopy: "Try another keyword, status, or risk filter.",
    unavailableSectionCopy: "This settings section is not available yet.",
    logSearchPlaceholder: "Search title, type, target, or reason...",
    allStatuses: "All statuses",
    allRisks: "All risks",
    addMemory: "Add memory",
    deleteConversation: "Delete chat",
    clearMemory: "Clear memory",
    clearHistory: "Clear history",
    clearLogs: "Clear logs",
    deleteLog: "Delete log",
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
    inspectMcp: "Inspect tools",
    inspectingMcp: "Inspecting",
    mcpToolsLabel: "Tools",
    mcpNoTools: "No tools found",
    trustedSkill: "Trusted",
    trustedSkillHelp: "Trusted Skills inject SKILL.md content into the model. Untrusted Skills only expose name and path.",
    trustedSkillOnlyMeta: "Not trusted: only name and path are injected",
    registryNamePlaceholder: "Name",
    rememberAllow: "Always allow",
    savedRulesTitle: "Saved permissions",
    savedRulesEmpty: "No saved long-term permission rules yet.",
    clearPermissionRules: "Clear saved permissions",
    deletePermissionRule: "Delete permission",
    permissionsHelp:
      "Auto-approval only applies to low-risk actions. High-risk shell commands, browser actions with side effects, and accesses that hit blocked paths still require confirmation or are denied.",
    blockedPathsHelp: "One absolute path per line. Any matched path is denied immediately and bypasses auto-approval.",
    skillPathPlaceholder: "Local Skill folder path",
    mcpCommandPlaceholder: "Launch command, e.g. npx -y @modelcontextprotocol/server-filesystem",
    testStt: "Test speech recognition",
    testTts: "Test TTS",
    stopVoice: "Stop",
    captureGlobalShortcut: "Click, then press one key",
    capturingGlobalShortcut: "Press the main key",
    capturePushToTalkKey: "Click, then press a key",
    capturingPushToTalkKey: "Press the key to bind",
    stopReply: "Stop reply",
    sttListening: "Listening. Say one sentence...",
    sttUnsupported: "This runtime does not support the selected speech recognition mode.",
    sttPermissionDenied: "Speech recognition permission was denied. Allow afuos in macOS System Settings > Privacy & Security > Microphone and Speech Recognition, then restart the app.",
    sttNoSpeech: "No speech was recognized within 3 seconds. Check microphone/speech recognition permission or move closer to the microphone.",
    sttNoProfileCopy: "Model speech recognition needs a profile with speech recognition capability.",
    sttConfigIncompleteCopy: "The speech recognition model config is incomplete. Fill in the API base URL, model name, and API key.",
    ttsNoProfileCopy: "Speech replies need a profile with speech capability.",
    ttsConfigIncompleteCopy: "The speech model config is incomplete. Fill in the API base URL, model name, and API key.",
    speechAuthCopy: "Speech service authentication failed. Check whether the selected speech model API key is valid.",
    speechRateLimitCopy: "The speech service is rate-limited or out of quota. Try again later.",
    speechEndpointCopy: "The speech service endpoint or route was not found. Check the Base URL and model config.",
    speechServiceUnavailableCopy: "The speech service is temporarily unavailable. Try again later.",
    ttsLegacyConfigHint:
      "A legacy speech config was detected, but the old format had no model field. Create a speech profile and fill in the model, base URL, and API key.",
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
      allowShell: "Auto-run low-risk shell",
      browserAutomation: "Auto-run low-risk browser actions",
      blockedPaths: "Blocked paths",
      memoryEnabled: "Memory enabled",
      recentTurns: "Recent turns",
      summaryChars: "Summary chars",
      longTermMemories: "Long-term memories",
      injectedMemories: "Injected memories"
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
        copy: "Manage local skill entries and enabled state. Enabled entries are injected into future model context."
      },
      mcp: {
        title: "MCP configurations",
        copy: "Manage external MCP service commands and enabled state. Enabled entries are injected into future model context."
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

function createMessage(
  role: ChatMessage["role"],
  content: string,
  imageAttachments: ImageAttachment[] = []
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    ...(imageAttachments.length > 0 ? { imageAttachments } : {})
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
  const firstUserMessage = messages.find((message) => message.role === "user");
  const title = firstUserMessage ? messageSummaryText(firstUserMessage) : "";
  if (!title) {
    return "新对话";
  }

  return title.length > 22 ? `${title.slice(0, 22)}...` : title;
}

function loadLegacyConversationSessions(): ChatSession[] {
  const saved = localStorage.getItem(conversationsStorageKey);
  if (!saved) {
    return [];
  }

  try {
    return (JSON.parse(saved) as ChatSession[])
      .filter((session) => session && session.id && Array.isArray(session.messages))
      .map((session) => {
        const createdAt = typeof session.createdAt === "number" ? session.createdAt : Date.now();
        const messages = session.messages
          .filter((message) => message && typeof message.role === "string" && typeof message.content === "string")
          .map((message, index) => ({
            id: message.id || crypto.randomUUID(),
            role: message.role,
            content: message.content,
            createdAt: typeof message.createdAt === "number" ? message.createdAt : createdAt + index,
            ...(Array.isArray(message.imageAttachments) && message.imageAttachments.length > 0
              ? { imageAttachments: message.imageAttachments }
              : {})
          }));

        return {
          id: session.id,
          title: session.title || deriveSessionTitle(messages),
          summary: session.summary || "",
          messages,
          createdAt,
          updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : createdAt
        };
      })
      .sort((first, second) => second.updatedAt - first.updatedAt);
  } catch {
    clearLegacyConversationSessions();
    return [];
  }
}

async function migrateLegacyConversationSessions(sessions: ChatSession[]) {
  for (const session of sessions) {
    if (session.messages.length === 0) {
      continue;
    }

    await saveConversation({
      id: session.id,
      title: session.title,
      summary: session.summary,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map((message, index) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        imageAttachments: message.imageAttachments || [],
        createdAt: message.createdAt || session.createdAt + index
      }))
    });
  }
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

function messageSummaryText(message: ChatMessage) {
  const text = normalizeInlineText(message.content);
  const imageCount = message.imageAttachments?.length || 0;
  if (imageCount === 0) {
    return text;
  }
  const imageLabel = imageCount === 1 ? "[图片]" : `[${imageCount} 张图片]`;
  return text ? `${text} ${imageLabel}` : imageLabel;
}

type MessageContentSegment =
  | { type: "text"; content: string }
  | { type: "image"; alt: string; src: string };

function resolveAssistantImageSource(rawSource: string) {
  const trimmed = rawSource.trim();
  if (!trimmed) {
    return "";
  }

  if (
    trimmed.startsWith("data:image/") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("asset:") ||
    trimmed.startsWith("http://asset.localhost/")
  ) {
    return trimmed;
  }

  if (trimmed.startsWith("file://")) {
    if (!isTauriRuntime()) {
      return trimmed;
    }

    try {
      const url = new URL(trimmed);
      return convertFileSrc(decodeURIComponent(url.pathname));
    } catch {
      return trimmed;
    }
  }

  if (trimmed.startsWith("/") && isTauriRuntime()) {
    return convertFileSrc(trimmed);
  }

  return "";
}

function parseImageSource(markdownSource: string) {
  const trimmed = markdownSource.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }

  const titleStart = trimmed.search(/\s+"[^"]*"\s*$/);
  if (titleStart >= 0) {
    return trimmed.slice(0, titleStart).trim();
  }

  return trimmed;
}

function looksLikeStandaloneImageSource(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (
    trimmed.startsWith("data:image/") ||
    trimmed.startsWith("asset:") ||
    trimmed.startsWith("http://asset.localhost/")
  ) {
    return true;
  }

  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i.test(trimmed)) {
    return true;
  }

  if (/^(file:\/\/|\/)\S+\.(png|jpe?g|gif|webp|svg)$/i.test(trimmed)) {
    return true;
  }

  return false;
}

function pushTextAndImageLines(segments: MessageContentSegment[], content: string) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return;
  }

  let pendingText: string[] = [];
  const flushPendingText = () => {
    if (pendingText.length > 0) {
      segments.push({ type: "text", content: pendingText.join("\n") });
      pendingText = [];
    }
  };

  for (const line of lines) {
    if (looksLikeStandaloneImageSource(line)) {
      const resolvedSource = resolveAssistantImageSource(line);
      if (resolvedSource) {
        flushPendingText();
        segments.push({ type: "image", alt: "assistant-image", src: resolvedSource });
        continue;
      }
    }
    pendingText.push(line);
  }

  flushPendingText();
}

function parseMessageContent(content: string): MessageContentSegment[] {
  const segments: MessageContentSegment[] = [];
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let lastIndex = 0;

  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    const textBefore = content.slice(lastIndex, index);
    pushTextAndImageLines(segments, textBefore);

    const resolvedSource = resolveAssistantImageSource(parseImageSource(match[2] || ""));
    if (resolvedSource) {
      segments.push({
        type: "image",
        alt: match[1]?.trim() || "assistant-image",
        src: resolvedSource
      });
    } else if (match[0]?.trim()) {
      segments.push({ type: "text", content: match[0].trim() });
    }

    lastIndex = index + match[0].length;
  }

  const trailingText = content.slice(lastIndex);
  pushTextAndImageLines(segments, trailingText);

  return segments;
}

function isSupportedImageFile(file: File) {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type);
}

function readImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: crypto.randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        dataUrl: String(reader.result),
        size: file.size
      });
    };
    reader.onerror = () => reject(reader.error || new Error("image_read_failed"));
    reader.readAsDataURL(file);
  });
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
      const content = messageSummaryText(message);
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
  registryContext: string,
  sessionSummary: string,
  messages: ChatMessage[]
): ChatMessage[] {
  const memoryConfig = config.memory;
  const contextMessages: ChatMessage[] = [createSystemPrompt(soulContent)];
  const recentMessages = config.memory.enabled ? messages.slice(-recentMessageLimit(memoryConfig)) : messages;

  if (config.memory.enabled) {
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
  }

  if (registryContext.trim()) {
    contextMessages.push({
      id: "local-registries",
      role: "system",
      content: registryContext
    });
  }

  return [...contextMessages, ...recentMessages];
}

function buildRegistryContext(
  skills: SkillRegistryEntry[],
  mcpServers: McpRegistryEntry[],
  skillDocuments: SkillDocument[] = []
) {
  const enabledSkills = skills.filter((skill) => skill.enabled && skill.path.trim());
  const enabledMcpServers = mcpServers.filter((server) => server.enabled && server.command.trim());

  if (enabledSkills.length === 0 && enabledMcpServers.length === 0) {
    return "";
  }

  const sections = [
    "以下是用户在设置中启用的本地能力注册表。它们用于理解用户环境、建议下一步或解释可用能力；Skill 主要作为上下文注入，MCP 目前支持显式调用，涉及执行时仍需走现有本地动作和确认流程。",
  ];

  if (enabledSkills.length > 0) {
    sections.push(
      `启用的 Skills:\n${enabledSkills
        .slice(0, 12)
        .map((skill, index) => {
          const document = skillDocuments[index];
          const name = document?.name || skill.name || "Skill";
          const header = `- ${truncateText(name, 80)}: ${truncateText(document?.path || skill.path, 220)}`;
          if (!document) {
            return header;
          }
          if (document.error) {
            return `${header}\n  读取状态: ${truncateText(document.error, 180)}`;
          }
          if (!document.content.trim()) {
            return `${header}\n  读取状态: 未信任，仅注入名称和路径`;
          }
          return `${header}\n  说明片段:\n${truncateText(document.content.trim(), 1600)
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")}`;
        })
        .join("\n")}`
    );
  }

  if (enabledMcpServers.length > 0) {
    sections.push(
      `启用的 MCP 服务配置:\n${enabledMcpServers
        .slice(0, 12)
        .map((server) => {
          const commandInfo = parseMcpCommand(server.command);
          const sanitizedCommand = sanitizeModelContextText(server.command, 240);
          const sanitizedArgs = sanitizeModelContextText(commandInfo.args.join(" "), 220);
          const toolLines = (server.tools || [])
            .slice(0, 20)
            .map((tool) =>
              `  工具: ${truncateText(tool.name, 120)}${tool.description ? ` - ${truncateText(tool.description, 220)}` : ""}`
            );
          return [
            `- ${truncateText(server.name || commandInfo.executable || "MCP", 80)}: ${sanitizedCommand}`,
            commandInfo.executable ? `  启动程序: ${truncateText(commandInfo.executable, 120)}` : "",
            commandInfo.args.length > 0 ? `  参数: ${sanitizedArgs}` : "",
            server.toolError ? `  检测状态: ${sanitizeModelContextText(server.toolError, 220)}` : "",
            ...toolLines
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n")}`
    );
  }

  return sections.join("\n\n");
}

function trustedSkillPaths(config?: AppConfig | null) {
  return new Set((config?.permissions.trustedSkills || []).map((path) => path.trim()).filter(Boolean));
}

function parseMcpCommand(command: string) {
  const parsed = parseCommandArgv(command);
  const normalized = "error" in parsed ? [] : parsed.argv;
  return {
    executable: normalized[0] || "",
    args: normalized.slice(1, 8),
    error: "error" in parsed ? parsed.error : ""
  };
}

function parseCommandArgv(command: string): { argv: string[] } | { error: string } {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let inToken = false;
  const trimmed = command.trim();

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote) {
      if (character === quote) {
        quote = "";
        continue;
      }
      if (quote === "\"" && character === "\\" && index + 1 < trimmed.length) {
        index += 1;
        current += trimmed[index];
        inToken = true;
        continue;
      }
      current += character;
      inToken = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      inToken = true;
      continue;
    }

    if (character === "\\" && index + 1 < trimmed.length) {
      index += 1;
      current += trimmed[index];
      inToken = true;
      continue;
    }

    if (isShellControlCharacter(character)) {
      return { error: "MCP 命令不允许使用 shell 控制符，请只填写程序和参数。" };
    }

    current += character;
    inToken = true;
  }

  if (quote) {
    return { error: "MCP 命令包含未闭合的引号。" };
  }
  if (inToken) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return { error: "MCP 命令为空。" };
  }
  return { argv: tokens };
}

function isShellControlCharacter(character: string) {
  return [";", "|", "&", ">", "<", "`"].includes(character);
}

type ParsedMcpToolCall =
  | {
      server: McpRegistryEntry;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | { error: string };

function parseMcpToolCall(text: string, mcpServers: McpRegistryEntry[]): ParsedMcpToolCall | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const prefixes = ["调用 mcp 工具", "调用mcp工具", "调用 mcp", "调用mcp", "call mcp tool", "call mcp"];
  const prefix = prefixes.find((candidate) => lower.startsWith(candidate.toLowerCase()));
  if (!prefix) {
    return null;
  }

  const body = trimmed.slice(prefix.length).trim();
  if (!body) {
    return { error: "请指定要调用的 MCP 工具名，例如：调用 MCP 工具 search 参数 {\"query\":\"afuos\"}" };
  }

  const { toolSpec, rawArguments } = splitMcpToolCallBody(body);
  if (!toolSpec) {
    return { error: "请指定要调用的 MCP 工具名。" };
  }

  const parsedArguments = parseMcpToolArguments(rawArguments);
  if ("error" in parsedArguments) {
    return parsedArguments;
  }

  const enabledServers = mcpServers.filter((server) => server.enabled && server.command.trim());
  if (enabledServers.length === 0) {
    return { error: "没有启用的 MCP 服务。请先在设置 > MCP 添加并启用服务。" };
  }

  const { serverHint, toolName } = splitMcpToolSpec(toolSpec);
  const server = resolveMcpToolServer(enabledServers, toolName, serverHint);
  if ("error" in server) {
    return server;
  }

  return {
    server,
    toolName,
    arguments: parsedArguments.arguments
  };
}

function splitMcpToolCallBody(body: string) {
  const markers = [" 参数 ", " 参数", " with ", " args ", " arguments "];
  const match = markers
    .map((marker) => {
      const index = body.toLowerCase().indexOf(marker.trim().toLowerCase());
      return index >= 0 ? { marker, index } : null;
    })
    .filter((item): item is { marker: string; index: number } => Boolean(item))
    .sort((first, second) => first.index - second.index)[0];

  if (!match) {
    return {
      toolSpec: cleanMcpToken(body),
      rawArguments: ""
    };
  }

  return {
    toolSpec: cleanMcpToken(body.slice(0, match.index)),
    rawArguments: body.slice(match.index + match.marker.trim().length).trim()
  };
}

function parseMcpToolArguments(raw: string): { arguments: Record<string, unknown> } | { error: string } {
  if (!raw) {
    return { arguments: {} };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return { error: "MCP 工具参数必须是 JSON 对象，例如 {\"query\":\"afuos\"}。" };
    }
    return { arguments: parsed as Record<string, unknown> };
  } catch {
    return { error: "MCP 工具参数不是有效 JSON。请使用类似 {\"query\":\"afuos\"} 的对象。" };
  }
}

function splitMcpToolSpec(spec: string) {
  const cleaned = cleanMcpToken(spec);
  const dotIndex = cleaned.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < cleaned.length - 1) {
    return {
      serverHint: cleaned.slice(0, dotIndex),
      toolName: cleaned.slice(dotIndex + 1)
    };
  }
  return {
    serverHint: "",
    toolName: cleaned
  };
}

function resolveMcpToolServer(
  servers: McpRegistryEntry[],
  toolName: string,
  serverHint: string
): McpRegistryEntry | { error: string } {
  const normalizedTool = toolName.toLowerCase();
  const normalizedHint = serverHint.toLowerCase();
  const hintedServers = normalizedHint
    ? servers.filter((server) => {
        const commandInfo = parseMcpCommand(server.command);
        return [server.name, commandInfo.executable, server.command]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedHint));
      })
    : servers;

  if (hintedServers.length === 0) {
    return { error: `没有找到匹配的 MCP 服务：${serverHint}` };
  }

  const toolMatches = hintedServers.filter((server) =>
    (server.tools || []).some((tool) => tool.name.toLowerCase() === normalizedTool)
  );
  if (toolMatches.length === 1) {
    return toolMatches[0];
  }
  if (toolMatches.length > 1) {
    return { error: `多个 MCP 服务都包含工具 ${toolName}，请使用 服务名.${toolName} 指定。` };
  }
  if (hintedServers.length === 1) {
    return hintedServers[0];
  }

  return { error: `没有找到已检测到的 MCP 工具：${toolName}。请先在设置 > MCP 点击“检测工具”。` };
}

function cleanMcpToken(value: string) {
  return value
    .trim()
    .replace(/^工具\s*/i, "")
    .trim()
    .replace(/^["'“”]+|["'“”。，,]+$/g, "")
    .trim();
}

function createInitialConversationState(): ConversationState {
  const sessions = loadLegacyConversationSessions();
  if (sessions.length > 0) {
    return {
      activeSessionId: sessions[0].id,
      messages: sessions[0].messages,
      sessions
    };
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

  return (
    config.models.profiles.find((profile) => profile.id === selectedId && profile.capabilities.includes(kind)) ||
    config.models.profiles.find((profile) => profile.capabilities.includes(kind))
  );
}

function canStartSpeechInput(config?: AppConfig | null) {
  if (!config) {
    return false;
  }
  if (config.voice.sttMode !== "model") {
    return true;
  }
  return Boolean(selectedProfile(config, "stt"));
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

function blurNonEditableActiveElement() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || isEditableKeyboardTarget(active)) {
    return;
  }

  active.blur();
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

function permissionRuleTitle(actionType: string) {
  switch (actionType) {
    case "shell":
      return "Shell";
    case "browser_search":
      return "浏览器搜索";
    case "open_url":
      return "打开网址";
    case "open_path":
      return "打开路径";
    case "open_app":
      return "打开应用";
    case "mcp_tool":
      return "MCP 工具";
    default:
      return actionType;
  }
}

function displayPermissionTarget(target: string) {
  return redactSensitiveText(target);
}

function sanitizeModelContextText(value: string, maxChars: number) {
  return truncateText(redactSensitiveText(value), maxChars);
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\b(bearer\s+)[^\s"',;&]+/gi, "$1[redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|authorization|password|secret|token)(\s*[=:]\s*["']?)[^"',;&\s]+(["']?)/gi,
      "$1$2[redacted]$3"
    )
    .replace(
      /(--?(?:api[_-]?key|access[_-]?token|authorization|password|secret|token)\b(?:\s+|=)["']?)[^"',;&\s]+(["']?)/gi,
      "$1[redacted]$2"
    );
}

function canRememberPermission(confirmation: PendingConfirmation) {
  return confirmation.riskLevel === "low";
}

function errorActionCopy(error: string, copy: (typeof uiCopy)[Language]) {
  if (error === "missing_api_key") {
    return copy.configureApiKey;
  }
  if (error === "missing_model_config") {
    return copy.viewModelConfig;
  }

  if (error === "missing_vision_model" || error === "vision_model_unsupported") {
    return copy.viewModelConfig;
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

function parseHttpErrorStatus(error: string, prefix: string) {
  const match = new RegExp(`^${prefix}:(\\d{3})\\b`).exec(error);
  if (!match) {
    return null;
  }
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}

function formatModelHttpError(error: string, copy: (typeof uiCopy)[Language]) {
  const status = parseHttpErrorStatus(error, "model_http_error");
  if (!status) {
    return null;
  }
  if (status === 401 || status === 403) {
    return copy.modelAuthReply;
  }
  if (status === 404) {
    return copy.modelEndpointReply;
  }
  if (status === 429) {
    return copy.modelRateLimitReply;
  }
  if (status >= 500) {
    return copy.modelServiceReply;
  }
  return null;
}

function formatSpeechHttpError(error: string, prefix: "stt_http_error" | "tts_http_error", copy: (typeof uiCopy)[Language]) {
  const status = parseHttpErrorStatus(error, prefix);
  if (!status) {
    return null;
  }
  if (status === 401 || status === 403) {
    return copy.speechAuthCopy;
  }
  if (status === 404) {
    return copy.speechEndpointCopy;
  }
  if (status === 429) {
    return copy.speechRateLimitCopy;
  }
  if (status >= 500) {
    return copy.speechServiceUnavailableCopy;
  }
  return null;
}

function chatErrorReply(error: string, copy: (typeof uiCopy)[Language]) {
  if (error === "missing_api_key") {
    return copy.missingApiReply;
  }
  if (error === "missing_model_config" || error === "missing_base_url" || error === "missing_model") {
    return copy.missingModelConfigReply;
  }
  if (error === "missing_vision_model") {
    return copy.missingVisionReply;
  }
  if (error === "vision_model_unsupported") {
    return copy.visionUnsupportedReply;
  }
  const formattedHttpError = formatModelHttpError(error, copy);
  if (formattedHttpError) {
    return formattedHttpError;
  }
  return `${copy.chatFailurePrefix}${error}`;
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
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isExpandedPinned, setIsExpandedPinned] = useState(false);
  const [activeSettings, setActiveSettings] = useState<SettingsSectionId>("general");
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>([]);
  const [permissionRules, setPermissionRules] = useState<PermissionRule[]>([]);
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
  const [skillDraft, setSkillDraft] = useState("");
  const [mcpDraft, setMcpDraft] = useState("");
  const [mcpCheckingId, setMcpCheckingId] = useState("");
  const [sttTestResult, setSttTestResult] = useState("");
  const [ttsTestResult, setTtsTestResult] = useState("");
  const [speechProcessing, setSpeechProcessing] = useState(false);
  const [activeChatRequestId, setActiveChatRequestId] = useState("");
  const [capturingGlobalShortcut, setCapturingGlobalShortcut] = useState(false);
  const [capturingPushToTalkKey, setCapturingPushToTalkKey] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const errorRef = useRef(error);
  const statusRef = useRef(status);
  const conversationRef = useRef(conversationState);
  const configRef = useRef<AppConfig | null>(config);
  const draftConfigRef = useRef<AppConfig | null>(draftConfig);
  const capturingGlobalShortcutRef = useRef(capturingGlobalShortcut);
  const capturingPushToTalkKeyRef = useRef(capturingPushToTalkKey);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const hotwordRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const hotwordRestartTimerRef = useRef<number | undefined>();
  const speechSilenceTimerRef = useRef<number | undefined>();
  const speechActivityPollerRef = useRef<number | undefined>();
  const speechAudioContextRef = useRef<AudioContext | null>(null);
  const recognizedSpeechRef = useRef(false);
  const speechProcessingRef = useRef(false);
  const speechRequestIdRef = useRef(0);
  const cancelledSpeechRequestIdRef = useRef(0);
  const latestSpeechTranscriptRef = useRef("");
  const sendInFlightRef = useRef(false);
  const sendCooldownUntilRef = useRef(0);
  const activeChatRequestIdRef = useRef("");
  const cancelledChatRequestIdRef = useRef("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const submittedSpeechTextRef = useRef("");
  const submittedSpeechAtRef = useRef(0);
  const lastSubmittedTextRef = useRef("");
  const lastSubmittedAtRef = useRef(0);
  const activeSubmissionKeyRef = useRef("");
  const recentSubmissionKeysRef = useRef<Map<string, number>>(new Map());
  const conversationSaveQueueRef = useRef<{
    inFlight: boolean;
    latest: ConversationSavePayload | null;
    lastError: string;
  }>({
    inFlight: false,
    latest: null,
    lastError: ""
  });
  const micHoldActiveRef = useRef(false);
  const keyHoldActiveRef = useRef(false);
  const suppressNextMicClickRef = useRef(false);
  const voiceAutoSendTimerRef = useRef<number | undefined>();

  useEffect(() => {
    errorRef.current = error;
  }, [error]);

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

    queueConversationSave({
      id: session.id,
      title: session.title,
      summary: session.summary,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map((message, index) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        imageAttachments: message.imageAttachments || [],
        createdAt: message.createdAt || session.createdAt + index
      }))
    });
  }

  function queueConversationSave(payload: ConversationSavePayload) {
    const queue = conversationSaveQueueRef.current;
    queue.latest = payload;
    if (!queue.inFlight) {
      void flushConversationSaveQueue();
    }
  }

  async function flushConversationSaveQueue() {
    const queue = conversationSaveQueueRef.current;
    if (queue.inFlight) {
      return;
    }

    while (queue.latest) {
      const payload = queue.latest;
      queue.latest = null;
      queue.inFlight = true;
      try {
        await saveConversation(payload);
        if (queue.lastError) {
          const previousSaveError = queue.lastError;
          queue.lastError = "";
          if (errorRef.current === previousSaveError) {
            setError("");
            setStatus((current) => (current === "error" ? "idle" : current));
          }
        }
      } catch (saveError) {
        const message = String(saveError);
        queue.lastError = message;
        setError(message);
        setStatus("error");
      } finally {
        queue.inFlight = false;
      }
    }
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

  function appendMessagePair(current: ChatMessage[], userMessage: ChatMessage, assistantMessage: ChatMessage) {
    const now = Date.now();
    for (let index = Math.max(0, current.length - 4); index < current.length - 1; index += 1) {
      const existingUser = current[index];
      const existingAssistant = current[index + 1];
      const existingImageKey = (existingUser?.imageAttachments || []).map((image) => `${image.id}:${image.size}`).join("|");
      const nextImageKey = (userMessage.imageAttachments || []).map((image) => `${image.id}:${image.size}`).join("|");
      if (
        existingUser?.role === "user" &&
        existingAssistant?.role === "assistant" &&
        normalizedSpeechText(existingUser.content) === normalizedSpeechText(userMessage.content) &&
        existingImageKey === nextImageKey &&
        now - (existingUser.createdAt || 0) < 5000
      ) {
        return current;
      }
    }
    return [...current, userMessage, assistantMessage];
  }

  function createSubmissionKey(content: string, imageAttachments: ImageAttachment[]) {
    const normalizedContent = normalizedSpeechText(content);
    const imageKey = imageAttachments.map((image) => `${image.id}:${image.size}`).join("|");
    return `${normalizedContent}__${imageKey}`;
  }

  function shouldRejectSubmission(submissionKey: string, bypassCooldown: boolean) {
    const now = Date.now();
    for (const [key, timestamp] of recentSubmissionKeysRef.current.entries()) {
      if (now - timestamp >= 5000) {
        recentSubmissionKeysRef.current.delete(key);
      }
    }

    if (sendInFlightRef.current) {
      return true;
    }
    if (!bypassCooldown && now < sendCooldownUntilRef.current) {
      return true;
    }
    if (activeSubmissionKeyRef.current === submissionKey) {
      return true;
    }

    const lastAcceptedAt = recentSubmissionKeysRef.current.get(submissionKey) || 0;
    return now - lastAcceptedAt < 5000;
  }

  function startNewConversation() {
    if (statusRef.current === "executing") {
      return;
    }
    stopTransientInteraction();
    discardPendingConfirmation();
    if (conversationRef.current.messages.length === 0) {
      setInput("");
      setPendingImages([]);
      setError("");
      pinExpandAssistant();
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
    setPendingImages([]);
    setError("");
    setStatus((current) => (current === "error" ? "idle" : current));
    pinExpandAssistant();
    markConversationActivity();
    window.setTimeout(() => inputRef.current?.focus(), 80);
  }

  function resumeConversation(sessionId: string) {
    if (statusRef.current === "executing") {
      return;
    }
    const session = conversationRef.current.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    stopTransientInteraction();
    discardPendingConfirmation();
    updateConversationState((current) => ({
      ...current,
      activeSessionId: session.id,
      messages: session.messages
    }));
    setInput("");
    setPendingImages([]);
    setError("");
    setSettingsOpen(false);
    pinExpandAssistant();
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

  async function removeConversation(sessionId: string) {
    if (statusRef.current === "executing") {
      return;
    }
    const target = conversationRef.current.sessions.find((session) => session.id === sessionId);
    if (!target) {
      return;
    }

    stopTransientInteraction();
    discardPendingConfirmation();
    try {
      await deleteConversation(sessionId);
    } catch (deleteError) {
      setError(String(deleteError));
      setStatus("error");
      return;
    }

    updateConversationState((current) => {
      const remainingSessions = current.sessions.filter((session) => session.id !== sessionId);
      if (remainingSessions.length === 0) {
        const session = createSession();
        return {
          activeSessionId: session.id,
          messages: [],
          sessions: [session]
        };
      }

      const nextActiveSession =
        current.activeSessionId === sessionId
          ? remainingSessions[0]
          : remainingSessions.find((session) => session.id === current.activeSessionId) || remainingSessions[0];

      return {
        activeSessionId: nextActiveSession.id,
        messages: nextActiveSession.id === current.activeSessionId ? current.messages : nextActiveSession.messages,
        sessions: remainingSessions
      };
    });
    setError("");
    setPendingImages([]);
    setStatus((current) => (current === "error" ? "idle" : current));
  }

  async function removeAllConversations() {
    if (statusRef.current === "executing") {
      return;
    }
    stopTransientInteraction();
    discardPendingConfirmation();
    try {
      await clearConversations();
    } catch (clearError) {
      setError(String(clearError));
      setStatus("error");
      return;
    }

    const session = createSession();
    updateConversationState(() => ({
      activeSessionId: session.id,
      messages: [],
      sessions: [session]
    }));
    setInput("");
    setPendingImages([]);
    setError("");
    setStatus((current) => (current === "error" ? "idle" : current));
  }

  async function removeAllExecutionLogs() {
    try {
      await clearExecutionLogs();
      setExecutionLogs([]);
      setError("");
      setStatus((current) => (current === "error" ? "idle" : current));
    } catch (clearError) {
      setError(String(clearError));
      setStatus("error");
    }
  }

  async function removeExecutionLog(logId: string) {
    try {
      await deleteExecutionLog(logId);
      setExecutionLogs((current) => current.filter((log) => log.id !== logId));
      setError("");
      setStatus((current) => (current === "error" ? "idle" : current));
    } catch (deleteError) {
      setError(String(deleteError));
      setStatus("error");
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

  async function refreshPermissionRules() {
    try {
      setPermissionRules(await listPermissionRules());
    } catch (permissionError) {
      setError(String(permissionError));
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

  async function migrateLegacyMemoryData() {
    if (!isTauriRuntime()) {
      return;
    }

    await migrateLegacyMemoryItems();
    await migrateLegacyMemoryFile("memory");
    await migrateLegacyMemoryFile("soul");
  }

  async function migrateLegacyMemoryItems() {
    const legacyMemories = loadLegacyMemories();
    if (legacyMemories.length === 0) {
      return;
    }

    const existingMemories = await listMemories();
    const existingIds = new Set(existingMemories.map((memory) => memory.id).filter(Boolean));
    const existingContent = new Set(existingMemories.map((memory) => normalizeStoredText(memory.content)));
    const importableMemories = legacyMemories.filter(
      (memory) => !existingIds.has(memory.id) && !existingContent.has(normalizeStoredText(memory.content))
    );

    if (importableMemories.length > 0) {
      await importMemories(importableMemories);
    }
    clearLegacyMemories();
  }

  async function migrateLegacyMemoryFile(kind: MemoryFileKind) {
    const legacyContent = loadLegacyMemoryFile(kind);
    const normalizedLegacyContent = normalizeStoredText(legacyContent);
    if (!normalizedLegacyContent) {
      return;
    }

    const currentFile = await loadMemoryFile(kind);
    const normalizedCurrentContent = normalizeStoredText(currentFile.content);
    const canMigrate =
      kind === "memory"
        ? normalizedCurrentContent === ""
        : normalizedCurrentContent === "" ||
          normalizedCurrentContent === normalizeStoredText(fallbackSoulPrompt) ||
          normalizedCurrentContent === normalizeStoredText(defaultSoulTemplate);

    if (canMigrate) {
      await saveMemoryFile(kind, legacyContent);
      clearLegacyMemoryFile(kind);
      return;
    }

    if (normalizedCurrentContent === normalizedLegacyContent) {
      clearLegacyMemoryFile(kind);
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

  function updateDraftSkills(updater: (current: SkillRegistryEntry[]) => SkillRegistryEntry[]) {
    updateDraft((current) => ({
      ...current,
      registries: {
        ...current.registries,
        skills: updater(current.registries.skills)
      }
    }));
  }

  function toggleTrustedSkill(path: string) {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }

    updateDraft((current) => {
      const trusted = new Set(current.permissions.trustedSkills.map((item) => item.trim()).filter(Boolean));
      if (trusted.has(normalizedPath)) {
        trusted.delete(normalizedPath);
      } else {
        trusted.add(normalizedPath);
      }
      return {
        ...current,
        permissions: {
          ...current.permissions,
          trustedSkills: Array.from(trusted)
        }
      };
    });
  }

  function updateSkillEntry(
    id: string,
    patch: {
      name?: string;
      path?: string;
    }
  ) {
    updateDraft((current) => {
      const existing = current.registries.skills.find((skill) => skill.id === id);
      if (!existing) {
        return current;
      }

      const nextPath = patch.path ?? existing.path;
      const nextSkills = current.registries.skills.map((skill) =>
        skill.id === id
          ? {
              ...skill,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.path !== undefined ? { path: patch.path } : {})
            }
          : skill
      );

      const trustedSkills = current.permissions.trustedSkills.map((trustedPath) => {
        if (trustedPath.trim() !== existing.path.trim()) {
          return trustedPath;
        }
        return nextPath;
      });

      return {
        ...current,
        registries: {
          ...current.registries,
          skills: nextSkills
        },
        permissions: {
          ...current.permissions,
          trustedSkills
        }
      };
    });
  }

  function updateDraftMcpServers(updater: (current: McpRegistryEntry[]) => McpRegistryEntry[]) {
    updateDraft((current) => ({
      ...current,
      registries: {
        ...current.registries,
        mcpServers: updater(current.registries.mcpServers)
      }
    }));
  }

  function updateMcpEntry(
    id: string,
    patch: {
      name?: string;
      command?: string;
    }
  ) {
    updateDraftMcpServers((current) =>
      current.map((server) => {
        if (server.id !== id) {
          return server;
        }

        const nextCommand = patch.command ?? server.command;
        const commandChanged = patch.command !== undefined && patch.command !== server.command;
        return {
          ...server,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.command !== undefined ? { command: patch.command } : {}),
          ...(commandChanged
            ? {
                tools: [],
                toolError: "",
                checkedAt: undefined,
                name: patch.name !== undefined ? patch.name : nextCommand.split(/\s+/)[0] || server.name
              }
            : {})
        };
      })
    );
  }

  async function loadEnabledSkillRegistryDocuments(): Promise<SkillDocument[]> {
    const trustedPaths = trustedSkillPaths(configRef.current);
    const enabledSkills = savedSkills.filter((skill) => skill.enabled && skill.path.trim());
    if (enabledSkills.length === 0) {
      return [];
    }

    const trustedEnabledSkills = enabledSkills.filter((skill) => trustedPaths.has(skill.path.trim()));
    if (trustedEnabledSkills.length === 0) {
      return enabledSkills.map((skill) => ({
        path: skill.path,
        name: skill.name || skill.path.split("/").filter(Boolean).pop() || "Skill",
        content: "",
        error: ""
      }));
    }

    try {
      const trustedDocuments = await loadSkillDocuments(trustedEnabledSkills.map((skill) => skill.path));
      const trustedDocumentsBySkillPath = new Map(
        trustedEnabledSkills.map((skill, index) => [skill.path.trim(), trustedDocuments[index]] as const)
      );
      return enabledSkills.map((skill) => {
        const trustedDocument = trustedDocumentsBySkillPath.get(skill.path.trim());
        if (trustedDocument) {
          return trustedDocument;
        }
        return {
          path: skill.path,
          name: skill.name || skill.path.split("/").filter(Boolean).pop() || "Skill",
          content: "",
          error: ""
        };
      });
    } catch (skillError) {
      return enabledSkills.map((skill) => ({
        path: skill.path,
        name: skill.name || skill.path.split("/").filter(Boolean).pop() || "Skill",
        content: "",
        error: trustedPaths.has(skill.path.trim()) ? String(skillError) : ""
      }));
    }
  }

  function addSkillEntry() {
    const path = skillDraft.trim();
    if (!path) {
      return;
    }
    updateDraftSkills((current) => [
      {
        id: crypto.randomUUID(),
        name: path.split("/").filter(Boolean).pop() || "Skill",
        path,
        enabled: true
      },
      ...current
    ]);
    setSkillDraft("");
  }

  function addMcpEntry() {
    const command = mcpDraft.trim();
    if (!command) {
      return;
    }
    const commandInfo = parseMcpCommand(command);
    const entry = {
      id: crypto.randomUUID(),
      name: commandInfo.executable || command.split(/\s+/)[0] || "MCP",
      command,
      enabled: true,
      tools: [],
      toolError: commandInfo.error
    };
    updateDraftMcpServers((current) => [entry, ...current]);
    setMcpDraft("");
    if (!commandInfo.error) {
      void inspectMcpCommand(entry.id, entry.command, entry.name);
    }
  }

  async function inspectMcpCommand(id: string, command: string, fallbackName: string) {
    if (!command.trim() || mcpCheckingId) {
      return;
    }

    const commandInfo = parseMcpCommand(command);
    if (commandInfo.error) {
      updateDraftMcpServers((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                tools: [],
                toolError: commandInfo.error,
                checkedAt: Date.now()
              }
            : item
        )
      );
      return;
    }

    setMcpCheckingId(id);
    try {
      const result = await inspectMcpServer(command);
      updateDraftMcpServers((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                name: result.serverName || fallbackName || item.name,
                tools: result.tools,
                toolError: result.error || (result.status === "empty" ? copy.mcpNoTools : ""),
                checkedAt: Date.now()
              }
            : item
        )
      );
    } catch (inspectError) {
      updateDraftMcpServers((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                tools: [],
                toolError: String(inspectError),
                checkedAt: Date.now()
              }
            : item
        )
      );
    } finally {
      setMcpCheckingId("");
    }
  }

  async function inspectMcpEntry(id: string) {
    const server = draftMcpServers.find((item) => item.id === id);
    if (!server) {
      return;
    }

    await inspectMcpCommand(server.id, server.command, server.name);
  }

  function toggleMcpEntry(id: string) {
    const server = draftMcpServers.find((item) => item.id === id);
    if (!server) {
      return;
    }

    const nextEnabled = !server.enabled;
    updateDraftMcpServers((current) =>
      current.map((item) => (item.id === id ? { ...item, enabled: nextEnabled } : item))
    );

    if (nextEnabled && !server.checkedAt) {
      void inspectMcpCommand(server.id, server.command, server.name);
    }
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

  function clearVoiceAutoSendTimer() {
    if (voiceAutoSendTimerRef.current !== undefined) {
      window.clearTimeout(voiceAutoSendTimerRef.current);
      voiceAutoSendTimerRef.current = undefined;
    }
  }

  function scheduleVoiceAutoSend(updateTestResult: boolean, transcript: string) {
    if (!shouldAutoSendVoice(updateTestResult)) {
      return;
    }

    const text = transcript.trim();
    if (!text) {
      return;
    }

    clearVoiceAutoSendTimer();
    voiceAutoSendTimerRef.current = window.setTimeout(() => {
      voiceAutoSendTimerRef.current = undefined;
      void handleSend(text, { clearComposer: true });
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

    const currentConfig = draftConfigRef.current ?? configRef.current ?? draftConfig ?? config;
    if (!currentConfig || !selectedProfile(currentConfig, "tts")) {
      setError(`${copy.ttsFailed}${copy.ttsNoProfileCopy}`);
      setStatus("error");
      return;
    }

    try {
      const audio = await prepareCloudTtsAudio(speechText);
      await playPreparedAudio(audio);
    } catch (ttsError) {
      setError(formatTtsError(ttsError));
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
    const currentConfig = draftConfigRef.current ?? configRef.current ?? draftConfig ?? config;
    if (!currentConfig || !selectedProfile(currentConfig, "tts")) {
      setTtsTestResult(`${copy.ttsFailed}${copy.ttsNoProfileCopy}`);
      setStatus("error");
      return;
    }

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
      setTtsTestResult(formatTtsError(ttsError));
      setStatus("idle");
    }
  }

  function formatSttError(error: unknown) {
    const message = String(error);
    if (message.includes("missing_stt_profile")) {
      return `${copy.sttFailed}${copy.sttNoProfileCopy}`;
    }

    if (
      message.includes("missing_stt_api_key") ||
      message.includes("missing_stt_base_url") ||
      message.includes("missing_stt_model")
    ) {
      return `${copy.sttFailed}${copy.sttConfigIncompleteCopy}`;
    }

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

    const formattedHttpError = formatSpeechHttpError(message, "stt_http_error", copy);
    if (formattedHttpError) {
      return `${copy.sttFailed}${formattedHttpError}`;
    }

    return `${copy.sttFailed}${message}`;
  }

  function formatTtsError(error: unknown) {
    const message = String(error);
    if (message.includes("missing_tts_profile")) {
      return `${copy.ttsFailed}${copy.ttsNoProfileCopy}`;
    }

    if (
      message.includes("missing_tts_api_key") ||
      message.includes("missing_tts_base_url") ||
      message.includes("missing_tts_model")
    ) {
      return `${copy.ttsFailed}${copy.ttsConfigIncompleteCopy}`;
    }

    const formattedHttpError = formatSpeechHttpError(message, "tts_http_error", copy);
    if (formattedHttpError) {
      return `${copy.ttsFailed}${formattedHttpError}`;
    }

    return `${copy.ttsFailed}${message}`;
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
      pinExpandAssistant();
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
    const currentConfig = draftConfigRef.current ?? configRef.current ?? draftConfig ?? config;
    if (!currentConfig || !selectedProfile(currentConfig, "stt")) {
      const message = `${copy.sttFailed}${copy.sttNoProfileCopy}`;
      setStatus("error");
      if (updateTestResult) {
        setSttTestResult(message);
      } else {
        setError(message);
      }
      return;
    }
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
        pinExpandAssistant();
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
    stopHotwordListener();
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

  function shouldRunHotwordListener() {
    const currentConfig = configRef.current;
    return Boolean(
      currentConfig?.general.hotwordEnabled &&
        currentConfig.voice.sttMode === "local" &&
        statusRef.current === "idle" &&
        !settingsOpen &&
        !speechRecognitionRef.current &&
        !mediaRecorderRef.current &&
        !speechProcessingRef.current &&
        !activeChatRequestIdRef.current
    );
  }

  function stopHotwordListener() {
    if (hotwordRestartTimerRef.current) {
      window.clearTimeout(hotwordRestartTimerRef.current);
      hotwordRestartTimerRef.current = undefined;
    }

    const recognition = hotwordRecognitionRef.current;
    hotwordRecognitionRef.current = null;
    if (!recognition) {
      return;
    }

    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    try {
      recognition.abort();
    } catch {
      // Ignore browser-specific abort failures.
    }
  }

  function restartHotwordListenerSoon() {
    if (hotwordRestartTimerRef.current || !shouldRunHotwordListener()) {
      return;
    }

    hotwordRestartTimerRef.current = window.setTimeout(() => {
      hotwordRestartTimerRef.current = undefined;
      startHotwordListener();
    }, 500);
  }

  function hotwordMatched(transcript: string) {
    const normalized = transcript.toLowerCase().replace(/\s+/g, "");
    return normalized.includes("阿福") || normalized.includes("afu") || normalized.includes("heyafu");
  }

  function startHotwordListener() {
    if (hotwordRecognitionRef.current || !shouldRunHotwordListener()) {
      return;
    }

    const SpeechRecognition =
      (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = configRef.current?.general.language === "en-US" ? "en-US" : "zh-CN";
      recognition.continuous = true;
      recognition.interimResults = true;
      hotwordRecognitionRef.current = recognition;

      recognition.onresult = (event) => {
        const transcript = Array.from({ length: event.results.length }, (_, index) => event.results[index]?.[0]?.transcript || "")
          .join(" ")
          .trim();
        if (!transcript || !hotwordMatched(transcript)) {
          return;
        }

        stopHotwordListener();
        pinExpandAssistant();
        wakeForVoice();
      };

      recognition.onend = () => {
        if (hotwordRecognitionRef.current === recognition) {
          hotwordRecognitionRef.current = null;
        }
        restartHotwordListenerSoon();
      };

      recognition.onerror = (event) => {
        if (hotwordRecognitionRef.current === recognition) {
          hotwordRecognitionRef.current = null;
        }
        if (event.error && event.error !== "no-speech" && event.error !== "aborted") {
          setError(formatSttError(event.error || event.type || "hotword_failed"));
        }
        restartHotwordListenerSoon();
      };

      recognition.start();
    } catch {
      hotwordRecognitionRef.current = null;
    }
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
    const currentConfig = draftConfigRef.current ?? configRef.current;
    maybeStartNewConversationAfterIdle();
    setSettingsOpen(false);
    pinExpandAssistant();
    setStatus((current) => (current === "error" ? "idle" : current));
    if (!canStartSpeechInput(currentConfig)) {
      window.setTimeout(() => inputRef.current?.focus(), 80);
      return;
    }
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

    const currentConfig = draftConfigRef.current ?? configRef.current;
    const voiceConfig = currentConfig?.voice;
    if (!voiceConfig?.pushToTalkEnabled || !isPushToTalkEvent(event) || isEditableKeyboardTarget(event.target)) {
      return false;
    }

    if (!canStartSpeechInput(currentConfig)) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    blurNonEditableActiveElement();
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
    if (voiceConfig?.pushToTalkEnabled && isPushToTalkEvent(event) && !isEditableKeyboardTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }

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
    const currentConfig = draftConfigRef.current ?? configRef.current;
    maybeStartNewConversationAfterIdle();
    setSettingsOpen(false);
    pinExpandAssistant();
    setStatus((current) => (current === "error" ? "idle" : current));
    if (!canStartSpeechInput(currentConfig)) {
      window.setTimeout(() => inputRef.current?.focus(), 80);
      return;
    }
    window.setTimeout(startListeningFromWakeup, 60);
  }

  useEffect(() => {
    loadConfig()
      .then(async (loaded) => {
        const legacyRegistries = loadLegacyLocalRegistries();
        const shouldMigrateLegacyRegistries =
          (loaded.registries.skills.length === 0 && legacyRegistries.skills.length > 0) ||
          (loaded.registries.mcpServers.length === 0 && legacyRegistries.mcpServers.length > 0);

        if (shouldMigrateLegacyRegistries) {
          const migratedConfig = {
            ...loaded,
            registries: {
              skills: loaded.registries.skills.length > 0 ? loaded.registries.skills : legacyRegistries.skills,
              mcpServers:
                loaded.registries.mcpServers.length > 0 ? loaded.registries.mcpServers : legacyRegistries.mcpServers
            }
          };
          try {
            const saved = await saveConfig(migratedConfig);
            clearLegacyLocalRegistries();
            setConfig(saved);
            setDraftConfig(saved);
          } catch {
            setConfig(migratedConfig);
            setDraftConfig(migratedConfig);
          }
          return;
        }

        setConfig(loaded);
        setDraftConfig(loaded);
      })
      .catch((loadError) => {
        setError(String(loadError));
        setStatus("error");
      });

    void listConversations()
      .then(async (snapshots) => {
        if (snapshots.length === 0) {
          const legacySessions = loadLegacyConversationSessions();
          if (legacySessions.length === 0) {
            return;
          }

          try {
            await migrateLegacyConversationSessions(legacySessions);
            clearLegacyConversationSessions();
          } catch {
            return;
          }

          persistSessions(legacySessions);
          const [activeSession] = legacySessions;
          setConversationState({
            activeSessionId: activeSession.id,
            messages: activeSession.messages,
            sessions: legacySessions
          });
          conversationRef.current = {
            activeSessionId: activeSession.id,
            messages: activeSession.messages,
            sessions: legacySessions
          };
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
            content: message.content,
            imageAttachments: message.imageAttachments || [],
            createdAt: message.createdAt
          }))
        }));
        const [activeSession] = sessions;
        persistSessions(sessions);
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
    void refreshPermissionRules();
    void migrateLegacyMemoryData()
      .catch((migrationError) => {
        setError(String(migrationError));
        setStatus("error");
      })
      .finally(() => {
        void refreshMemories();
        void refreshMemoryFiles();
      });
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
      pinExpandAssistant();
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

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      stopListening();
      stopHotwordListener();
      stopTts();
      cleanupWakeup?.();
      cleanupOpenSettings?.();
    };
  }, []);

  useEffect(() => {
    if (shouldRunHotwordListener()) {
      startHotwordListener();
    } else {
      stopHotwordListener();
    }
  }, [
    config?.general.hotwordEnabled,
    config?.general.language,
    config?.voice.sttMode,
    status,
    settingsOpen,
    speechProcessing,
    activeChatRequestId
  ]);

  const visibleMessages = useMemo(() => conversationState.messages.slice(-6), [conversationState.messages]);
  const previousConversation = conversationState.sessions.find(
    (session) => session.id !== conversationState.activeSessionId && session.messages.length > 0
  );
  const language = draftConfig?.general.language ?? config?.general.language ?? "zh-CN";
  const copy = uiCopy[language];
  const activeSettingsLabel = copy.nav[activeSettings];
  const voiceBusy = status === "listening" || speechProcessing;
  const speechInputAvailable = canStartSpeechInput(config);
  const savedSkills = config?.registries.skills || [];
  const savedMcpServers = config?.registries.mcpServers || [];
  const draftSkills = draftConfig?.registries.skills || [];
  const draftMcpServers = draftConfig?.registries.mcpServers || [];

  function previewExpandAssistant() {
    setIsExpanded(true);
  }

  function pinExpandAssistant() {
    setIsExpandedPinned(true);
    setIsExpanded(true);
  }

  function handleWindowDragStart(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0 || isWindowDragBlockedTarget(event.target)) {
      return;
    }

    void startWindowDrag().catch(() => undefined);
  }

  async function addImageFiles(files: File[]) {
    if (statusRef.current === "executing") {
      return;
    }
    if (files.length === 0) {
      return;
    }

    clearVoiceAutoSendTimer();
    const nextImages: ImageAttachment[] = [];
    let nextError = "";
    for (const file of files) {
      if (pendingImages.length + nextImages.length >= maxImageAttachments) {
        nextError = nextError || copy.imageLimitReached;
        break;
      }

      if (!isSupportedImageFile(file)) {
        nextError = nextError || copy.unsupportedImage;
        continue;
      }

      if (file.size > maxImageAttachmentBytes) {
        nextError = nextError || copy.imageTooLarge;
        continue;
      }

      try {
        nextImages.push(await readImageAttachment(file));
      } catch (imageError) {
        nextError = nextError || String(imageError);
      }
    }

    if (nextImages.length > 0) {
      setPendingImages((current) => [...current, ...nextImages].slice(0, maxImageAttachments));
      setError(nextError);
    } else if (nextError) {
      setError(nextError);
    }
  }

  function handleImageInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void addImageFiles(files);
  }

  function collectTransferredImageFiles(
    source: Pick<DataTransfer, "files" | "items">
  ): File[] {
    const filesFromItems = Array.from(source.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const filesFromList = Array.from(source.files || []).filter((file) => file.type.startsWith("image/"));

    const uniqueFiles = new Map<string, File>();
    for (const file of [...filesFromItems, ...filesFromList]) {
      uniqueFiles.set(`${file.name}:${file.size}:${file.type}:${file.lastModified}`, file);
    }
    return Array.from(uniqueFiles.values());
  }

  function insertComposerText(text: string, textarea: HTMLTextAreaElement) {
    if (!text) {
      return;
    }

    const currentValue = inputRef.current?.value ?? input;
    const start = textarea.selectionStart ?? currentValue.length;
    const end = textarea.selectionEnd ?? currentValue.length;
    const nextValue = `${currentValue.slice(0, start)}${text}${currentValue.slice(end)}`;
    setInput(nextValue);

    window.requestAnimationFrame(() => {
      const target = inputRef.current ?? textarea;
      const nextCursor = start + text.length;
      target.focus();
      target.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function handleInputPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = collectTransferredImageFiles(event.clipboardData);
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    if (statusRef.current === "executing") {
      return;
    }

    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      insertComposerText(pastedText, event.currentTarget);
    }
    void addImageFiles(imageFiles);
  }

  function handleImageDrop(event: React.DragEvent<HTMLDivElement>) {
    const imageFiles = collectTransferredImageFiles(event.dataTransfer);
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    if (statusRef.current === "executing") {
      return;
    }
    void addImageFiles(imageFiles);
  }

  async function handleSend(
    textOverride?: string,
    options: { includePendingImages?: boolean; bypassCooldown?: boolean; clearComposer?: boolean } = {}
  ) {
    const hasTextOverride = textOverride !== undefined;
    const includePendingImages = options.includePendingImages ?? !hasTextOverride;
    const imagesForMessage = includePendingImages ? pendingImages : [];
    const rawInput = textOverride ?? inputRef.current?.value ?? input;
    const trimmed = rawInput.trim();
    const content = trimmed || (imagesForMessage.length > 0 ? copy.imageOnlyPrompt : "");
    const submissionKey = createSubmissionKey(content, imagesForMessage);
    if (!content || statusRef.current === "executing" || (status === "thinking" && !speechProcessingRef.current)) {
      return;
    }
    if (shouldRejectSubmission(submissionKey, Boolean(options.bypassCooldown))) {
      return;
    }
    const normalizedSubmittedText = normalizedSpeechText(content);
    if (
      imagesForMessage.length === 0 &&
      normalizedSubmittedText &&
      normalizedSubmittedText === lastSubmittedTextRef.current &&
      Date.now() - lastSubmittedAtRef.current < 5000
    ) {
      return;
    }
    clearVoiceAutoSendTimer();
    sendInFlightRef.current = true;
    sendCooldownUntilRef.current = Date.now() + 5000;
    lastSubmittedTextRef.current = normalizedSubmittedText;
    lastSubmittedAtRef.current = Date.now();
    activeSubmissionKeyRef.current = submissionKey;
    recentSubmissionKeysRef.current.set(submissionKey, lastSubmittedAtRef.current);
    const shouldClearComposer = options.clearComposer ?? !hasTextOverride;
    if (shouldClearComposer) {
      if (inputRef.current) {
        inputRef.current.value = "";
      }
      setInput("");
    }
    try {
      markSubmittedSpeechText(content);
      if (pendingConfirmation) {
        discardPendingConfirmation();
      }
      if (speechProcessingRef.current) {
        cancelSpeechProcessing();
      } else if (statusRef.current === "listening" || speechRecognitionRef.current || mediaRecorderRef.current) {
        stopListening();
      }
      stopTts();
      const mcpToolCall = imagesForMessage.length > 0 ? null : parseMcpToolCall(content, savedMcpServers);
      if (mcpToolCall) {
        const nextUserMessage = createMessage("user", content);
        const assistantMessage = createMessage("assistant", "");

        updateActiveMessages((current) => appendMessagePair(current, nextUserMessage, assistantMessage));
        setInput("");
        setError("");
        setPendingConfirmation(null);
        setStatus("executing");

        if ("error" in mcpToolCall) {
          setStatus("error");
          updateActiveMessages((current) =>
            current.map((item) => (item.id === assistantMessage.id ? { ...item, content: mcpToolCall.error } : item))
          );
          return;
        }

        try {
          const result = await callMcpTool(
            {
              command: mcpToolCall.server.command,
              serverName: mcpToolCall.server.name,
              toolName: mcpToolCall.toolName,
              arguments: mcpToolCall.arguments
            },
            false
          );
          if (result.status === "requiresConfirmation" && result.confirmation && result.request) {
            setPendingConfirmation({
              kind: "mcp",
              request: result.request,
              assistantMessageId: assistantMessage.id,
              title: result.confirmation.title,
              description: result.confirmation.description,
              command: result.confirmation.command,
              target: result.confirmation.target,
              riskLevel: result.confirmation.riskLevel
            });
            setStatus("confirming");
            updateActiveMessages((current) =>
              current.map((item) =>
                item.id === assistantMessage.id
                  ? { ...item, content: `${copy.confirmationTitle}：${result.confirmation?.title}` }
                  : item
              )
            );
            return;
          }

          const message = result.message || "MCP 工具调用失败";
          setStatus(result.status === "completed" ? "idle" : "error");
          updateActiveMessages((current) =>
            current.map((item) => (item.id === assistantMessage.id ? { ...item, content: message } : item))
          );
          await refreshExecutionLogs();
          if (result.status === "completed") {
            await playTts(message);
          } else {
            setError(message);
          }
        } catch (mcpError) {
          const message = String(mcpError);
          await refreshExecutionLogs();
          setError(message);
          setStatus("error");
          updateActiveMessages((current) =>
            current.map((item) => (item.id === assistantMessage.id ? { ...item, content: message } : item))
          );
        }
        return;
      }

      const plannedAction = imagesForMessage.length > 0 ? null : await planLocalAction(content);
      if (plannedAction) {
        const nextUserMessage = createMessage("user", content);
        const assistantMessage = createMessage("assistant", "");

        updateActiveMessages((current) => appendMessagePair(current, nextUserMessage, assistantMessage));
        setInput("");
        setError("");
        setPendingConfirmation(null);
        setStatus("executing");

        try {
          const response = await executeLocalAction(plannedAction, false);
          if (response.status === "requiresConfirmation" && response.confirmation && response.action) {
            setPendingConfirmation({
              kind: "local",
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

      const appendConfigurationErrorMessage = (errorCode: string) => {
        const nextUserMessage = createMessage("user", content, imagesForMessage);
        const assistantMessage = createMessage("assistant", chatErrorReply(errorCode, copy));
        updateActiveMessages((current) => appendMessagePair(current, nextUserMessage, assistantMessage));
        if (shouldClearComposer) {
          setPendingImages([]);
        }
        setError(errorCode);
        setStatus("error");
      };

      if (!config) {
        appendConfigurationErrorMessage("missing_api_key");
        return;
      }

      const activeTextProfile = selectedProfile(config, "text");
      const activeVisionProfile = selectedProfile(config, "vision");
      const activeProfile = imagesForMessage.length > 0 ? activeVisionProfile : activeTextProfile;
      if (imagesForMessage.length > 0 && !activeVisionProfile) {
        appendConfigurationErrorMessage("missing_vision_model");
        return;
      }
      if (!activeProfile) {
        appendConfigurationErrorMessage("missing_model_config");
        return;
      }
      if (!activeProfile.baseUrl.trim() || !activeProfile.model.trim()) {
        appendConfigurationErrorMessage("missing_model_config");
        return;
      }
      if (!activeProfile.apiKey.trim()) {
        appendConfigurationErrorMessage("missing_api_key");
        return;
      }

      const nextUserMessage = createMessage("user", content, imagesForMessage);
      const nextMessages = [...conversationRef.current.messages, nextUserMessage];
      const assistantMessage = createMessage("assistant", "");
      const requestId = crypto.randomUUID();

      updateActiveMessages((current) => appendMessagePair(current, nextUserMessage, assistantMessage));
      setInput("");
      setPendingImages([]);
      setError("");
      cancelledChatRequestIdRef.current = "";
      activeChatRequestIdRef.current = requestId;
      setActiveChatRequestId(requestId);
      setStatus("thinking");

      try {
        const ttsEnabled = Boolean(config?.voice.ttsEnabled);
        const reasoningMode = await resolveReasoningMode(content);
        const skillDocuments = await loadEnabledSkillRegistryDocuments();
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
            buildRegistryContext(savedSkills, savedMcpServers, skillDocuments),
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
                  content: chatErrorReply(message, copy)
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
    } finally {
      if (activeSubmissionKeyRef.current === submissionKey) {
        activeSubmissionKeyRef.current = "";
      }
      sendInFlightRef.current = false;
    }
  }

  async function confirmPendingAction(remember = false) {
    if (!pendingConfirmation) {
      return;
    }

    setStatus("executing");
    try {
      const shouldRemember = remember && canRememberPermission(pendingConfirmation);
      const response =
        pendingConfirmation.kind === "mcp" && pendingConfirmation.request
          ? await callMcpTool(pendingConfirmation.request, true, shouldRemember)
          : await executeLocalAction(pendingConfirmation.action!, true, shouldRemember);
      updateActiveMessages((current) =>
        current.map((item) =>
          item.id === pendingConfirmation.assistantMessageId ? { ...item, content: response.message } : item
        )
      );
      setPendingConfirmation(null);
      setStatus(response.status === "completed" ? "idle" : "error");
      await refreshExecutionLogs();
      if (shouldRemember) {
        await refreshPermissionRules();
      }
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

  function discardPendingConfirmation() {
    if (!pendingConfirmation) {
      return;
    }

    const cancelledConfirmation = pendingConfirmation;
    updateActiveMessages((current) =>
      current.map((item) =>
        item.id === cancelledConfirmation.assistantMessageId ? { ...item, content: copy.cancelledExecution } : item
      )
    );
    setPendingConfirmation(null);
    setStatus((current) => (current === "confirming" ? "idle" : current));
    setError("");

    void writeExecutionLog({
      actionType:
        cancelledConfirmation.kind === "mcp"
          ? "mcp_tool"
          : cancelledConfirmation.action?.actionType || "local_action",
      title: cancelledConfirmation.title,
      target: cancelledConfirmation.command || cancelledConfirmation.target,
      status: "cancelled",
      riskLevel: cancelledConfirmation.riskLevel || "unknown",
      reason: `${copy.cancelledReason}：${cancelledConfirmation.description || cancelledConfirmation.title}`
    })
      .then(() => refreshExecutionLogs())
      .catch((logError) => {
        setError(String(logError));
        setStatus("error");
      });
  }

  function stopTransientInteraction() {
    clearVoiceAutoSendTimer();
    if (speechProcessingRef.current) {
      cancelSpeechProcessing();
    } else if (statusRef.current === "listening" || speechRecognitionRef.current || mediaRecorderRef.current) {
      stopListening();
    }

    if (activeChatRequestIdRef.current) {
      void cancelModelResponse();
      return;
    }

    stopTts();
  }

  async function cancelPendingAction() {
    discardPendingConfirmation();
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
        onMouseEnter={previewExpandAssistant}
        onMouseLeave={() => {
          if (!isExpandedPinned && !settingsOpen && status === "idle" && !speechProcessing) {
            setIsExpanded(false);
          }
        }}
      >
        <header className="notch-bar" data-tauri-drag-region onMouseDown={handleWindowDragStart}>
          <button
            className="orb-button"
            onClick={() => {
              if (isExpanded && isExpandedPinned && !settingsOpen && status === "idle" && !speechProcessing) {
                setIsExpandedPinned(false);
                setIsExpanded(false);
                return;
              }
              pinExpandAssistant();
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
          <button
            className="icon-button"
            onClick={() => {
              pinExpandAssistant();
              setSettingsOpen(true);
            }}
            aria-label={copy.openSettings}
          >
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
                disabled={!previousConversation || status === "executing"}
                title={previousConversation ? previousConversation.title : copy.noPreviousConversation}
              >
                <ArrowLeft size={15} />
                <span>{copy.previousConversation}</span>
              </button>
              <button className="text-button" onClick={startNewConversation} disabled={status === "executing"}>
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
                  {visibleMessages.map((message, index) => (
                    (() => {
                      const contentSegments = parseMessageContent(message.content);
                      return (
                        <article key={`${message.id}-${index}`} className={`message message-${message.role}`}>
                          <span>{message.role === "user" ? copy.roles.user : copy.roles.assistant}</span>
                          {message.imageAttachments?.length ? (
                            <div className="message-images">
                              {message.imageAttachments.map((image) => (
                                <img key={image.id} src={image.dataUrl} alt={image.name || copy.imageAttachmentLabel} />
                              ))}
                            </div>
                          ) : null}
                          {contentSegments.length > 0 ? (
                            contentSegments.map((segment, segmentIndex) =>
                              segment.type === "text" ? (
                                <p key={`${message.id}-text-${segmentIndex}`} className="message-bubble">
                                  {segment.content}
                                </p>
                              ) : (
                                <div key={`${message.id}-image-${segmentIndex}`} className="message-inline-images">
                                  <img src={segment.src} alt={segment.alt || copy.imageAttachmentLabel} />
                                </div>
                              )
                            )
                          ) : (
                            <p className="message-bubble">...</p>
                          )}
                        </article>
                      );
                    })()
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
                  <button className="secondary-button dark-surface" onClick={() => void cancelPendingAction()} type="button">
                    {copy.cancel}
                  </button>
                  {canRememberPermission(pendingConfirmation) ? (
                    <button
                      className="secondary-button dark-surface"
                      onClick={() => void confirmPendingAction(true)}
                      type="button"
                    >
                      {copy.rememberAllow}
                    </button>
                  ) : null}
                  <button className="primary-button light-surface" onClick={() => void confirmPendingAction()} type="button">
                    <Check size={15} />
                    <span>{copy.allowOnce}</span>
                  </button>
                </div>
              </div>
            ) : null}

            <div
              className="input-composer"
              onDragOver={(event) => {
                if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"))) {
                  event.preventDefault();
                }
              }}
              onDrop={handleImageDrop}
            >
              {pendingImages.length > 0 ? (
                <div className="pending-images">
                  {pendingImages.map((image) => (
                    <div key={image.id} className="pending-image">
                      <img src={image.dataUrl} alt={image.name || copy.imageAttachmentLabel} />
                      <button
                        type="button"
                        aria-label={copy.removeImage}
                        disabled={status === "executing"}
                        onClick={() => {
                          clearVoiceAutoSendTimer();
                          setPendingImages((current) => current.filter((item) => item.id !== image.id));
                        }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="input-row">
              <input
                ref={imageInputRef}
                className="image-input"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                disabled={status === "executing"}
                onChange={handleImageInputChange}
              />
              <button
                className="attach-button"
                onClick={() => imageInputRef.current?.click()}
                type="button"
                disabled={status === "executing"}
                aria-label={copy.attachImage}
              >
                <ImagePlus size={18} />
              </button>
              <button
                className={`mic-button ${voiceBusy ? "is-active" : ""}`}
                onPointerDown={voiceBusy || !speechInputAvailable ? undefined : startMicHold}
                onPointerUp={voiceBusy || !speechInputAvailable ? undefined : stopMicHold}
                onPointerCancel={voiceBusy || !speechInputAvailable ? undefined : stopMicHold}
                onPointerLeave={voiceBusy || !speechInputAvailable ? undefined : stopMicHold}
                onClick={status === "executing" || !speechInputAvailable ? undefined : toggleNativeSpeechRecognition}
                disabled={status === "executing" || !speechInputAvailable}
                aria-label={voiceBusy ? copy.stopVoice : copy.testStt}
              >
                {voiceBusy ? <X size={18} /> : <Mic size={18} />}
              </button>
              <textarea
                ref={inputRef}
                value={input}
                disabled={status === "executing"}
                onChange={(event) => {
                  clearVoiceAutoSendTimer();
                  setInput(event.target.value);
                }}
                onPaste={handleInputPaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend(undefined, { includePendingImages: true, bypassCooldown: true });
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
                disabled={status === "executing" || (!activeChatRequestId && !input.trim() && pendingImages.length === 0)}
                aria-label={activeChatRequestId ? copy.stopReply : undefined}
                title={activeChatRequestId ? copy.stopReply : undefined}
              >
                {activeChatRequestId ? <X size={17} /> : <Send size={17} />}
              </button>
              </div>
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
              permissionRules={permissionRules}
              memories={memories}
              memoryDraft={memoryDraft}
              memoryFileContent={memoryFileContent}
              memoryFileDraft={memoryFileDraft}
              memoryFilePath={memoryFilePath}
              soulFileContent={soulFileContent}
              soulFileDraft={soulFileDraft}
              soulFilePath={soulFilePath}
              pendingMemoryFileSave={pendingMemoryFileSave}
              skills={draftSkills}
              skillDraft={skillDraft}
              mcpServers={draftMcpServers}
              mcpDraft={mcpDraft}
              mcpCheckingId={mcpCheckingId}
              sttTestResult={sttTestResult}
              ttsTestResult={ttsTestResult}
              capturingGlobalShortcut={capturingGlobalShortcut}
              capturingPushToTalkKey={capturingPushToTalkKey}
              conversationBusy={status === "executing"}
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
              updateSkill={(id, patch) => updateSkillEntry(id, patch)}
              toggleTrustedSkill={toggleTrustedSkill}
              toggleSkill={(id) =>
                updateDraftSkills((current) =>
                  current.map((skill) => (skill.id === id ? { ...skill, enabled: !skill.enabled } : skill))
                )
              }
              deleteSkill={(id) => {
                const skill = draftSkills.find((item) => item.id === id);
                updateDraftSkills((current) => current.filter((item) => item.id !== id));
                if (skill?.path) {
                  updateDraft((current) => ({
                    ...current,
                    permissions: {
                      ...current.permissions,
                      trustedSkills: current.permissions.trustedSkills.filter((path) => path.trim() !== skill.path.trim())
                    }
                  }));
                }
              }}
              setMcpDraft={setMcpDraft}
              addMcp={addMcpEntry}
              updateMcp={(id, patch) => updateMcpEntry(id, patch)}
              inspectMcp={(id) => void inspectMcpEntry(id)}
              toggleMcp={toggleMcpEntry}
              deleteMcp={(id) => updateDraftMcpServers((current) => current.filter((server) => server.id !== id))}
              testSpeechRecognition={testSpeechRecognition}
              testTtsPlayback={testTtsPlayback}
              stopVoice={() => {
                cancelSpeechProcessing();
                stopTts();
              }}
              deleteConversation={(id) => void removeConversation(id)}
              clearConversations={() => void removeAllConversations()}
              clearExecutionLogs={() => void removeAllExecutionLogs()}
              deleteExecutionLog={(id) => void removeExecutionLog(id)}
              deletePermissionRule={async (id) => {
                await deletePermissionRule(id);
                await refreshPermissionRules();
              }}
              clearPermissionRules={async () => {
                await clearPermissionRules();
                await refreshPermissionRules();
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
  permissionRules: PermissionRule[];
  memories: MemoryItem[];
  memoryDraft: string;
  memoryFileContent: string;
  memoryFileDraft: string;
  memoryFilePath: string;
  soulFileContent: string;
  soulFileDraft: string;
  soulFilePath: string;
  pendingMemoryFileSave: MemoryFileKind | null;
  skills: SkillRegistryEntry[];
  skillDraft: string;
  mcpServers: McpRegistryEntry[];
  mcpDraft: string;
  mcpCheckingId: string;
  sttTestResult: string;
  ttsTestResult: string;
  capturingGlobalShortcut: boolean;
  capturingPushToTalkKey: boolean;
  conversationBusy: boolean;
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
  updateSkill: (id: string, patch: { name?: string; path?: string }) => void;
  toggleTrustedSkill: (path: string) => void;
  toggleSkill: (id: string) => void;
  deleteSkill: (id: string) => void;
  setMcpDraft: (value: string) => void;
  addMcp: () => void;
  updateMcp: (id: string, patch: { name?: string; command?: string }) => void;
  inspectMcp: (id: string) => void;
  toggleMcp: (id: string) => void;
  deleteMcp: (id: string) => void;
  testSpeechRecognition: () => void;
  testTtsPlayback: () => void;
  stopVoice: () => void;
  deleteConversation: (id: string) => void;
  clearConversations: () => void;
  clearExecutionLogs: () => void;
  deleteExecutionLog: (id: string) => void;
  deletePermissionRule: (id: string) => Promise<void>;
  clearPermissionRules: () => Promise<void>;
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
  permissionRules,
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
  mcpCheckingId,
  sttTestResult,
  ttsTestResult,
  capturingGlobalShortcut,
  capturingPushToTalkKey,
  conversationBusy,
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
  updateSkill,
  toggleTrustedSkill,
  toggleSkill,
  deleteSkill,
  setMcpDraft,
  addMcp,
  updateMcp,
  inspectMcp,
  toggleMcp,
  deleteMcp,
  testSpeechRecognition,
  testTtsPlayback,
  stopVoice,
  deleteConversation,
  clearConversations,
  clearExecutionLogs,
  deleteExecutionLog,
  deletePermissionRule,
  clearPermissionRules,
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
    const textCapableProfiles = profiles.filter((profile) => profile.capabilities.includes("text"));
    const resolveSelectedProfileId = (
      nextProfiles: ModelProfile[],
      capability: ModelProfileKind,
      currentSelectedId: string,
      removedProfileId?: string
    ) => {
      if (currentSelectedId && currentSelectedId !== removedProfileId) {
        const currentSelected = nextProfiles.find(
          (profile) => profile.id === currentSelectedId && profile.capabilities.includes(capability)
        );
        if (currentSelected) {
          return currentSelected.id;
        }
      }
      return nextProfiles.find((profile) => profile.capabilities.includes(capability))?.id || "";
    };

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
      if (!enabled && kind === "text" && profile.capabilities.includes("text") && textCapableProfiles.length === 1) {
        return;
      }

      const nextCapabilities = enabled
        ? Array.from(new Set([...profile.capabilities, kind]))
        : profile.capabilities.filter((capability) => capability !== kind);
      const capabilities = nextCapabilities.length > 0 ? nextCapabilities : [kind];
      updateDraft((current) => {
        const nextProfiles = current.models.profiles.map((item) =>
          item.id === profile.id
            ? {
                ...item,
                capabilities,
                kind: capabilities[0]
              }
            : item
        );

        const selectIfEmpty = (capability: ModelProfileKind, currentSelectedId: string) => {
          if (enabled && kind === capability && !currentSelectedId && capabilities.includes(capability)) {
            return profile.id;
          }
          return resolveSelectedProfileId(nextProfiles, capability, currentSelectedId);
        };

        const nextSelectedTtsProfileId = selectIfEmpty("tts", current.models.selectedTtsProfileId);

        return {
          ...current,
          voice: {
            ...current.voice,
            ttsEnabled: nextSelectedTtsProfileId ? current.voice.ttsEnabled : false
          },
          models: {
            ...current.models,
            profiles: nextProfiles,
            selectedTextProfileId: selectIfEmpty("text", current.models.selectedTextProfileId),
            selectedVisionProfileId: selectIfEmpty("vision", current.models.selectedVisionProfileId),
            selectedTtsProfileId: nextSelectedTtsProfileId,
            selectedSttProfileId: selectIfEmpty("stt", current.models.selectedSttProfileId)
          }
        };
      });
    };

    const deleteProfile = (profileId: string) => {
      updateDraft((current) => {
        const nextProfiles = current.models.profiles.filter((profile) => profile.id !== profileId);
        const nextSelectedTtsProfileId = resolveSelectedProfileId(
          nextProfiles,
          "tts",
          current.models.selectedTtsProfileId,
          profileId
        );
        return {
          ...current,
          voice: {
            ...current.voice,
            ttsEnabled: nextSelectedTtsProfileId ? current.voice.ttsEnabled : false
          },
          models: {
            ...current.models,
            profiles: nextProfiles,
            selectedTextProfileId: resolveSelectedProfileId(
              nextProfiles,
              "text",
              current.models.selectedTextProfileId,
              profileId
            ),
            selectedVisionProfileId: resolveSelectedProfileId(
              nextProfiles,
              "vision",
              current.models.selectedVisionProfileId,
              profileId
            ),
            selectedTtsProfileId: nextSelectedTtsProfileId,
            selectedSttProfileId: resolveSelectedProfileId(
              nextProfiles,
              "stt",
              current.models.selectedSttProfileId,
              profileId
            )
          }
        };
      });
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
                  voice: {
                    ...current.voice,
                    ttsEnabled: event.target.value ? current.voice.ttsEnabled : false
                  },
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
          {(["text", "vision", "tts", "stt"] as const).map((kind) => (
            <button key={kind} className="model-add-button" onClick={() => addProfileWithKind(kind)} type="button">
              <Plus size={15} />
              <span>
                {copy.addModel} {copy.modelKinds[kind]}
              </span>
            </button>
          ))}
        </div>

        <div className="model-profile-list">
          {profiles.map((profile) => {
            const deleteDisabled = profile.capabilities.includes("text") && textCapableProfiles.length === 1;

            return (
              <section key={profile.id} className="model-profile-card">
                <div className="model-profile-header">
                  <div>
                    <strong>{profile.name || copy.labels.profileName}</strong>
                    <div className="model-capability-tags">
                      {profile.capabilities.map((capability) => (
                        <span key={capability}>{copy.modelKinds[capability]}</span>
                      ))}
                    </div>
                  </div>
                  <button
                    className="registry-delete"
                    onClick={() => deleteProfile(profile.id)}
                    type="button"
                    aria-label={copy.deleteModel}
                    disabled={deleteDisabled}
                    title={copy.deleteModel}
                  >
                    <X size={14} />
                  </button>
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
            );
          })}
        </div>
      </div>
    );
  }

  if (active === "speech") {
    const sttProfiles = profileOptions("stt");
    const selectedSttProfile = selectedProfile(config, "stt");

    return (
      <div className="settings-card">
        <Field label={copy.labels.sttMode}>
          <select
            value={config.voice.sttMode}
            onChange={(event) =>
              updateDraft((current) => {
                const nextMode = event.target.value as AppConfig["voice"]["sttMode"];
                const nextSelectedSttProfileId =
                  nextMode === "model" && !current.models.selectedSttProfileId
                    ? current.models.profiles.find((profile) => profile.capabilities.includes("stt"))?.id || ""
                    : current.models.selectedSttProfileId;
                return {
                  ...current,
                  voice: { ...current.voice, sttMode: nextMode },
                  models: {
                    ...current.models,
                    selectedSttProfileId: nextSelectedSttProfileId
                  }
                };
              })
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
            <button
              className="secondary-button"
              onClick={testSpeechRecognition}
              type="button"
              disabled={config.voice.sttMode === "model" && !selectedSttProfile}
            >
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
    const ttsProfiles = profileOptions("tts");
    const selectedTtsProfile = selectedProfile(config, "tts");
    const hasLegacyTtsConfig =
      ttsProfiles.length === 0 &&
      Boolean(config.models.tts.baseUrl.trim() || config.models.tts.apiKeyRef.trim());

    return (
      <div className="settings-card">
        {ttsProfiles.length > 0 ? (
          <Field label={copy.labels.ttsModelSelect}>
            <select
              value={config.models.selectedTtsProfileId}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  voice: {
                    ...current.voice,
                    ttsEnabled: event.target.value ? current.voice.ttsEnabled : false
                  },
                  models: { ...current.models, selectedTtsProfileId: event.target.value }
                }))
              }
            >
              <option value="">{copy.labels.noModelSelected}</option>
              {ttsProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="inline-empty">
            <strong>{copy.labels.ttsModelSelect}</strong>
            <p>{copy.ttsNoProfileCopy}</p>
            {hasLegacyTtsConfig ? <p>{copy.ttsLegacyConfigHint}</p> : null}
            <button className="secondary-button" onClick={() => addProfileWithKind("tts")} type="button">
              <Plus size={15} />
              <span>{copy.createTtsProfile}</span>
            </button>
          </div>
        )}
        <Toggle
          label={copy.labels.ttsReplies}
          checked={config.voice.ttsEnabled}
          disabled={!selectedTtsProfile}
          onChange={(checked) =>
            updateDraft((current) => ({
              ...current,
              voice: { ...current.voice, ttsEnabled: checked }
            }))
          }
        />
        <div className="voice-test-panel">
          <div className="voice-test-row">
            <button className="secondary-button" onClick={testTtsPlayback} type="button" disabled={!selectedTtsProfile}>
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
    const savedRules = permissionRules.filter((rule) => rule.decision === "allow");

    return (
      <div className="settings-card">
        <p className="registry-help">{copy.permissionsHelp}</p>
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
          <p className="registry-help">{copy.blockedPathsHelp}</p>
          <textarea
            value={config.permissions.blockedPaths.join("\n")}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                permissions: {
                  ...current.permissions,
                  blockedPaths: event.target.value
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean)
                }
              }))
            }
            rows={5}
          />
        </Field>
        <div className="permission-rules-section">
          <div className="memory-file-header">
            <div>
              <strong>{copy.savedRulesTitle}</strong>
            </div>
            <div className="memory-file-actions">
              <button
                className="secondary-button danger-button"
                onClick={() => void clearPermissionRules()}
                type="button"
                disabled={savedRules.length === 0}
              >
                {copy.clearPermissionRules}
              </button>
            </div>
          </div>
          {savedRules.length === 0 ? (
            <div className="inline-empty">
              <p>{copy.savedRulesEmpty}</p>
            </div>
          ) : (
            <div className="registry-list">
              {savedRules.map((rule) => (
                <article key={rule.id} className="registry-item">
                  <div>
                    <strong>{permissionRuleTitle(rule.actionType)}</strong>
                    <code>{displayPermissionTarget(rule.target)}</code>
                  </div>
                  <div className="registry-actions">
                    <button
                      className="registry-delete"
                      onClick={() => void deletePermissionRule(rule.id)}
                      type="button"
                      aria-label={copy.deletePermissionRule}
                      title={copy.deletePermissionRule}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (active === "skills") {
    const trustedPaths = trustedSkillPaths(config);
    return (
      <div className="settings-card registry-card">
        <p className="registry-help">{copy.trustedSkillHelp}</p>
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
            enabled: skill.enabled,
            titlePlaceholder: copy.registryNamePlaceholder,
            detailPlaceholder: copy.skillPathPlaceholder,
            titleAriaLabel: copy.registryNamePlaceholder,
            detailAriaLabel: copy.skillPathPlaceholder,
            trusted: trustedPaths.has(skill.path.trim()),
            trustedLabel: copy.trustedSkill,
            trustedDescription: trustedPaths.has(skill.path.trim()) ? "" : copy.trustedSkillOnlyMeta
          }))}
          onUpdate={(id, patch) =>
            updateSkill(id, {
              ...(patch.title !== undefined ? { name: patch.title } : {}),
              ...(patch.detail !== undefined ? { path: patch.detail } : {})
            })
          }
          onToggleTrusted={(id) => {
            const skill = skills.find((item) => item.id === id);
            if (skill?.path) {
              toggleTrustedSkill(skill.path);
            }
          }}
          onToggle={toggleSkill}
          onDelete={deleteSkill}
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
            enabled: server.enabled,
            titlePlaceholder: copy.registryNamePlaceholder,
            detailPlaceholder: copy.mcpCommandPlaceholder,
            titleAriaLabel: copy.registryNamePlaceholder,
            detailAriaLabel: copy.mcpCommandPlaceholder,
            tools: server.tools,
            error: server.toolError
          }))}
          onUpdate={(id, patch) =>
            updateMcp(id, {
              ...(patch.title !== undefined ? { name: patch.title } : {}),
              ...(patch.detail !== undefined ? { command: patch.detail } : {})
            })
          }
          onToggle={toggleMcp}
          onDelete={deleteMcp}
          onInspect={inspectMcp}
          inspectingId={mcpCheckingId}
          inspectLabel={copy.inspectMcp}
          inspectingLabel={copy.inspectingMcp}
          toolsLabel={copy.mcpToolsLabel}
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
        <NumberField
          label={copy.labels.injectedMemories}
          value={config.memory.maxInjectedMemories}
          field="maxInjectedMemories"
          min={0}
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
        <button className="secondary-button danger-button" onClick={clearExecutionLogs} type="button">
          {copy.clearLogs}
        </button>
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
                <div className="log-item-actions">
                  <time>
                    {new Intl.DateTimeFormat(undefined, {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit"
                    }).format(new Date(log.createdAt))}
                  </time>
                  <button
                    className="registry-delete"
                    onClick={() => deleteExecutionLog(log.id)}
                    type="button"
                    aria-label={copy.deleteLog}
                    title={copy.deleteLog}
                  >
                    <X size={14} />
                  </button>
                </div>
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
        <button className="secondary-button danger-button" onClick={clearConversations} type="button" disabled={conversationBusy}>
          {copy.clearHistory}
        </button>
        {sessionsWithMessages.map((session) => (
          <article key={session.id} className={`history-item ${session.id === activeSessionId ? "is-active" : ""}`}>
            <button className="history-item-main" onClick={() => resumeConversation(session.id)} type="button" disabled={conversationBusy}>
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
            <button
              className="registry-delete"
              onClick={() => deleteConversation(session.id)}
              type="button"
              disabled={conversationBusy}
              aria-label={copy.deleteConversation}
              title={copy.deleteConversation}
            >
              <X size={14} />
            </button>
          </article>
        ))}
      </div>
    );
  }

  const placeholder = {
    icon: Bell,
    title: copy.settings,
    copy: copy.unavailableSectionCopy
  };
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
    titlePlaceholder?: string;
    detailPlaceholder?: string;
    titleAriaLabel?: string;
    detailAriaLabel?: string;
    trusted?: boolean;
    trustedLabel?: string;
    trustedDescription?: string;
    tools?: McpToolSummary[];
    error?: string;
  }>;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdate?: (id: string, patch: { title?: string; detail?: string }) => void;
  onToggleTrusted?: (id: string) => void;
  onInspect?: (id: string) => void;
  inspectingId?: string;
  inspectLabel?: string;
  inspectingLabel?: string;
  toolsLabel?: string;
}

function RegistryList({
  items,
  onToggle,
  onDelete,
  onUpdate,
  onToggleTrusted,
  onInspect,
  inspectingId = "",
  inspectLabel = "",
  inspectingLabel = "",
  toolsLabel = ""
}: RegistryListProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="registry-list">
      {items.map((item) => (
        <article key={item.id} className="registry-item">
          <div>
            {onUpdate ? (
              <div className="registry-edit-grid">
                <input
                  value={item.title}
                  onChange={(event) => onUpdate(item.id, { title: event.target.value })}
                  placeholder={item.titlePlaceholder || ""}
                  aria-label={item.titleAriaLabel || item.titlePlaceholder || ""}
                />
                <input
                  value={item.detail}
                  onChange={(event) => onUpdate(item.id, { detail: event.target.value })}
                  placeholder={item.detailPlaceholder || ""}
                  aria-label={item.detailAriaLabel || item.detailPlaceholder || ""}
                />
              </div>
            ) : (
              <>
                <strong>{item.title}</strong>
                <code>{item.detail}</code>
              </>
            )}
            {item.trustedDescription ? <p className="registry-meta">{item.trustedDescription}</p> : null}
            {item.tools?.length ? (
              <p className="registry-meta">
                {toolsLabel}: {item.tools.map((tool) => tool.name).join(", ")}
              </p>
            ) : null}
            {item.error ? <p className="registry-error">{item.error}</p> : null}
          </div>
          <div className="registry-actions">
            {onInspect ? (
              <button
                className="registry-test"
                onClick={() => onInspect(item.id)}
                type="button"
                disabled={Boolean(inspectingId)}
              >
                {inspectingId === item.id ? inspectingLabel : inspectLabel}
              </button>
            ) : null}
            {onToggleTrusted && item.trustedLabel ? (
              <button
                className={`registry-trust ${item.trusted ? "is-on" : ""}`}
                onClick={() => onToggleTrusted(item.id)}
                type="button"
              >
                {item.trustedLabel}
              </button>
            ) : null}
            <button className={`toggle ${item.enabled ? "is-on" : ""}`} onClick={() => onToggle(item.id)} type="button">
              <span />
            </button>
            <button className="registry-delete" onClick={() => onDelete(item.id)} type="button" aria-label="删除">
              <X size={14} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

function Toggle({ label, checked, onChange, disabled = false }: ToggleProps) {
  return (
    <label className={`toggle-row ${disabled ? "is-disabled" : ""}`}>
      <span>{label}</span>
      <button
        className={`toggle ${checked ? "is-on" : ""}`}
        onClick={() => onChange(!checked)}
        type="button"
        disabled={disabled}
      >
        <span />
      </button>
    </label>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  field: keyof AppConfig["memory"];
  min?: number;
  updateDraft: (updater: (current: AppConfig) => AppConfig) => void;
}

function NumberField({ label, value, field, min = 1, updateDraft }: NumberFieldProps) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(event) =>
          updateDraft((current) => ({
            ...current,
            memory: {
              ...current.memory,
              [field]: Number.isFinite(Number(event.target.value))
                ? Math.max(min, Number(event.target.value))
                : min
            }
          }))
        }
      />
    </Field>
  );
}

export default App;

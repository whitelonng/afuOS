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
  PermissionRule,
  McpRegistryEntry,
  McpInspectionResult,
  McpToolExecutionResponse,
  McpToolRequest,
  ModelProfile,
  ModelProfileKind,
  SkillRegistryEntry,
  SkillDocument
} from "./types";

interface ModelMessagePayload {
  role: ChatMessage["role"];
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

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
  registries: {
    skills: [],
    mcpServers: []
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
const permissionRulesStorageKey = "afuos.permissionRules";
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
- 如果需要返回图片，请使用 Markdown 图片语法 ![描述](图片 URL 或本地绝对路径)。
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
  const payload = messages.map(toModelMessagePayload);

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

function toModelMessagePayload(message: ChatMessage): ModelMessagePayload {
  const images = message.imageAttachments || [];
  if (images.length === 0) {
    return { role: message.role, content: message.content };
  }

  const parts: ModelMessagePayload["content"] = [];
  const text = message.content.trim();
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const image of images) {
    parts.push({ type: "image_url", image_url: { url: image.dataUrl } });
  }
  return { role: message.role, content: parts };
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
  return planPreviewLocalAction(text);
}

export async function executeLocalAction(
  action: LocalActionRequest,
  confirmed = false,
  remember = false
): Promise<LocalActionResponse> {
  if (isTauriRuntime()) {
    return invoke<LocalActionResponse>("execute_local_action_command", { action, confirmed, remember });
  }

  const permissionTarget = permissionRuleTargetForLocalAction(action);
  const decision = previewPermissionDecision(action, permissionTarget);

  if (decision.status === "deny") {
    return {
      status: "denied",
      message: decision.reason,
      action,
      confirmation: null,
      log: null
    };
  }

  if (decision.status === "requiresConfirmation" && !confirmed) {
    return {
      status: "requiresConfirmation",
      message: decision.reason,
      action,
      confirmation: {
        title: action.title,
        description: decision.reason,
        riskLevel: decision.riskLevel,
        command: action.command,
        target: permissionTarget
      }
    };
  }

  if (confirmed && remember && decision.riskLevel === "low") {
    saveBrowserPermissionRule(action.actionType, permissionTarget, "allow");
  }

  return {
    status: "completed",
    message: `浏览器预览模式：${action.title}`,
    action,
    log: null
  };
}

type PreviewPermissionDecision = {
  status: "allow" | "requiresConfirmation" | "deny";
  riskLevel: "low" | "high" | "unknown" | "blocked";
  reason: string;
};

function planPreviewLocalAction(text: string): LocalActionRequest | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const browserSearch = planPreviewBrowserSearch(trimmed);
  if (browserSearch) {
    return browserSearch;
  }

  if (trimmed.includes("浏览器") && trimmed.includes("打开")) {
    return openAppAction(resolvePreviewAppName("浏览器"));
  }

  const lowered = trimmed.toLowerCase();
  if (lowered.includes("browser") && (lowered.includes("open") || lowered.includes("launch")) && !lowered.includes("search")) {
    return openAppAction(resolvePreviewAppName("browser"));
  }

  const desktopFolderName = planPreviewDesktopFolderName(trimmed);
  if (desktopFolderName) {
    return shellAction(`mkdir -p ~/Desktop/${shellQuote(desktopFolderName)}`);
  }

  const command = stripAnyPrefix(trimmed, ["运行命令", "执行命令", "运行 shell", "执行 shell"])
    || stripAsciiPrefix(trimmed, ["run command ", "execute command ", "run shell ", "execute shell "]);
  if (command) {
    return shellAction(command);
  }

  const copied = stripAnyPrefix(trimmed, ["复制", "拷贝"]) || stripAsciiPrefix(trimmed, ["copy "]);
  if (copied) {
    const copiedText = copied
      .replace(/到剪贴板$/u, "")
      .replace(/到剪切板$/u, "")
      .replace(/ to clipboard$/iu, "")
      .trim();
    if (copiedText) {
      return {
        actionType: "copy_text",
        title: "复制文本到剪贴板",
        appName: "",
        url: "",
        path: "",
        text: copiedText,
        command: ""
      };
    }
  }

  if (
    trimmed.includes("创建备忘录") ||
    trimmed.includes("添加备忘录") ||
    trimmed.includes("新建备忘录") ||
    lowered.includes("create note") ||
    lowered.includes("add note") ||
    lowered.includes("new note")
  ) {
    const noteText = (
      extractAfterMarkers(trimmed, ["内容是", "内容为", "：", ":"]) ||
      extractAfterMarkersCaseInsensitive(trimmed, ["content is", "content:", "body:", "note:"]) ||
      trimmed
        .replace("创建备忘录", "")
        .replace("添加备忘录", "")
        .replace("新建备忘录", "")
        .replace(/create note/iu, "")
        .replace(/add note/iu, "")
        .replace(/new note/iu, "")
    ).trim();
    if (noteText) {
      return {
        actionType: "create_note",
        title: "创建备忘录",
        appName: "",
        url: "",
        path: "",
        text: noteText,
        command: ""
      };
    }
  }

  if (
    trimmed.includes("提醒我") ||
    trimmed.includes("创建提醒") ||
    trimmed.includes("添加提醒") ||
    lowered.includes("remind me") ||
    lowered.includes("create reminder") ||
    lowered.includes("add reminder")
  ) {
    const reminderTitle = trimmed
      .replace("提醒我", "")
      .replace("创建提醒", "")
      .replace("添加提醒", "")
      .replace(/remind me to/iu, "")
      .replace(/remind me/iu, "")
      .replace(/create reminder/iu, "")
      .replace(/add reminder/iu, "")
      .trim();
    if (reminderTitle) {
      return {
        actionType: "create_reminder",
        title: reminderTitle,
        appName: "",
        url: "",
        path: "",
        text: "",
        command: ""
      };
    }
  }

  const target = stripAnyPrefix(trimmed, ["打开"]) || stripAsciiPrefix(trimmed, ["open "]);
  if (!target?.trim()) {
    return null;
  }

  const normalizedTarget = target.trim();
  const commonFolder = commonPreviewFolderPath(normalizedTarget);
  if (commonFolder) {
    return openPathAction(commonFolder);
  }
  if (looksLikeLocalPath(normalizedTarget)) {
    return openPathAction(expandPreviewHome(normalizedTarget));
  }
  if (looksLikeWebAddress(normalizedTarget)) {
    return openUrlAction(normalizeUrl(normalizedTarget));
  }
  return openAppAction(resolvePreviewAppName(normalizedTarget));
}

function previewPermissionDecision(action: LocalActionRequest, target: string): PreviewPermissionDecision {
  const config = loadBrowserConfigSnapshot();

  if (action.actionType === "open_path" && previewPathIsBlocked(action.path, config.permissions.blockedPaths)) {
    return {
      status: "deny",
      riskLevel: "blocked",
      reason: "目标路径在 blockedPaths 中"
    };
  }

  if (action.actionType === "shell") {
    const blockedPath = previewBlockedShellTarget(action.command, config.permissions.blockedPaths);
    if (blockedPath) {
      return {
        status: "deny",
        riskLevel: "blocked",
        reason: `Shell 命令访问了 blockedPaths 中的路径：${blockedPath}`
      };
    }

    const riskLevel = previewShellCommandRisk(action.command);
    if (riskLevel !== "low") {
      return {
        status: "requiresConfirmation",
        riskLevel,
        reason: "Shell 命令可能修改系统、删除数据或访问敏感位置，必须确认"
      };
    }
  }

  if (browserPermissionRuleAllows(action.actionType, target)) {
    return {
      status: "allow",
      riskLevel: "low",
      reason: "已记住此动作的长期授权"
    };
  }

  if (["open_app", "copy_text", "create_note", "create_reminder"].includes(action.actionType)) {
    return {
      status: "allow",
      riskLevel: "low",
      reason: "低风险白名单动作"
    };
  }

  if (action.actionType === "open_path") {
    return {
      status: "allow",
      riskLevel: "low",
      reason: "只读打开文件或文件夹"
    };
  }

  if (["browser_search", "open_url"].includes(action.actionType)) {
    if (config.permissions.allowBrowserAutomation) {
      return {
        status: "allow",
        riskLevel: "low",
        reason: "已在设置中授权低风险浏览器动作"
      };
    }
    return {
      status: "requiresConfirmation",
      riskLevel: "low",
      reason: "低风险浏览器动作需要先在设置中开启自动授权"
    };
  }

  if (action.actionType === "shell") {
    if (config.permissions.allowShell) {
      return {
        status: "allow",
        riskLevel: "low",
        reason: "已在设置中授权低风险 Shell 命令"
      };
    }
    return {
      status: "requiresConfirmation",
      riskLevel: "low",
      reason: "低风险 Shell 命令需要先在设置中开启自动授权"
    };
  }

  return {
    status: "requiresConfirmation",
    riskLevel: "low",
    reason: "此本地动作需要确认"
  };
}

function loadBrowserConfigSnapshot(): AppConfig {
  const saved = localStorage.getItem(mockStorageKey);
  if (!saved) {
    return defaultConfig;
  }
  try {
    return normalizeConfig(JSON.parse(saved));
  } catch {
    return defaultConfig;
  }
}

function planPreviewBrowserSearch(text: string): LocalActionRequest | null {
  const query = extractPreviewBrowserSearchQuery(text);
  if (!query) {
    return null;
  }
  const engine = text.toLowerCase().includes("baidu") || text.includes("百度") ? "baidu" : "google";
  const url = engine === "baidu"
    ? `https://www.baidu.com/s?wd=${percentEncodeQuery(query)}`
    : `https://www.google.com/search?q=${percentEncodeQuery(query)}`;
  return {
    actionType: "browser_search",
    title: `浏览器搜索 ${query}`,
    appName: "Google Chrome",
    url,
    path: "",
    text: query,
    command: ""
  };
}

function extractPreviewBrowserSearchQuery(text: string): string {
  const trimmed = text.replace(/^阿福/u, "").trim();
  const markers = [
    "用浏览器搜索",
    "在浏览器搜索",
    "浏览器搜索",
    "用 Google 搜索",
    "用Google搜索",
    "Google 搜索",
    "Google搜索",
    "google 搜索",
    "google搜索",
    "用谷歌搜索",
    "谷歌搜索",
    "用百度搜索",
    "百度搜索",
    "搜索一下",
    "搜索"
  ];
  const query = markers
    .map((marker) => trimmed.split(marker)[1]?.trim() || "")
    .find(Boolean)
    || extractAfterMarkersCaseInsensitive(trimmed, [
      "search google for",
      "google search for",
      "search baidu for",
      "baidu search for",
      "search in browser for",
      "search in browser",
      "search the browser for",
      "search browser for",
      "search for",
      "search",
      "google",
      "baidu"
    ])
    || (trimmed.startsWith("搜") ? trimmed.slice(1).trim() : "");
  return cleanPreviewSearchQuery(query);
}

function cleanPreviewSearchQuery(query: string) {
  return query
    .trim()
    .replace(/^一下/u, "")
    .replace(/^关于/u, "")
    .replace(/^for\b/iu, "")
    .replace(/^[\s，,。."'“”：:?]+|[\s，,。."'“”：:?]+$/gu, "")
    .trim();
}

function planPreviewDesktopFolderName(text: string): string | null {
  const normalized = text.replace(/^阿福/u, "").trim();
  const mentionsDesktop = normalized.includes("桌面") || normalized.toLowerCase().includes("desktop");
  const createsFolder =
    (normalized.includes("创建") || normalized.includes("新建") || normalized.includes("建立")) &&
    (normalized.includes("文件夹") || normalized.includes("目录"));
  if (!createsFolder) {
    return null;
  }
  const name = extractAfterMarkers(normalized, [
    "名字叫做",
    "名字叫",
    "叫做",
    "名称叫做",
    "名称叫",
    "名为",
    "名称是",
    "名称为",
    "名字是",
    "名字为",
    "叫"
  ])
    ?.replace("的文件夹", "")
    .replace("文件夹", "")
    .replace("在桌面", "")
    .replace("到桌面", "")
    .replace(/^[\s，,。."'“”]+|[\s，,。."'“”]+$/gu, "")
    .trim();
  return name || (mentionsDesktop ? "新文件夹" : null);
}

function openAppAction(appName: string): LocalActionRequest {
  return {
    actionType: "open_app",
    title: `打开 ${appName}`,
    appName,
    url: "",
    path: "",
    text: "",
    command: ""
  };
}

function openUrlAction(url: string): LocalActionRequest {
  return {
    actionType: "open_url",
    title: `打开 ${url}`,
    appName: "",
    url,
    path: "",
    text: "",
    command: ""
  };
}

function openPathAction(path: string): LocalActionRequest {
  return {
    actionType: "open_path",
    title: `打开 ${path}`,
    appName: "",
    url: "",
    path,
    text: "",
    command: ""
  };
}

function shellAction(command: string): LocalActionRequest {
  return {
    actionType: "shell",
    title: "运行 Shell 命令",
    appName: "",
    url: "",
    path: "",
    text: "",
    command: command.trim()
  };
}

function resolvePreviewAppName(target: string) {
  const trimmed = target
    .trim()
    .replace(/^my\s+/iu, "")
    .replace(/^the\s+/iu, "")
    .trim();
  switch (trimmed.toLowerCase()) {
    case "备忘录":
    case "notes":
      return "Notes";
    case "微信":
    case "wechat":
      return "WeChat";
    case "提醒事项":
    case "reminders":
      return "Reminders";
    case "浏览器":
    case "browser":
    case "chrome":
    case "google chrome":
      return "Google Chrome";
    case "finder":
    case "访达":
      return "Finder";
    case "terminal":
    case "终端":
      return "Terminal";
    case "safari":
      return "Safari";
    default:
      return trimmed;
  }
}

function commonPreviewFolderPath(target: string): string | null {
  const normalized = target
    .trim()
    .replace(/^我的/u, "")
    .replace(/^my\s+/iu, "")
    .replace(/^the\s+/iu, "")
    .replace(/(目录|文件夹)$/u, "")
    .trim()
    .toLowerCase();
  if (normalized.includes("应用程序") || ["applications", "application", "apps"].includes(normalized)) {
    return "/Applications";
  }
  if (normalized.includes("下载") || ["downloads", "download"].includes(normalized)) {
    return "~/Downloads";
  }
  if (normalized.includes("桌面") || normalized === "desktop") {
    return "~/Desktop";
  }
  if (normalized.includes("文稿") || normalized.includes("文档") || ["documents", "docs"].includes(normalized)) {
    return "~/Documents";
  }
  if (["home", "主目录", "个人文件夹"].includes(normalized)) {
    return "~";
  }
  return null;
}

function previewPathIsBlocked(path: string, blockedPaths: string[]) {
  return previewPathConflictsWithBlocked(path, blockedPaths, false);
}

function previewPathConflictsWithBlocked(path: string, blockedPaths: string[], includeBlockedChildren: boolean) {
  const normalizedTarget = normalizePreviewPathForCompare(path);
  return blockedPaths.some((blockedPath) => {
    const normalizedBlockedPath = normalizePreviewPathForCompare(blockedPath);
    return (
      normalizedBlockedPath &&
      (normalizedTarget === normalizedBlockedPath ||
        normalizedTarget.startsWith(`${normalizedBlockedPath}/`) ||
        (includeBlockedChildren &&
          previewPathCanContainBlockedChildren(normalizedTarget) &&
          normalizedBlockedPath.startsWith(`${normalizedTarget}/`)))
    );
  });
}

function previewPathCanContainBlockedChildren(path: string) {
  return path.startsWith("/") || path.startsWith("~/") || path === "~";
}

function normalizePreviewPathForCompare(path: string) {
  const trimmed = previewLocalFileUrlPath(path).trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

function previewLocalFileUrlPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) {
      return trimmed;
    }
    return decodeURIComponent(url.pathname);
  } catch {
    const withoutScheme = trimmed.slice("file://".length);
    if (withoutScheme.startsWith("/")) {
      return decodeURIComponentSafe(withoutScheme);
    }
    if (withoutScheme.startsWith("localhost/")) {
      return decodeURIComponentSafe(`/${withoutScheme.slice("localhost/".length)}`);
    }
    return trimmed;
  }
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function previewBlockedShellTarget(command: string, blockedPaths: string[]) {
  const tokens = parsePreviewShellTokens(command);
  const executable = tokens[0]?.toLowerCase() || "";
  const args = tokens.slice(1);
  let candidatePaths: string[] = [];
  const recursiveSearch = executable === "find" || executable === "mdfind";

  if (executable === "open") {
    candidatePaths = collectPreviewOpenPaths(args);
  } else if (["cat", "head", "tail", "wc", "ls"].includes(executable)) {
    candidatePaths = args.filter((arg) => !arg.startsWith("-"));
  } else if (executable === "mkdir") {
    candidatePaths = collectPreviewMkdirPaths(args);
  } else if (executable === "find") {
    candidatePaths = collectPreviewFindPaths(args);
  } else if (executable === "mdfind") {
    candidatePaths = collectPreviewMdfindPaths(args);
  }

  if (executable === "mdfind" && candidatePaths.length === 0) {
    return blockedPaths.find((path) => path.trim()) || "";
  }

  return (
    candidatePaths.find(
      (path) => !looksLikeUrl(path) && previewPathConflictsWithBlocked(path, blockedPaths, recursiveSearch)
    ) || ""
  );
}

function collectPreviewOpenPaths(args: string[]) {
  const paths: string[] = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "-a" || arg === "-b") {
      skipNext = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      paths.push(arg);
    }
  }
  return paths;
}

function collectPreviewFindPaths(args: string[]) {
  return args.filter((arg) => looksLikeShellPath(arg));
}

function collectPreviewMdfindPaths(args: string[]) {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-onlyin" && args[index + 1]) {
      paths.push(args[index + 1]);
      index += 1;
    }
  }
  return paths;
}

function collectPreviewMkdirPaths(args: string[]) {
  const paths: string[] = [];
  let optionsFinished = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!optionsFinished && arg === "--") {
      optionsFinished = true;
      continue;
    }
    if (!optionsFinished && arg === "-m") {
      index += 1;
      continue;
    }
    if (!optionsFinished && arg.startsWith("-")) {
      continue;
    }
    paths.push(arg);
  }
  return paths;
}

function parsePreviewShellTokens(command: string) {
  const tokens: string[] = [];
  let current = "";
  let quote = "";

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = "";
      } else if (char === "\\" && quote === "\"" && index + 1 < command.length) {
        index += 1;
        current += command[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
    } else if (char === "\\" && index + 1 < command.length) {
      index += 1;
      current += command[index];
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function previewMkdirTargetsAreDesktopOnly(command: string) {
  const tokens = parsePreviewShellTokens(command);
  const paths = collectPreviewMkdirPaths(tokens.slice(1));
  return paths.length > 0 && paths.every((path) => previewPathIsHomeDesktopOrChild(path));
}

function previewPathIsHomeDesktopOrChild(path: string) {
  const trimmed = path.trim();
  return /^~\/Desktop(?:\/|$)/.test(trimmed) || /^\/Users\/[^/]+\/Desktop(?:\/|$)/.test(trimmed);
}

function stripAnyPrefix(text: string, prefixes: string[]) {
  const prefix = prefixes.find((item) => text.startsWith(item));
  return prefix ? text.slice(prefix.length).trimStart() : "";
}

function stripAsciiPrefix(text: string, prefixes: string[]) {
  const lowered = text.toLowerCase();
  const prefix = prefixes.find((item) => lowered.startsWith(item.toLowerCase()));
  return prefix ? text.slice(prefix.length).trimStart() : "";
}

function extractAfterMarkers(text: string, markers: string[]) {
  const marker = markers.find((item) => text.includes(item));
  return marker ? text.split(marker).slice(1).join(marker).trim() : "";
}

function extractAfterMarkersCaseInsensitive(text: string, markers: string[]) {
  const lowered = text.toLowerCase();
  const marker = markers.find((item) => lowered.includes(item.toLowerCase()));
  if (!marker) {
    return "";
  }
  const index = lowered.indexOf(marker.toLowerCase());
  return text.slice(index + marker.length).trim();
}

function looksLikeUrl(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

function looksLikeShellPath(value: string) {
  const trimmed = value.trim();
  return (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.includes("/")
  );
}

function looksLikeWebAddress(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (looksLikeUrl(trimmed)) {
    return true;
  }
  if (looksLikeLocalPath(trimmed) || /\s/.test(trimmed)) {
    return false;
  }
  const host = trimmed.split("/")[0] || "";
  if (host.startsWith("www.")) {
    return true;
  }
  const tld = host.split(".").pop() || "";
  return ["ai", "app", "cn", "co", "com", "dev", "edu", "gov", "io", "me", "net", "org", "site", "top", "xyz"].includes(tld);
}

function looksLikeLocalPath(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed.startsWith("./") || trimmed.startsWith("../");
}

function normalizeUrl(value: string) {
  return value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
}

function expandPreviewHome(path: string) {
  return path.startsWith("~/") ? path : path;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function percentEncodeQuery(value: string) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function previewShellCommandRisk(command: string): "low" | "high" | "unknown" {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  const padded = ` ${normalized} `;
  const dangerousMarkers = [
    "sudo",
    " rm ",
    "rm -",
    "rm\t",
    "chmod",
    "chown",
    "dd ",
    "mkfs",
    "diskutil",
    "launchctl",
    "kill",
    "pkill",
    "security ",
    "defaults write",
    "curl ",
    "wget ",
    "|",
    "| sh",
    "|sh",
    "| bash",
    "|bash",
    "<",
    ">",
    ">>",
    "2>",
    ";",
    "&&",
    "||",
    "`",
    "$("
  ];
  if (dangerousMarkers.some((marker) => padded.includes(marker))) {
    return "high";
  }
  const executable = parsePreviewShellTokens(command)[0]?.toLowerCase() || "";
  const lowRiskCommands = ["date", "pwd", "whoami", "id", "uname", "sw_vers", "ls", "echo", "cat", "head", "tail", "wc", "find", "mdfind", "open", "mkdir"];
  if (!lowRiskCommands.includes(executable)) {
    return "high";
  }
  if (executable === "mkdir" && !previewMkdirTargetsAreDesktopOnly(command)) {
    return "high";
  }
  return "low";
}

export async function listExecutionLogs(limit = 80): Promise<ExecutionLog[]> {
  if (isTauriRuntime()) {
    return invoke<ExecutionLog[]>("list_execution_logs_command", { limit });
  }
  return [];
}

export async function clearExecutionLogs(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("clear_execution_logs_command");
  }
}

export async function deleteExecutionLog(logId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("delete_execution_log_command", { logId });
  }
}

interface WriteExecutionLogPayload {
  actionType: string;
  title: string;
  target: string;
  status: string;
  riskLevel: string;
  reason: string;
}

export async function writeExecutionLog(payload: WriteExecutionLogPayload): Promise<ExecutionLog | null> {
  if (isTauriRuntime()) {
    return invoke<ExecutionLog>("write_execution_log_command", { ...payload });
  }
  return null;
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
    imageAttachments?: ChatMessage["imageAttachments"];
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

export async function deleteConversation(conversationId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("delete_conversation_command", { conversationId });
  }
}

export async function clearConversations(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("clear_conversations_command");
  }
}

export async function listMemories(): Promise<MemoryItem[]> {
  if (isTauriRuntime()) {
    return invoke<MemoryItem[]>("list_memories_command");
  }
  return readBrowserJson<MemoryItem[]>("afuos.memories", []);
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

export async function importMemories(memories: MemoryItem[]): Promise<number> {
  if (isTauriRuntime()) {
    return invoke<number>("import_memories_command", { memories });
  }

  const normalized = memories
    .filter((memory) => memory && typeof memory.content === "string" && memory.content.trim())
    .map((memory) => ({
      ...memory,
      id: memory.id || crypto.randomUUID(),
      source: memory.source || "manual",
      createdAt: memory.createdAt || Date.now(),
      updatedAt: memory.updatedAt || memory.createdAt || Date.now()
    }));
  localStorage.setItem("afuos.memories", JSON.stringify(normalized));
  return normalized.length;
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

export async function loadSkillDocuments(paths: string[]): Promise<SkillDocument[]> {
  const requestedPaths = paths.map((path) => path.trim()).filter(Boolean);
  if (requestedPaths.length === 0) {
    return [];
  }

  if (isTauriRuntime()) {
    return invoke<SkillDocument[]>("read_skill_documents_command", { paths: requestedPaths });
  }

  return requestedPaths.map((path) => ({
    path,
    name: path.split("/").filter(Boolean).pop() || "Skill",
    content: "",
    error: "Skill 文件读取需要 Tauri 桌面运行时"
  }));
}

export async function inspectMcpServer(command: string): Promise<McpInspectionResult> {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      status: "error",
      serverName: "",
      tools: [],
      error: "MCP 命令为空"
    };
  }
  const validationError = validateMcpLaunchCommand(trimmed);
  if (validationError) {
    return {
      status: "error",
      serverName: "",
      tools: [],
      error: validationError
    };
  }

  if (isTauriRuntime()) {
    return invoke<McpInspectionResult>("inspect_mcp_server_command", { command: trimmed });
  }

  return {
    status: "error",
    serverName: "",
    tools: [],
    error: "MCP 探测需要 Tauri 桌面运行时"
  };
}

export async function callMcpTool(
  request: McpToolRequest,
  confirmed = false,
  remember = false
): Promise<McpToolExecutionResponse> {
  const trimmedCommand = request.command.trim();
  const trimmedTool = request.toolName.trim();
  if (!trimmedCommand || !trimmedTool) {
    return {
      status: "failed",
      message: !trimmedCommand ? "MCP 命令为空" : "MCP 工具名为空",
      request,
      confirmation: null,
      log: null
    };
  }
  const validationError = validateMcpLaunchCommand(trimmedCommand);
  if (validationError) {
    return {
      status: "failed",
      message: validationError,
      request,
      confirmation: null,
      log: null
    };
  }

  if (isTauriRuntime()) {
    return invoke<McpToolExecutionResponse>("call_mcp_tool_command", {
      request: {
        ...request,
        command: trimmedCommand,
        toolName: trimmedTool,
        serverName: request.serverName.trim() || "MCP"
      },
      confirmed,
      remember
    });
  }

  const normalizedRequest = {
    ...request,
    command: trimmedCommand,
    toolName: trimmedTool,
    serverName: request.serverName.trim() || "MCP"
  };
  const ruleTarget = `${trimmedCommand}::${trimmedTool}`;
  const risk = classifyPreviewMcpToolRisk(trimmedTool);
  const rememberedAllow = risk.riskLevel === "low" && browserPermissionRuleAllows("mcp_tool", ruleTarget);

  if (risk.riskLevel === "high" && !confirmed) {
    const target = `${normalizedRequest.serverName}:${trimmedTool}`;
    return {
      status: "requiresConfirmation",
      message: risk.reason,
      request: normalizedRequest,
      confirmation: {
        title: `调用 MCP 工具 ${trimmedTool}`,
        description: risk.reason,
        riskLevel: risk.riskLevel,
        command: trimmedTool,
        target
      },
      log: null
    };
  }

  if (confirmed && remember && risk.riskLevel === "low") {
    saveBrowserPermissionRule("mcp_tool", `${trimmedCommand}::${trimmedTool}`, "allow");
  }

  return {
    status: "failed",
    message: rememberedAllow
      ? "MCP 工具调用需要 Tauri 桌面运行时（已匹配低风险长期授权）"
      : "MCP 工具调用需要 Tauri 桌面运行时",
    request: normalizedRequest,
    confirmation: null,
    log: null
  };
}

function validateMcpLaunchCommand(command: string) {
  let quote = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = "";
      } else if (quote === "\"" && character === "\\") {
        index += 1;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if ([";", "|", "&", ">", "<", "`"].includes(character)) {
      return "MCP 命令不允许使用 shell 控制符，请只填写程序和参数。";
    }
  }
  return quote ? "MCP 命令包含未闭合的引号。" : "";
}

function classifyPreviewMcpToolRisk(toolName: string) {
  const tokens = mcpToolNameTokens(toolName);
  const highRiskMarkers = [
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
    "shell"
  ];
  if (highRiskMarkers.some((marker) => tokens.some((token) => token === marker || token === `${marker}s`))) {
    return {
      riskLevel: "high",
      reason: "显式用户触发的 MCP 工具调用，工具名包含写入或执行语义"
    };
  }

  return {
    riskLevel: "low",
    reason: "显式用户触发的 MCP 工具调用"
  };
}

function mcpToolNameTokens(toolName: string) {
  const tokens: string[] = [];
  let current = "";
  let previousWasLowerOrDigit = false;

  for (const character of toolName) {
    if (!/[a-zA-Z0-9]/.test(character)) {
      if (current) {
        tokens.push(current.toLowerCase());
        current = "";
      }
      previousWasLowerOrDigit = false;
      continue;
    }

    if (/[A-Z]/.test(character) && previousWasLowerOrDigit && current) {
      tokens.push(current.toLowerCase());
      current = "";
    }

    previousWasLowerOrDigit = /[a-z0-9]/.test(character);
    current += character;
  }

  if (current) {
    tokens.push(current.toLowerCase());
  }

  return tokens;
}

export async function listPermissionRules(): Promise<PermissionRule[]> {
  if (isTauriRuntime()) {
    return invoke<PermissionRule[]>("list_permission_rules_command");
  }

  return readBrowserJson<PermissionRule[]>(permissionRulesStorageKey, []);
}

export async function deletePermissionRule(ruleId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("delete_permission_rule_command", { ruleId });
    return;
  }

  const rules = await listPermissionRules();
  localStorage.setItem(
    permissionRulesStorageKey,
    JSON.stringify(rules.filter((rule) => rule.id !== ruleId))
  );
}

export async function clearPermissionRules(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("clear_permission_rules_command");
    return;
  }

  localStorage.removeItem(permissionRulesStorageKey);
}

function saveBrowserPermissionRule(actionType: string, target: string, decision: string) {
  const rules = readBrowserJson<PermissionRule[]>(permissionRulesStorageKey, []);
  const nextRule: PermissionRule = {
    id: crypto.randomUUID(),
    actionType,
    target,
    decision,
    createdAt: Date.now()
  };
  const nextRules = [
    nextRule,
    ...rules.filter((rule) => !(rule.actionType === actionType && rule.target === target))
  ];
  localStorage.setItem(permissionRulesStorageKey, JSON.stringify(nextRules));
}

function browserPermissionRuleAllows(actionType: string, target: string) {
  const rules = readBrowserJson<PermissionRule[]>(permissionRulesStorageKey, []);
  return rules.some(
    (rule) => rule.actionType === actionType && rule.target === target && rule.decision === "allow"
  );
}

function readBrowserJson<T>(storageKey: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    localStorage.removeItem(storageKey);
    return fallback;
  }
}

function permissionRuleTargetForLocalAction(action: LocalActionRequest) {
  switch (action.actionType) {
    case "open_app":
      return action.appName.trim();
    case "open_url":
      return action.url.trim();
    case "open_path":
      return action.path.trim();
    case "copy_text":
      return action.text.trim();
    case "create_note":
      return action.text.trim();
    case "create_reminder":
      return action.title.trim();
    case "browser_search":
      return action.url.trim();
    case "shell":
      return action.command.trim();
    default:
      return "";
  }
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
  const modelsConfig = config.models || defaultConfig.models;
  const registryConfig = config.registries || defaultConfig.registries;
  const hasSelectedVisionProfileId = Object.prototype.hasOwnProperty.call(modelsConfig, "selectedVisionProfileId");
  const hasSelectedTtsProfileId = Object.prototype.hasOwnProperty.call(modelsConfig, "selectedTtsProfileId");
  const hasSelectedSttProfileId = Object.prototype.hasOwnProperty.call(modelsConfig, "selectedSttProfileId");
  const legacyTextProfile: ModelProfile = {
    ...defaultTextProfile,
    provider: modelsConfig.text?.provider || defaultTextProfile.provider,
    baseUrl: modelsConfig.text?.baseUrl || defaultTextProfile.baseUrl,
    model: modelsConfig.text?.model || defaultTextProfile.model,
    apiKey: modelsConfig.text?.apiKey || ""
  };
  const legacyVisionProfile: ModelProfile = {
    id: "vision-legacy",
    name: "迁移的多模态模型",
    capabilities: ["vision"],
    kind: "vision",
    provider: modelsConfig.vision?.provider || "openai-compatible",
    baseUrl: modelsConfig.vision?.baseUrl || "",
    model: modelsConfig.vision?.model || "",
    apiKey: "",
    voice: ""
  };
  const baseProfiles = modelsConfig.profiles?.length ? modelsConfig.profiles : [legacyTextProfile];
  const hasVisionProfile = baseProfiles.some((profile) =>
    (Array.isArray(profile.capabilities) ? profile.capabilities : [profile.kind || "text"]).includes("vision")
  );
  const insertedLegacyVision = !hasVisionProfile && Boolean(modelsConfig.vision?.model || modelsConfig.vision?.baseUrl);
  const profiles = [
    ...baseProfiles,
    ...(insertedLegacyVision ? [legacyVisionProfile] : [])
  ].map((profile) => {
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
  const resolveSelectedProfileId = (
    capability: ModelProfileKind,
    selectedId: string | undefined,
    preserveExplicitEmpty: boolean
  ) => {
    if (selectedId) {
      const selected = profiles.find((profile) => profile.id === selectedId && profile.capabilities.includes(capability));
      if (selected) {
        return selected.id;
      }
    }
    if (preserveExplicitEmpty && !selectedId) {
      return "";
    }
    return profiles.find((profile) => profile.capabilities.includes(capability))?.id || "";
  };
  const selectedTextProfileId = resolveSelectedProfileId("text", modelsConfig.selectedTextProfileId, false);
  const selectedSttProfileId = resolveSelectedProfileId(
    "stt",
    modelsConfig.selectedSttProfileId,
    hasSelectedSttProfileId
  );
  const selectedTtsProfileId = resolveSelectedProfileId(
    "tts",
    modelsConfig.selectedTtsProfileId,
    hasSelectedTtsProfileId
  );
  const selectedVisionProfileId = resolveSelectedProfileId(
    "vision",
    modelsConfig.selectedVisionProfileId,
    hasSelectedVisionProfileId
  );
  const normalizedSkills: SkillRegistryEntry[] = Array.isArray(registryConfig.skills)
    ? registryConfig.skills
        .filter((skill) => skill && typeof skill.path === "string" && skill.path.trim())
        .map((skill) => ({
          id: skill.id || crypto.randomUUID(),
          name: skill.name || skill.path.split("/").filter(Boolean).pop() || "Skill",
          path: skill.path,
          enabled: Boolean(skill.enabled)
        }))
    : [];
  const normalizedMcpServers: McpRegistryEntry[] = Array.isArray(registryConfig.mcpServers)
    ? registryConfig.mcpServers
        .filter((server) => server && typeof server.command === "string" && server.command.trim())
        .map((server) => ({
          id: server.id || crypto.randomUUID(),
          name: server.name || server.command.split(/\s+/)[0] || "MCP",
          command: server.command,
          enabled: Boolean(server.enabled),
          tools: Array.isArray(server.tools) ? server.tools : [],
          toolError: server.toolError || "",
          checkedAt: typeof server.checkedAt === "number" ? server.checkedAt : undefined
        }))
    : [];

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
      selectedVisionProfileId,
      selectedTtsProfileId,
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
    registries: {
      skills: normalizedSkills,
      mcpServers: normalizedMcpServers
    },
    memory: { ...defaultConfig.memory, ...config.memory }
  };
}

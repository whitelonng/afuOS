export type AssistantStatus =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "executing"
  | "confirming"
  | "error";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

export interface LocalActionRequest {
  actionType: string;
  title: string;
  appName: string;
  url: string;
  path: string;
  text: string;
  command: string;
}

export interface ConfirmationPayload {
  title: string;
  description: string;
  riskLevel: string;
  command: string;
  target: string;
}

export interface ExecutionLog {
  id: string;
  actionType: string;
  title: string;
  target: string;
  status: string;
  riskLevel: string;
  reason: string;
  createdAt: number;
}

export interface LocalActionResponse {
  status: "completed" | "requiresConfirmation" | "denied" | "failed";
  message: string;
  action?: LocalActionRequest | null;
  confirmation?: ConfirmationPayload | null;
  log?: ExecutionLog | null;
}

export interface ConversationSnapshot {
  conversation: {
    id: string;
    title: string;
    summary: string;
    createdAt: number;
    updatedAt: number;
  };
  messages: Array<{
    id: string;
    conversationId: string;
    role: ChatRole;
    content: string;
    createdAt: number;
  }>;
}

export interface MemoryItem {
  id: string;
  content: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface TextModelConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type ModelProfileKind = "text" | "vision" | "tts" | "stt";

export interface ModelProfile {
  id: string;
  name: string;
  capabilities: ModelProfileKind[];
  /** @deprecated kept for older persisted configs and backend compatibility */
  kind: ModelProfileKind;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  voice?: string;
}

export interface AppConfig {
  general: {
    language: "zh-CN" | "en-US";
    shortcut: string;
    windowSize: string;
    hotwordEnabled: boolean;
  };
  models: {
    text: TextModelConfig;
    profiles: ModelProfile[];
    selectedTextProfileId: string;
    selectedVisionProfileId: string;
    selectedTtsProfileId: string;
    selectedSttProfileId: string;
    vision: {
      provider: string;
      baseUrl: string;
      model: string;
      apiKeyRef: string;
    };
    tts: {
      provider: string;
      baseUrl: string;
      voice: string;
      apiKeyRef: string;
    };
  };
  voice: {
    pushToTalkEnabled: boolean;
    ttsEnabled: boolean;
    sttMode: "local" | "model";
    sttModel: string;
    pushToTalkKey: string;
    pushToTalkMode: "hold" | "toggle";
    autoSendOnVoiceEnd: boolean;
  };
  permissions: {
    allowShell: boolean;
    allowBrowserAutomation: boolean;
    blockedPaths: string[];
    trustedSkills: string[];
  };
  memory: {
    enabled: boolean;
    maxLongTermMemories: number;
    maxInjectedMemories: number;
    maxRecentTurns: number;
    summaryMaxChars: number;
  };
}

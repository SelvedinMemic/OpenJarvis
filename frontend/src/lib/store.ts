import { create } from 'zustand';
import type {
  Conversation,
  ChatMessage,
  LiveEnergyMetrics,
  LogEntry,
  ModelInfo,
  MessageTelemetry,
  ResearchSearchTrace,
  ResearchSource,
  SavingsData,
  ServerInfo,
  StreamState,
  ToolCallInfo,
  TokenUsage,
} from '../types';
import {
  fetchSharedConversations,
  saveSharedConversations,
  type ManagedAgent,
} from './api';

export interface CachedConnector {
  connector_id: string;
  display_name: string;
  connected: boolean;
  chunks: number;
}

export interface AgentEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

// ── localStorage persistence ──────────────────────────────────────────

const CONVERSATIONS_KEY = 'openjarvis-conversations';
const SETTINGS_KEY = 'openjarvis-settings';
const OPTIN_KEY = 'openjarvis-optin';
const OPTIN_NAME_KEY = 'openjarvis-display-name';
const OPTIN_EMAIL_KEY = 'openjarvis-email';
const OPTIN_ANONID_KEY = 'openjarvis-anon-id';
const OPTIN_SEEN_KEY = 'openjarvis-optin-seen';

interface ConversationStore {
  version: 1;
  conversations: Record<string, Conversation>;
  activeId: string | null;
}

function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeConversationStore(raw: any): {
  store: ConversationStore;
  changed: boolean;
} {
  if (!raw || raw.version !== 1 || typeof raw.conversations !== 'object') {
    return {
      store: { version: 1, conversations: {}, activeId: null },
      changed: false,
    };
  }

  let changed = false;
  const normalized: Record<string, Conversation> = {};

  for (const [id, conv] of Object.entries(raw.conversations as Record<string, any>)) {
    if (!conv || typeof conv !== 'object') {
      changed = true;
      continue;
    }

    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const normMessages = messages.map((m: any) => {
      const next = { ...m };

      if (typeof next.content !== 'string') {
        next.content = toDisplayString(next.content);
        changed = true;
      }

      if (Array.isArray(next.toolCalls)) {
        next.toolCalls = next.toolCalls.map((tc: any) => {
          const n = { ...tc };

          const normalizedTool =
            typeof n.tool === 'string'
              ? n.tool
              : typeof n.target === 'string'
                ? n.target
                : toDisplayString(n.tool || n.target || 'tool');
          if (n.tool !== normalizedTool) {
            n.tool = normalizedTool;
            changed = true;
          }

          const normalizedArgs =
            typeof n.arguments === 'string'
              ? n.arguments
              : toDisplayString(n.arguments ?? {});
          if (n.arguments !== normalizedArgs) {
            n.arguments = normalizedArgs;
            changed = true;
          }

          const normalizedStatus =
            n.status === 'running' || n.status === 'success' || n.status === 'error'
              ? n.status
              : 'success';
          if (n.status !== normalizedStatus) {
            n.status = normalizedStatus;
            changed = true;
          }

          if (!n.id || typeof n.id !== 'string') {
            n.id = generateId();
            changed = true;
          }

          if (n.result != null && typeof n.result !== 'string') {
            n.result = toDisplayString(n.result);
            changed = true;
          }

          if (n.latency != null && typeof n.latency !== 'number') {
            const parsed = Number(n.latency);
            n.latency = Number.isFinite(parsed) ? parsed : undefined;
            changed = true;
          }

          return n;
        });
      }

      return next;
    });

    normalized[id] = {
      id: conv.id || id,
      title: typeof conv.title === 'string' ? conv.title : 'New chat',
      createdAt: Number(conv.createdAt) || Date.now(),
      updatedAt: Number(conv.updatedAt) || Date.now(),
      model: typeof conv.model === 'string' ? conv.model : 'default',
      messages: normMessages,
    };
  }

  const activeId =
    typeof raw.activeId === 'string' && normalized[raw.activeId]
      ? raw.activeId
      : null;

  return {
    store: {
      version: 1,
      conversations: normalized,
      activeId,
    },
    changed,
  };
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadConversations(): ConversationStore {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY);
    if (!raw) return { version: 1, conversations: {}, activeId: null };
    const parsed = JSON.parse(raw);
    const { store, changed } = normalizeConversationStore(parsed);
    if (changed) saveConversations(store);
    return store;
  } catch {
    return { version: 1, conversations: {}, activeId: null };
  }
}

function saveConversations(store: ConversationStore): void {
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(store));
  void saveSharedConversations(store).catch(() => {
    // Offline/local mode fallback: keep local save even when server sync fails.
  });
}

export type ThemeMode = 'light' | 'dark' | 'system';

interface Settings {
  theme: ThemeMode;
  apiUrl: string;
  // Local server API key (OPENJARVIS_API_KEY). Sent as a Bearer token on
  // /v1 + /api requests so a key-protected `jarvis serve` doesn't 401 the
  // frontend (#266). Empty = no auth header (keyless local default).
  apiKey: string;
  fontSize: 'small' | 'default' | 'large';
  defaultModel: string;
  defaultAgent: string;
  temperature: number;
  maxTokens: number;
  speechEnabled: boolean;
  voiceDialogEnabled: boolean;
  voiceReadAloudEnabled: boolean;
  speechVoiceName: string;
}

function loadSettings(): Settings {
  const defaults: Settings = {
    theme: 'system',
    apiUrl: '',
    apiKey: '',
    fontSize: 'default',
    defaultModel: '',
    defaultAgent: '',
    temperature: 0.7,
    maxTokens: 4096,
    speechEnabled: true,
    voiceDialogEnabled: true,
    voiceReadAloudEnabled: true,
    speechVoiceName: '',
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ── Store ─────────────────────────────────────────────────────────────

const INITIAL_STREAM: StreamState = {
  isStreaming: false,
  phase: '',
  elapsedMs: 0,
  activeToolCalls: [],
  content: '',
};

interface AppState {
  // Conversations
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  streamState: StreamState;

  // Models & server
  models: ModelInfo[];
  modelsLoading: boolean;
  selectedModel: string;
  serverInfo: ServerInfo | null;
  savings: SavingsData | null;

  // Settings
  settings: Settings;

  // Command palette
  commandPaletteOpen: boolean;

  // Sidebar
  sidebarOpen: boolean;

  // System panel
  systemPanelOpen: boolean;

  // Opt-in sharing
  optInEnabled: boolean;
  optInDisplayName: string;
  optInEmail: string;
  optInAnonId: string;
  optInModalSeen: boolean;
  optInModalOpen: boolean;

  // Actions: conversations
  loadConversations: () => void;
  syncConversationsFromServer: () => Promise<void>;
  importOverlayConversation: () => Promise<void>;
  createConversation: (model?: string) => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  loadMessages: (conversationId: string | null) => void;
  addMessage: (conversationId: string, message: ChatMessage) => void;
  updateLastAssistant: (
    conversationId: string,
    content: string,
    toolCalls?: ToolCallInfo[],
    usage?: TokenUsage,
    telemetry?: MessageTelemetry,
    audio?: { url: string },
    researchTraces?: ResearchSearchTrace[],
    researchSources?: ResearchSource[],
  ) => void;
  setStreamState: (state: Partial<StreamState>) => void;
  resetStream: () => void;

  // Deep Research toggle
  deepResearch: boolean;
  setDeepResearch: (on: boolean) => void;

  // Actions: models & server
  setModels: (models: ModelInfo[]) => void;
  setModelsLoading: (loading: boolean) => void;
  setSelectedModel: (model: string) => void;
  setServerInfo: (info: ServerInfo | null) => void;
  setSavings: (data: SavingsData | null) => void;
  incrementSavings: (usage: TokenUsage) => void;

  // Live GPU metrics — streamed from /api/research system_metrics events.
  // When non-null, the System panel renders this instead of polled values
  // so Power (W) and Energy (kJ) update in real time during a research run.
  liveEnergy: LiveEnergyMetrics | null;
  setLiveEnergy: (data: LiveEnergyMetrics | null) => void;

  // Actions: settings
  updateSettings: (partial: Partial<Settings>) => void;

  // Actions: UI
  setCommandPaletteOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSystemPanel: () => void;
  setSystemPanelOpen: (open: boolean) => void;

  // Data sources (cached between visits to avoid empty-state flicker)
  cachedConnectors: CachedConnector[] | null;
  setCachedConnectors: (list: CachedConnector[] | null) => void;

  // Agents
  managedAgents: ManagedAgent[];
  managedAgentsLoading: boolean;
  selectedAgentId: string | null;

  // Actions: agents
  setManagedAgents: (agents: ManagedAgent[]) => void;
  setManagedAgentsLoading: (loading: boolean) => void;
  setSelectedAgentId: (id: string | null) => void;

  // Agent events (live stream)
  agentEvents: AgentEvent[];
  addAgentEvent: (event: AgentEvent) => void;
  clearAgentEvents: () => void;

  // Actions: opt-in sharing
  setOptIn: (enabled: boolean, displayName: string, email: string) => void;
  setOptInModalOpen: (open: boolean) => void;
  markOptInModalSeen: () => void;

  // Logs
  logEntries: LogEntry[];
  addLogEntry: (entry: LogEntry) => void;
  clearLogs: () => void;

  // Model loading
  modelLoading: boolean;
  setModelLoading: (loading: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => {
  const initial = loadConversations();
  const convList = Object.values(initial.conversations).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  return {
    conversations: convList,
    activeId: initial.activeId,
    messages:
      initial.activeId && initial.conversations[initial.activeId]
        ? initial.conversations[initial.activeId].messages
        : [],
    streamState: INITIAL_STREAM,

    models: [],
    modelsLoading: true,
    selectedModel: '',
    serverInfo: null,
    savings: null,

    settings: loadSettings(),

    commandPaletteOpen: false,
    sidebarOpen: true,
    systemPanelOpen: true,

    optInEnabled: localStorage.getItem(OPTIN_KEY) === 'true',
    optInDisplayName: localStorage.getItem(OPTIN_NAME_KEY) || '',
    optInEmail: localStorage.getItem(OPTIN_EMAIL_KEY) || '',
    optInAnonId: localStorage.getItem(OPTIN_ANONID_KEY) || crypto.randomUUID(),
    optInModalSeen: localStorage.getItem(OPTIN_SEEN_KEY) === 'true',
    optInModalOpen: false,

    // ── Conversations ───────────────────────────────────────────────

    loadConversations: () => {
      const store = loadConversations();
      set({
        conversations: Object.values(store.conversations).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        ),
        activeId: store.activeId,
      });
    },

    syncConversationsFromServer: async () => {
      try {
        const remote = await fetchSharedConversations();
        const local = loadConversations();
        const normalizedRemote = normalizeConversationStore(remote).store;

        const merged: ConversationStore = {
          version: 1,
          conversations: { ...local.conversations },
          activeId: local.activeId,
        };

        for (const [id, remoteConv] of Object.entries(normalizedRemote.conversations)) {
          const localConv = merged.conversations[id];
          if (!localConv || (remoteConv.updatedAt || 0) >= (localConv.updatedAt || 0)) {
            merged.conversations[id] = remoteConv;
          }
        }

        if (normalizedRemote.activeId && merged.conversations[normalizedRemote.activeId]) {
          merged.activeId = normalizedRemote.activeId;
        }

        saveConversations(merged);
        const activeConv = merged.activeId
          ? merged.conversations[merged.activeId]
          : null;
        set({
          conversations: Object.values(merged.conversations).sort(
            (a, b) => b.updatedAt - a.updatedAt,
          ),
          activeId: merged.activeId,
          messages: activeConv ? activeConv.messages : [],
        });
      } catch {
        // If backend is unreachable we keep the existing local state.
      }
    },

    importOverlayConversation: async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const raw = await invoke<string>('get_overlay_conversation');
        if (!raw || raw === '[]') return;
        const overlay = JSON.parse(raw);
        if (!overlay.id || !overlay.messages?.length) return;
        const store = loadConversations();
        const existing = store.conversations[overlay.id];
        // Only update if the overlay has newer/more messages
        if (existing && existing.messages.length >= overlay.messages.length) return;
        // Track first use of overlay for this conversation
        if (!existing) {
          import('../lib/analytics').then(({ track }) => {
            track('feature_used', { feature_name: 'overlay' });
          });
        }
        store.conversations[overlay.id] = {
          id: overlay.id,
          title: overlay.title || 'Overlay chat',
          createdAt: overlay.createdAt || Date.now(),
          updatedAt: overlay.updatedAt || Date.now(),
          model: overlay.model || 'default',
          messages: overlay.messages,
        };
        saveConversations(store);
        set({
          conversations: Object.values(store.conversations).sort(
            (a, b) => b.updatedAt - a.updatedAt,
          ),
        });
      } catch {
        // Overlay command unavailable (non-Tauri or no overlay data)
      }
    },

    createConversation: (model?: string) => {
      const store = loadConversations();
      const conv: Conversation = {
        id: generateId(),
        title: 'New chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: model || get().selectedModel || 'default',
        messages: [],
      };
      store.conversations[conv.id] = conv;
      store.activeId = conv.id;
      saveConversations(store);
      set({
        conversations: Object.values(store.conversations).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        ),
        activeId: conv.id,
        messages: [],
      });
      return conv.id;
    },

    selectConversation: (id: string) => {
      const store = loadConversations();
      store.activeId = id;
      saveConversations(store);
      const conv = store.conversations[id];
      set({
        activeId: id,
        messages: conv ? conv.messages : [],
      });
    },

    deleteConversation: (id: string) => {
      const store = loadConversations();
      delete store.conversations[id];
      if (store.activeId === id) {
        const remaining = Object.keys(store.conversations);
        store.activeId = remaining.length > 0 ? remaining[0] : null;
      }
      saveConversations(store);
      const convList = Object.values(store.conversations).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      const activeConv = store.activeId
        ? store.conversations[store.activeId]
        : null;
      set({
        conversations: convList,
        activeId: store.activeId,
        messages: activeConv ? activeConv.messages : [],
      });
    },

    loadMessages: (conversationId: string | null) => {
      if (!conversationId) {
        set({ messages: [] });
        return;
      }
      const store = loadConversations();
      const conv = store.conversations[conversationId];
      set({ messages: conv ? conv.messages : [] });
    },

    addMessage: (conversationId: string, message: ChatMessage) => {
      const store = loadConversations();
      const conv = store.conversations[conversationId];
      if (!conv) return;
      conv.messages.push(message);
      conv.updatedAt = Date.now();
      if (message.role === 'user' && conv.title === 'New chat') {
        conv.title =
          message.content.slice(0, 50) +
          (message.content.length > 50 ? '...' : '');
      }
      saveConversations(store);
      set({
        messages: [...conv.messages],
        conversations: Object.values(store.conversations).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        ),
      });
    },

    updateLastAssistant: (
      conversationId: string,
      content: string,
      toolCalls?: ToolCallInfo[],
      usage?: TokenUsage,
      telemetry?: MessageTelemetry,
      audio?: { url: string },
      researchTraces?: ResearchSearchTrace[],
      researchSources?: ResearchSource[],
    ) => {
      const store = loadConversations();
      const conv = store.conversations[conversationId];
      if (!conv) return;
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content = content;
        if (toolCalls) lastMsg.toolCalls = toolCalls;
        if (usage) lastMsg.usage = usage;
        if (telemetry) lastMsg.telemetry = telemetry;
        if (audio) lastMsg.audio = audio;
        if (researchTraces) lastMsg.researchTraces = researchTraces;
        if (researchSources) lastMsg.researchSources = researchSources;
        conv.updatedAt = Date.now();
        saveConversations(store);
        set({ messages: [...conv.messages] });
      }
    },

    setStreamState: (partial: Partial<StreamState>) => {
      set((s) => ({ streamState: { ...s.streamState, ...partial } }));
    },

    resetStream: () => {
      set({ streamState: INITIAL_STREAM });
    },

    // ── Deep Research ─────────────────────────────────────────────
    deepResearch: false,
    setDeepResearch: (on: boolean) => set({ deepResearch: on }),

    // ── Models & server ────────────────────────────────────────────

    setModels: (models: ModelInfo[]) =>
      set((state) =>
        !state.selectedModel && models.length > 0
          ? { models, selectedModel: models[0].id }
          : { models },
      ),
    setModelsLoading: (loading: boolean) => set({ modelsLoading: loading }),
    setSelectedModel: (model: string) => set({ selectedModel: model }),
    setServerInfo: (info: ServerInfo | null) => set({ serverInfo: info }),
    setSavings: (data: SavingsData | null) => set({ savings: data }),
    incrementSavings: (usage: TokenUsage) => {
      const cur = get().savings;
      const prompt = usage.prompt_tokens ?? 0;
      const completion = usage.completion_tokens ?? 0;
      const total = usage.total_tokens ?? prompt + completion;
      set({
        savings: {
          total_calls: (cur?.total_calls ?? 0) + 1,
          total_prompt_tokens: (cur?.total_prompt_tokens ?? 0) + prompt,
          total_completion_tokens: (cur?.total_completion_tokens ?? 0) + completion,
          total_tokens: (cur?.total_tokens ?? 0) + total,
          local_cost: cur?.local_cost ?? 0,
          per_provider: cur?.per_provider ?? [],
          token_counting_version: cur?.token_counting_version,
        },
      });
    },

    liveEnergy: null,
    setLiveEnergy: (data: LiveEnergyMetrics | null) => set({ liveEnergy: data }),

    cachedConnectors: null,
    setCachedConnectors: (list) => set({ cachedConnectors: list }),

    // ── Settings ───────────────────────────────────────────────────

    updateSettings: (partial: Partial<Settings>) => {
      const updated = { ...get().settings, ...partial };
      saveSettings(updated);
      set({ settings: updated });
    },

    // ── UI ──────────────────────────────────────────────────────────

    setCommandPaletteOpen: (open: boolean) => set({ commandPaletteOpen: open }),
    toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    setSidebarOpen: (open: boolean) => set({ sidebarOpen: open }),
    toggleSystemPanel: () => set((s) => ({ systemPanelOpen: !s.systemPanelOpen })),
    setSystemPanelOpen: (open: boolean) => set({ systemPanelOpen: open }),

    // ── Agents ─────────────────────────────────────────────────────

    managedAgents: [],
    managedAgentsLoading: false,
    selectedAgentId: null,

    setManagedAgents: (agents) => set({ managedAgents: agents }),
    setManagedAgentsLoading: (loading) => set({ managedAgentsLoading: loading }),
    setSelectedAgentId: (id) => set({ selectedAgentId: id }),

    agentEvents: [],
    addAgentEvent: (event) => set((s) => ({
      agentEvents: [...s.agentEvents.slice(-99), event],
    })),
    clearAgentEvents: () => set({ agentEvents: [] }),

    // ── Logs ────────────────────────────────────────────────────────
    logEntries: [],
    addLogEntry: (entry) => set((s) => ({
      logEntries: [...s.logEntries.slice(-499), entry],
    })),
    clearLogs: () => set({ logEntries: [] }),

    // ── Model loading ───────────────────────────────────────────────
    modelLoading: false,
    setModelLoading: (loading) => set({ modelLoading: loading }),

    // ── Opt-in sharing ──────────────────────────────────────────────

    setOptIn: (enabled: boolean, displayName: string, email: string) => {
      const anonId = get().optInAnonId;
      localStorage.setItem(OPTIN_KEY, String(enabled));
      localStorage.setItem(OPTIN_NAME_KEY, displayName);
      localStorage.setItem(OPTIN_EMAIL_KEY, email);
      localStorage.setItem(OPTIN_ANONID_KEY, anonId);
      set({ optInEnabled: enabled, optInDisplayName: displayName, optInEmail: email });
    },
    setOptInModalOpen: (open: boolean) => set({ optInModalOpen: open }),
    markOptInModalSeen: () => {
      localStorage.setItem(OPTIN_SEEN_KEY, 'true');
      set({ optInModalSeen: true });
    },
  };
});

export { generateId };

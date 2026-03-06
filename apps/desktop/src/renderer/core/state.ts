import type { DaemonStateSnapshot, LogEvent, RuntimeProcessState } from '../types/bridge';

export type BadgeTone = 'active' | 'idle' | 'warn' | 'bad';

export type BadgeState = {
  tone: BadgeTone;
  label: string;
};

export type SortDirection = 'asc' | 'desc';

export type SortState = {
  key: string;
  dir: SortDirection;
};

export type PluginHints = {
  router: string | null;
};

export type PeerEntry = {
  peerId: string;
  host: string;
  port: number;
  providers: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  lastSeen: number;
  source: string;
  location: string | null;
};

export type ConfigFormData = {
  proxyPort: number;
  preferredProviders: string;
  maxInputUsdPerMillion: number;
  maxOutputUsdPerMillion: number;
  minRep: number;
  paymentMethod: string;
};

export type ChatModelOptionEntry = {
  id: string;
  label: string;
  provider: string;
  protocol: string;
  count: number;
  value: string;
};

export type RendererUiState = {
  // --- Process / runtime state ---
  processes: RuntimeProcessState[];
  refreshing: boolean;
  dashboardRunning: boolean;
  daemonState: DaemonStateSnapshot | null;

  // --- Runtime display ---
  connectState: string;
  connectBadge: BadgeState;
  dashboardState: string;
  dashboardBadge: BadgeState;
  connectWarning: string | null;
  runtimeActivity: { tone: BadgeTone; message: string };

  // --- Logs ---
  logs: LogEvent[];

  // --- Overview display ---
  overviewBadge: BadgeState;
  ovNodeState: string;
  ovPeers: string;
  ovDhtHealth: string;
  ovUptime: string;
  ovPeersCount: string;
  overviewPeers: PeerEntry[];

  // --- Peers display ---
  peersMeta: BadgeState;
  peersMessage: string;
  lastPeers: PeerEntry[];
  peerSort: SortState;
  peerFilter: string;
  lastDebugKey: string;

  // --- Connection display ---
  connectionMeta: BadgeState;
  connectionStatus: string;
  connectionNetwork: string;
  connectionSources: string;
  connectionNotes: string;
  overviewDataSources: string;

  // --- Config display ---
  configMeta: BadgeState;
  configMessage: { text: string; type: 'success' | 'error' | 'info' } | null;
  configFormData: ConfigFormData | null;
  configSaving: boolean;

  // --- Plugin setup ---
  installedPlugins: Set<string>;
  pluginHints: PluginHints;
  pluginInstallBusy: boolean;
  pluginSetupStatus: string;
  pluginInstallBtnLabel: string;
  pluginInstallBtnDisabled: boolean;
  pluginRefreshBtnDisabled: boolean;

  // --- Chat display ---
  chatActiveConversation: string | null;
  chatConversationTitle: string;
  chatConversations: unknown[];
  chatMessages: unknown[];
  chatSending: boolean;
  chatError: string | null;
  chatThreadMeta: string;
  chatRoutedPeer: string;
  chatModelOptions: ChatModelOptionEntry[];
  chatSelectedModelValue: string;
  chatModelStatus: BadgeState;
  chatProxyStatus: BadgeState;
  chatDeleteVisible: boolean;
  chatInputDisabled: boolean;
  chatSendDisabled: boolean;
  chatAbortVisible: boolean;
  chatModelSelectDisabled: boolean;

  // --- Streaming indicator ---
  chatStreamingIndicatorText: string;
  chatStreamingActive: boolean;
  chatThinkingElapsedMs: number;
  chatWaitingForStream: boolean;

  // --- Router input value (for plugin setup + chat) ---
  connectRouterValue: string;
  dashboardPortValue: string;
};

const MAX_LOGS = 2000;

export function createInitialUiState(): RendererUiState {
  return {
    // Process / runtime
    processes: [],
    refreshing: false,
    dashboardRunning: false,
    daemonState: null,

    // Runtime display
    connectState: '',
    connectBadge: { tone: 'idle', label: 'Stopped' },
    dashboardState: '',
    dashboardBadge: { tone: 'idle', label: 'Stopped' },
    connectWarning: null,
    runtimeActivity: { tone: 'idle', message: 'Idle' },

    // Logs
    logs: [],

    // Overview
    overviewBadge: { tone: 'idle', label: 'Idle' },
    ovNodeState: 'idle',
    ovPeers: '0',
    ovDhtHealth: 'Down',
    ovUptime: '-',
    ovPeersCount: '0',
    overviewPeers: [],

    // Peers
    peersMeta: { tone: 'idle', label: '0 peers' },
    peersMessage: 'Loading peer visibility...',
    lastPeers: [],
    peerSort: { key: 'reputation', dir: 'desc' },
    peerFilter: '',
    lastDebugKey: '',

    // Connection
    connectionMeta: { tone: 'idle', label: 'No data' },
    connectionStatus: 'No status data.',
    connectionNetwork: 'No network stats.',
    connectionSources: 'No data source info.',
    connectionNotes: 'No notes.',
    overviewDataSources: '',

    // Config
    configMeta: { tone: 'idle', label: 'Redacted' },
    configMessage: null,
    configFormData: null,
    configSaving: false,

    // Plugin setup
    installedPlugins: new Set<string>(),
    pluginHints: { router: null },
    pluginInstallBusy: false,
    pluginSetupStatus: '',
    pluginInstallBtnLabel: 'Install',
    pluginInstallBtnDisabled: true,
    pluginRefreshBtnDisabled: true,

    // Chat
    chatActiveConversation: null,
    chatConversationTitle: 'Conversation',
    chatConversations: [],
    chatMessages: [],
    chatSending: false,
    chatError: null,
    chatThreadMeta: 'No conversation selected',
    chatRoutedPeer: '',
    chatModelOptions: [],
    chatSelectedModelValue: '',
    chatModelStatus: { tone: 'idle', label: 'Models idle' },
    chatProxyStatus: { tone: 'idle', label: 'Proxy offline' },
    chatDeleteVisible: false,
    chatInputDisabled: true,
    chatSendDisabled: true,
    chatAbortVisible: false,
    chatModelSelectDisabled: false,

    // Streaming indicator
    chatStreamingIndicatorText: '',
    chatStreamingActive: false,
    chatThinkingElapsedMs: 0,
    chatWaitingForStream: false,

    // Router / dashboard port
    connectRouterValue: 'local',
    dashboardPortValue: '3117',
  };
}

export function appendLogEntry(state: RendererUiState, entry: LogEvent): void {
  state.logs = [...state.logs.slice(-(MAX_LOGS - 1)), entry];
}

export function replaceLogEntries(state: RendererUiState, entries: LogEvent[]): void {
  state.logs = entries.slice(-MAX_LOGS);
}

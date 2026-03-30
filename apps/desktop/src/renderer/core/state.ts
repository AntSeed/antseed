import type { DaemonStateSnapshot, LogEvent, RuntimeProcessState } from '../types/bridge';
import type { ChatMessage } from '../ui/components/chat/chat-shared';

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
  displayName: string | null;
  host: string;
  port: number;
  providers: string[];
  services: string[];
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
  maxInputUsdPerMillion: number;
  maxOutputUsdPerMillion: number;
  minRep: number;
  paymentMethod: string;
  requireManualApproval: boolean;
  devMode: boolean;
  cryptoChainId: string;
  cryptoRpcUrl: string;
  cryptoDepositsAddress: string;
  cryptoChannelsAddress: string;
  cryptoUsdcAddress: string;
};

export type ChatServiceOptionEntry = {
  id: string;
  label: string;
  provider: string;
  protocol: string;
  count: number;
  value: string;
  peerId: string;
  peerLabel: string;
};

export type ActiveChannelInfo = {
  reservedUsdc: string;
  peerName: string;
};

export type RendererUiState = {
  // --- Process / runtime state ---
  processes: RuntimeProcessState[];
  refreshing: boolean;
  daemonState: DaemonStateSnapshot | null;

  // --- Runtime display ---
  connectState: string;
  connectBadge: BadgeState;
  connectWarning: string | null;
  runtimeActivity: { tone: BadgeTone; message: string };

  // --- Logs ---
  logs: LogEvent[];

  // --- Overview display ---
  overviewBadge: BadgeState;
  ovNodeState: string;
  ovPeers: string;
  ovDhtHealth: string;
  ovProxyPort: string;
  ovServiceCount: string;
  ovLastScan: string;
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
  devMode: boolean;

  // --- Plugin setup ---
  installedPlugins: Set<string>;
  pluginHints: PluginHints;
  pluginInstallBusy: boolean;
  pluginSetupStatus: string;
  pluginInstallBtnLabel: string;
  pluginInstallBtnDisabled: boolean;
  pluginRefreshBtnDisabled: boolean;

  // --- Credits / Payments ---
  creditsAvailableUsdc: string;
  creditsReservedUsdc: string;
  creditsTotalUsdc: string;
  creditsPendingWithdrawalUsdc: string;
  creditsCreditLimitUsdc: string;
  creditsEvmAddress: string | null;
  creditsOperatorAddress: string | null;
  creditsLoading: boolean;
  creditsLastRefreshedAt: number;

  // --- Session approval ---
  chatPaymentApprovalVisible: boolean;
  chatPaymentApprovalPeerId: string | null;
  chatPaymentApprovalPeerName: string | null;
  chatPaymentApprovalAmount: string;
  chatPaymentApprovalPeerInfo: {
    reputation: number;
    sessionCount: number | null;
    disputeCount: number | null;
    networkAgeDays: number | null;
    evmAddress: string | null;
  } | null;
  chatPaymentApprovalLoading: boolean;
  chatPaymentApprovalError: string | null;
  chatLowBalanceWarning: boolean;

  // --- Active payment channels (keyed by peerId) ---
  chatActiveChannels: Map<string, ActiveChannelInfo>;

  // --- Chat display ---
  chatActiveConversation: string | null;
  chatConversationTitle: string;
  chatConversations: unknown[];
  chatConversationsLoaded: boolean;
  chatProxyPort: number;
  chatMessages: unknown[];
  chatStreamingMessage: ChatMessage | null;
  chatSending: boolean;
  chatSendingConversationId: string | null;
  chatError: string | null;
  chatThreadMeta: string;
  chatRoutedPeer: string;
  chatServiceOptions: ChatServiceOptionEntry[];
  chatSelectedServiceValue: string;
  chatSelectedPeerId: string;
  chatServiceStatus: BadgeState;
  chatProxyStatus: BadgeState;
  chatDeleteVisible: boolean;
  chatInputDisabled: boolean;
  chatSendDisabled: boolean;
  chatAbortVisible: boolean;
  chatServiceSelectDisabled: boolean;

  // --- Streaming indicator ---
  chatStreamingIndicatorText: string;
  chatStreamingActive: boolean;
  chatThinkingElapsedMs: number;
  chatWaitingForStream: boolean;

  // --- Router input value (for plugin setup + chat) ---
  connectRouterValue: string;
  dashboardPortValue: string;

  // --- First-run setup ---
  appSetupStatusKnown: boolean;
  appSetupNeeded: boolean;
  appSetupComplete: boolean;
  appSetupStep: string;
};

const MAX_LOGS = 2000;

export function createInitialUiState(): RendererUiState {
  return {
    // Process / runtime
    processes: [],
    refreshing: false,
    daemonState: null,

    // Runtime display
    connectState: '',
    connectBadge: { tone: 'idle', label: 'Stopped' },
    connectWarning: null,
    runtimeActivity: { tone: 'idle', message: 'Idle' },

    // Logs
    logs: [],

    // Overview
    overviewBadge: { tone: 'idle', label: 'Idle' },
    ovNodeState: 'idle',
    ovPeers: '0',
    ovDhtHealth: 'Down',
    ovProxyPort: '-',
    ovServiceCount: '0',
    ovLastScan: 'n/a',
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
    devMode: false,

    // Plugin setup
    installedPlugins: new Set<string>(),
    pluginHints: { router: null },
    pluginInstallBusy: false,
    pluginSetupStatus: '',
    pluginInstallBtnLabel: 'Install',
    pluginInstallBtnDisabled: true,
    pluginRefreshBtnDisabled: true,

    // Credits / Payments
    creditsAvailableUsdc: '0',
    creditsReservedUsdc: '0',
    creditsTotalUsdc: '0',
    creditsPendingWithdrawalUsdc: '0',
    creditsCreditLimitUsdc: '0',
    creditsEvmAddress: null,
    creditsOperatorAddress: null,
    creditsLoading: false,
    creditsLastRefreshedAt: 0,

    // Session approval
    chatPaymentApprovalVisible: false,
    chatPaymentApprovalPeerId: null,
    chatPaymentApprovalPeerName: null,
    chatPaymentApprovalAmount: '1.00',
    chatPaymentApprovalPeerInfo: null,
    chatPaymentApprovalLoading: false,
    chatPaymentApprovalError: null,
    chatLowBalanceWarning: false,

    // Active payment channels
    chatActiveChannels: new Map(),

    // Chat
    chatActiveConversation: null,
    chatConversationTitle: 'Conversation',
    chatConversations: [],
    chatConversationsLoaded: false,
    chatProxyPort: 0,
    chatMessages: [],
    chatStreamingMessage: null,
    chatSending: false,
    chatSendingConversationId: null,
    chatError: null,
    chatThreadMeta: 'No conversation selected',
    chatRoutedPeer: '',
    chatServiceOptions: [],
    chatSelectedServiceValue: '',
    chatSelectedPeerId: '',
    chatServiceStatus: { tone: 'idle', label: 'Services idle' },
    chatProxyStatus: { tone: 'idle', label: 'Proxy offline' },
    chatDeleteVisible: false,
    chatInputDisabled: false,
    chatSendDisabled: false,
    chatAbortVisible: false,
    chatServiceSelectDisabled: false,

    // Streaming indicator
    chatStreamingIndicatorText: '',
    chatStreamingActive: false,
    chatThinkingElapsedMs: 0,
    chatWaitingForStream: false,

    // Router / dashboard port
    connectRouterValue: 'local',
    dashboardPortValue: '3117',

    // First-run setup
    appSetupStatusKnown: false,
    appSetupNeeded: false,
    appSetupComplete: false,
    appSetupStep: '',
  };
}

export function appendLogEntry(state: RendererUiState, entry: LogEvent): void {
  state.logs = [...state.logs.slice(-(MAX_LOGS - 1)), entry];
}

export function replaceLogEntries(state: RendererUiState, entries: LogEvent[]): void {
  state.logs = entries.slice(-MAX_LOGS);
}

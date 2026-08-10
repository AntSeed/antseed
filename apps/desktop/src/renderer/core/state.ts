import type {
  DaemonStateSnapshot,
  DesktopBuyerUsageTotals,
  DesktopPaymentChannelSummary,
  DesktopRewardsSummary,
  LogEvent,
  RuntimeProcessState,
} from '../types/bridge';
import type { ChatMessage } from '../ui/components/chat/chat-shared';
import type { ChatPermissionMode, ToolApprovalRequest } from '../types/bridge';

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
  onChainReputationScore: number | null;
  lastSeen: number;
  lastReachedAt: number | null;
  source: string;
  online: boolean;
};

export type ConfigFormData = {
  proxyPort: number;
  peerRefreshIntervalMs: number;
  maxInputUsdPerMillion: number;
  maxOutputUsdPerMillion: number;
  minRep: number;
  disableMetadataV2Services: boolean;
  paymentMethod: string;
  devMode: boolean;
  cryptoChainId: string;
};

export type ChatServiceOptionEntry = {
  id: string;
  label: string;
  provider: string;
  protocol: string;
  count: number;
  value: string;
  peerId: string;
  peerDisplayName: string | null;
  peerLabel: string;
  peerIconUrl: string | null;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cachedInputUsdPerMillion?: number | null;
  categories: string[];
  description: string;
};

export type VprRouteMode = 'auto' | 'pinned-peer';

export type VprSelectedModel = {
  provider: string;
  serviceId: string;
  label: string;
  categories: string[];
};

export type VprRouteSelection = {
  model: VprSelectedModel | null;
  mode: VprRouteMode;
  peerId: string | null;
};

export type VprRoutingPreferences = {
  autoRouting: boolean;
  preferFreePeers: boolean;
  maxInputUsdPerMillion: number;
  minTrustScore: number;
  /**
   * Peer allowlist. While non-empty, auto routing only ever considers these
   * peers — every other seller is dropped before scoring.
   */
  allowedPeerIds: string[];
  /** Peers auto routing never selects. Takes precedence over the allowlist. */
  blockedPeerIds: string[];
};

/** Which routing list a peer sits on. A peer is never on both. */
export type VprPeerListing = 'allowed' | 'blocked' | 'none';

export type VprModelCatalogEntry = {
  provider: string;
  serviceId: string;
  label: string;
  peerCount: number;
  categories: string[];
  minInputUsdPerMillion: number | null;
  maxInputUsdPerMillion: number | null;
  minOutputUsdPerMillion: number | null;
  maxOutputUsdPerMillion: number | null;
  minCachedInputUsdPerMillion: number | null;
  maxCachedInputUsdPerMillion: number | null;
  expectedSavingsPct: number | null;
  bestPeerId: string | null;
  /**
   * Reference/retail price for the equivalent model on the OpenRouter catalog,
   * in USD per million tokens. Used to calculate the discount shown on the
   * Home model list. `null`/absent when no OpenRouter match is found.
   */
  baselineInputUsdPerMillion?: number | null;
  baselineOutputUsdPerMillion?: number | null;
};

export type DiscoverVerificationLink = {
  kind: 'domain' | 'github';
  label: string;
  href: string;
  title?: string;
  description?: string;
  faviconUrl?: string;
};

export type DiscoverRow = {
  // Identity
  rowKey: string;              // `${peerId}:${serviceId}`
  serviceId: string;
  serviceLabel: string;
  categories: string[];
  provider: string;            // internal, not shown
  protocol: string;

  // Peer
  peerId: string;
  peerEvmAddress: string;
  /**
   * On-chain seller contract published by the peer via SellerDelegation
   * (peer metadata codec v8+). When set, this is the address that actually
   * receives channel settlements — distinct from `peerEvmAddress` which is
   * derived from the peerId. The renderer uses this to identify known
   * staking-proxy peers (e.g. the DIEM staking pool) and surface a small
   * identification badge on the Discover card. See docs/protocol/diem-proxy.md.
   */
  sellerContract: string | null;
  verificationLinks: DiscoverVerificationLink[];
  peerIconUrl: string | null;
  peerDisplayName: string | null;
  peerLabel: string;

  // Pricing
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;

  // Local buyer history (from ChannelStore)
  lifetimeSessions: number;
  lifetimeRequests: number;
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeFirstSessionAt: number | null;
  lifetimeLastSessionAt: number | null;

  // Peer metadata
  onChainChannelCount: number | null;

  // On-chain staking (AntseedStaking)
  agentId: number;
  stakeUsdc: string;            // bigint as string, 6-decimal USDC

  // On-chain agent stats (AntseedChannels.getAgentStats)
  onChainActiveChannelCount: number;
  onChainGhostCount: number;
  onChainTotalVolumeUsdc: string;
  onChainLastSettledAt: number;
  onChainReputationScore: number | null; // displayed 0-100 score
  onChainTrustScore: number | null;
  onChainSybilRisk: number | null;
  onChainSybilFlags: string[];

  /**
   * Network-wide totals from @antseed/network-stats, indexed from AntseedStats.MetadataRecorded.
   * Null when the chain has no stats contract (e.g. sepolia), the indexer hasn't seen events
   * for this agentId yet, or network-stats is unreachable. Stored as bigint-string because
   * token/request counts can exceed Number.MAX_SAFE_INTEGER on long-lived agents.
   */
  networkRequests: string | null;
  networkInputTokens: string | null;
  networkOutputTokens: string | null;

  // Derived — encoded selection for existing chat open path
  // Peer health (buyer-proxy cooldown). A peer that recently stopped
  // responding is deprioritized by auto routing until its cooldown lapses.
  peerCooldownUntil: number | null;
  peerFailureStreak: number;
  peerLastFailureReason: string | null;

  selectionValue: string;
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
  connectBadge: BadgeState;
  runtimeActivity: { tone: BadgeTone; message: string };

  // --- Logs ---
  logs: LogEvent[];

  // --- Network reachability alert ---
  /** 'blocked' = internet up but DHT unreachable (firewall/VPN dropping UDP);
      'no-peers' = on the DHT but discovery sweeps keep coming back empty. */
  networkAlert: 'none' | 'no-internet' | 'blocked' | 'no-peers';

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
  peersMessage: string;
  lastPeers: PeerEntry[];
  peerSort: SortState;
  lastDebugKey: string;

  // --- Connection display ---
  connectionMeta: BadgeState;
  connectionStatus: string;
  connectionNetwork: string;
  connectionSources: string;
  connectionNotes: string;

  // --- Config display ---
  configMessage: { text: string; type: 'success' | 'error' | 'info' } | null;
  configFormData: ConfigFormData | null;
  configSaving: boolean;
  devMode: boolean;

  // --- Plugin setup ---
  installedPlugins: Set<string>;
  pluginHints: PluginHints;
  pluginInstallBusy: boolean;

  // --- Credits / Payments ---
  /** Unreserved deposits — what a new channel reserve or a withdrawal draws on.
      Payment gating reads this; the headline balance does not. */
  creditsAvailableUsdc: string;
  creditsReservedUsdc: string;
  /** Everything on deposit (available + reserved). */
  creditsTotalUsdc: string;
  /** Signed but not yet settled on-chain — spent in every sense but the ledger's. */
  creditsPendingUsdc: string;
  /** Deposits minus pending spend; used for spending and low-funds decisions. */
  creditsSpendableUsdc: string;
  /** USDC waiting in the buyer wallet before it can be swept into deposits. */
  creditsWalletUsdc: string;
  /** Spendable deposits plus wallet USDC. Used by balance headlines. */
  creditsTotalOwnedUsdc: string;
  creditsCreditLimitUsdc: string;
  creditsEvmAddress: string | null;
  creditsOperatorAddress: string | null;
  creditsBuyerUsage: DesktopBuyerUsageTotals | null;
  creditsChannels: DesktopPaymentChannelSummary[];
  creditsRewards: DesktopRewardsSummary | null;
  creditsSummaryLoading: boolean;

  // --- Agent access / tool approval ---
  chatPermissionMode: ChatPermissionMode;
  chatToolApprovalRequests: ToolApprovalRequest[];
  chatToolApprovalRequest: ToolApprovalRequest | null;

  // --- Session approval ---
  chatPaymentApprovalVisible: boolean;
  chatPaymentApprovalPeerName: string | null;
  chatPaymentApprovalAmount: string;
  chatPaymentApprovalPeerInfo: {
    reputation: number;
    channelCount: number | null;
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
  chatOpeningConversationId: string | null;
  chatConversations: unknown[];
  chatConversationsLoaded: boolean;
  chatProxyPort: number;
  /** Chat opens thin (compact window, no conversation list). The header
      toggle expands the window to the standard preset and shows the panel. */
  chatPanelExpanded: boolean;
  chatMessages: unknown[];
  chatStreamingMessage: ChatMessage | null;
  chatSending: boolean;
  chatSendingConversationId: string | null;
  /** IDs of all conversations currently running a request, across the whole app. */
  chatSendingConversationIds: string[];
  chatError: string | null;
  /**
   * Non-error routing notice, e.g. "peer X isn't responding, retrying on Y".
   * Kept separate from `chatError` because a successful failover is not a
   * failure and must not be rendered as one.
   */
  chatRoutingNotice: string | null;
  chatRoutedPeer: string;
  chatRoutedPeerId: string;
  chatSessionStarted: string;
  chatSessionReservedUsdc: string;
  chatSessionAccumulatedCostUsd: string;
  chatSessionTotalTokens: string;
  chatLifetimeSpentUsdc: string;
  chatLifetimeTotalTokens: string;
  chatLifetimeSessions: string;
  chatServiceOptions: ChatServiceOptionEntry[];
  discoverRows: DiscoverRow[];
  /**
   * `discoverRows` minus every seller the peer allow/block rules exclude.
   * Every browse and routing surface reads this; `discoverRows` stays complete
   * so the Manage-sellers modal can still list the peers being excluded.
   */
  vprRoutableRows: DiscoverRow[];
  vprModelCatalog: VprModelCatalogEntry[];
  vprRouteSelection: VprRouteSelection;
  /** Remembered seller pin per model (`provider:serviceId` -> peer id), so a
   * pinned model stays pinned across model switches. */
  vprModelPins: Record<string, string>;
  vprRoutingPreferences: VprRoutingPreferences;
  /** Whether the detachable always-on-top pill window is currently open. */
  vprFloatOpen: boolean;
  /** Opt-in: pop the pill open on its own when routed traffic starts. */
  vprFloatAutoOpen: boolean;
  /** Debug aid: the pill's chat rows name the routed seller next to the model. */
  vprFloatShowRoutedPeer: boolean;
  chatDiscoverRowsLoaded: boolean;
  chatSelectedServiceValue: string;
  chatSelectedPeerId: string;
  chatInputDisabled: boolean;
  chatSendDisabled: boolean;
  chatAbortVisible: boolean;
  chatServiceSelectDisabled: boolean;

  // --- Browser preview ---
  browserPreviewUrl: string | null;
  browserPreviewRequestId: number;
  chatWorkspacePath: string;
  chatWorkspaceDefaultPath: string;

  // --- Streaming indicator ---
  chatThinkingElapsedMs: number;
  chatWaitingForStream: boolean;
  chatThinkingPhase: string | null;

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
    connectBadge: { tone: 'idle', label: 'Stopped' },
    runtimeActivity: { tone: 'idle', message: 'Idle' },

    // Logs
    logs: [],

    // Network reachability alert
    networkAlert: 'none',

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
    peersMessage: 'Loading peer visibility...',
    lastPeers: [],
    peerSort: { key: 'reputation', dir: 'desc' },
    lastDebugKey: '',

    // Connection
    connectionMeta: { tone: 'idle', label: 'No data' },
    connectionStatus: 'No status data.',
    connectionNetwork: 'No network stats.',
    connectionSources: 'No data source info.',
    connectionNotes: 'No notes.',

    // Config
    configMessage: null,
    configFormData: null,
    configSaving: false,
    devMode: false,

    // Plugin setup
    installedPlugins: new Set<string>(),
    pluginHints: { router: null },
    pluginInstallBusy: false,

    // Credits / Payments
    creditsAvailableUsdc: '0',
    creditsReservedUsdc: '0',
    creditsTotalUsdc: '0',
    creditsPendingUsdc: '0',
    creditsSpendableUsdc: '0',
    creditsWalletUsdc: '0',
    creditsTotalOwnedUsdc: '0',
    creditsCreditLimitUsdc: '0',
    creditsEvmAddress: null,
    creditsOperatorAddress: null,
    creditsBuyerUsage: null,
    creditsChannels: [],
    creditsRewards: null,
    creditsSummaryLoading: false,

    // Agent access / tool approval
    chatPermissionMode: 'manual',
    chatToolApprovalRequests: [],
    chatToolApprovalRequest: null,

    // Session approval
    chatPaymentApprovalVisible: false,
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
    chatOpeningConversationId: null,
    chatConversations: [],
    chatConversationsLoaded: false,
    chatProxyPort: 0,
    chatPanelExpanded: false,
    chatMessages: [],
    chatStreamingMessage: null,
    chatSending: false,
    chatSendingConversationId: null,
    chatSendingConversationIds: [],
    chatError: null,
    chatRoutingNotice: null,
    chatRoutedPeer: '',
    chatRoutedPeerId: '',
    chatSessionStarted: '',
    chatSessionReservedUsdc: '',
    chatSessionAccumulatedCostUsd: '',
    chatSessionTotalTokens: '',
    chatLifetimeSpentUsdc: '',
    chatLifetimeTotalTokens: '',
    chatLifetimeSessions: '',
    chatServiceOptions: [],
    discoverRows: [],
    vprRoutableRows: [],
    vprModelCatalog: [],
    vprRouteSelection: {
      model: null,
      mode: 'auto',
      peerId: null,
    },
    vprModelPins: {},
    vprRoutingPreferences: {
      autoRouting: true,
      preferFreePeers: false,
      maxInputUsdPerMillion: 25,
      minTrustScore: 0,
      allowedPeerIds: [],
      blockedPeerIds: [],
    },
    vprFloatOpen: false,
    vprFloatAutoOpen: false,
    vprFloatShowRoutedPeer: false,
    chatDiscoverRowsLoaded: false,
    chatSelectedServiceValue: '',
    chatSelectedPeerId: '',
    chatInputDisabled: false,
    chatSendDisabled: false,
    chatAbortVisible: false,
    chatServiceSelectDisabled: false,

    // Browser preview
    browserPreviewUrl: null,
    browserPreviewRequestId: 0,
    chatWorkspacePath: '',
    chatWorkspaceDefaultPath: '',

    // Streaming indicator
    chatThinkingElapsedMs: 0,
    chatWaitingForStream: false,
    chatThinkingPhase: null,

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

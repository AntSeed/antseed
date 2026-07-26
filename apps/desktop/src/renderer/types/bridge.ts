export type RuntimeMode = 'connect' | 'system-proxy';

export type RuntimeProcessState = {
  mode: RuntimeMode;
  running: boolean;
  pid?: number | null;
  startedAt?: number | null;
  lastExitCode?: number | null;
  lastError?: string | null;
  [key: string]: unknown;
};

/** One installed application ("Open with" picker): display name plus the
    launchable path (.app bundle on macOS, Start Menu .lnk on Windows) and
    the OS-provided icon when one could be extracted. */
export type InstalledAppEntry = { name: string; path: string; iconDataUri?: string };

export type SystemProxyProfileSummary = {
  name: string;
  displayName: string;
  kind: 'proxy' | 'config-patch';
  method: string;
  domains: string[];
  appAction?: 'none' | 'open-url' | 'open-tool' | 'restart-app';
  openUrl?: string;
  toolName?: string;
  canRestart?: boolean;
  /** True for user-added custom apps (removable, favicon-based icon). */
  custom?: boolean;
  iconDataUri?: string;
  /** Installed application the user picked as this profile's "Open with"
      target — wins over the packaged open action when launching. */
  launchAppName?: string;
  /** Client names identifying this app's requests on the wire (User-Agent
      product / session-header slugs, e.g. 'opencode', 'tool-cli') — used
      to attribute conversations to the app. User-editable per app. */
  toolSlugs?: string[];
};

export type DesktopBuyerUsageTotals = {
  totalRequests: number;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalSettlements: number;
  uniqueSellers: number;
  activeChannels: number;
};

export type DesktopPaymentChannelSummary = {
  channelId: string;
  peerId: string;
  seller: string;
  reserveMax: string;
  cumulativeSigned: string;
  /** Already settled on-chain (bigint string). cumulativeSigned - settledUsdc
      is what the seller can still claim against this channel. */
  settledUsdc: string;
  reservedAt: number;
  status: string;
  requestCount: number;
  /** Cumulative input tokens delivered over this channel (bigint string). */
  inputTokens: string;
  /** Cumulative output tokens over this channel (bigint string). */
  outputTokens: string;
};

export type DesktopRewardsSummary = {
  available: boolean;
  pendingAnts: string;
  currentEpoch: number | null;
  transfersEnabled: boolean;
  error: string | null;
};

export type DepositWatchStatus = {
  phase: 'received' | 'sweeping' | 'credited' | 'error';
  /** USDC base units (6 decimals), bigint string. */
  amountBaseUnits?: string;
  txHash?: string;
  error?: string;
};

export type LogEvent = {
  mode: RuntimeMode | string;
  stream: 'stdout' | 'stderr' | 'system' | string;
  line: string;
  timestamp: number;
};

export type RuntimeActivityTone = 'active' | 'idle' | 'warn' | 'bad';

export type RuntimeActivityEvent = {
  mode: RuntimeMode | string;
  tone: RuntimeActivityTone;
  stage: string;
  message: string;
  holdMs: number;
  timestamp: number;
  requestId?: string;
  peerId?: string;
};

export type DaemonStateSnapshot = {
  exists: boolean;
  state: Record<string, unknown> | null;
};

export type RuntimeSnapshot = {
  processes: RuntimeProcessState[];
  daemonState: DaemonStateSnapshot;
  logs: LogEvent[];
};

export type DataEndpoint =
  | 'status'
  | 'network'
  | 'peers'
  | 'config'
  | 'data-sources';

export type DataResult<T = unknown> = {
  ok: boolean;
  data: T | null;
  error: string | null;
  status: number | null;
};

export type PluginInfo = {
  package: string;
  version: string;
};

export type PluginListResult = {
  ok: boolean;
  plugins: PluginInfo[];
  error: string | null;
};

export type PluginInstallResult = {
  ok: boolean;
  package: string;
  plugins: PluginInfo[];
  error: string | null;
};

export type UpdateStatus =
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'installing'; version: string | null }
  | { status: 'error'; version: string | null; message: string; details: string; hint?: string };

export type InstallUpdateResult =
  | { ok: true }
  | { ok: false; error: string; details: string; hint?: string };

export type ChatWorkspaceGitStatus = {
  available: boolean;
  rootPath: string | null;
  branch: string | null;
  isDetached: boolean;
  ahead: number;
  behind: number;
  stagedFiles: number;
  modifiedFiles: number;
  untrackedFiles: number;
  error: string | null;
};

// NOTE: Source of truth lives in apps/desktop/src/main/chat-stream-stop.ts
// (`ChatStreamStopReason`). The renderer cannot import from main, so the
// shape is mirrored here for IPC. Keep in sync with that file and with
// apps/desktop/src/main/preload.cts when fields change.
export type ChatAiStreamStopReason = {
  kind: 'payment_required' | 'aborted' | 'timeout' | 'http_error' | 'network_error' | 'stream_error' | 'unknown';
  source: 'billing' | 'user' | 'transport' | 'upstream' | 'unknown';
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: string;
};

export type RawChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  base64: string;
};

export type ChatPermissionMode = 'manual' | 'full';
export type ToolApprovalDecision = 'allow_once' | 'always_allow_peer' | 'deny';
export type ToolApprovalRequest = {
  id: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  permissionKey: string;
  permissionLabel: string;
  input: Record<string, unknown>;
  workspacePath: string;
  peerId: string | null;
  peerName: string | null;
  title: string;
  description: string;
  subject: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

export type PreparedChatAttachment = {
  id: string;
  /** Stable server-generated ID for the on-disk copy; used by the
   *  `antseed-attachment://` preview protocol. */
  attachmentId?: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'archive' | 'error';
  status: 'ready' | 'error';
  text?: string;
  image?: { type: 'image'; data: string; mimeType: string };
  error?: string;
  truncated?: boolean;
  native?: { provider?: string; payload?: unknown };
};

export type StartOptions = {
  mode: RuntimeMode;
  router?: string;
  dashboardPort?: number;
};

export type DesktopBridge = {
  /** `process.platform` from the preload (Node side). */
  platform?:
    | 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux'
    | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';
  /** Authoritative macOS UI locale (Electron `app.getLocale()`). */
  getSystemLocale?: () => Promise<string>;
  /** Current app version from Electron `app.getVersion()`. */
  getAppVersion?: () => Promise<string>;
  /**
   * OpenRouter reference/retail prices keyed by normalized model id/name
   * (USD per million tokens). Used to render the struck-through baseline on
   * the VPR Home "Popular" list. Empty map when OpenRouter is unreachable.
   */
  getOpenRouterReferencePrices?: () => Promise<
    Record<string, { input: number | null; output: number | null }>
  >;
  getState?: () => Promise<RuntimeSnapshot>;
  start?: (options: StartOptions) => Promise<unknown>;
  stop?: (mode: RuntimeMode) => Promise<unknown>;
  openDashboard?: (port?: number) => Promise<{ ok: true }>;
  clearLogs?: () => Promise<{ ok: true }>;

  pluginsList?: () => Promise<PluginListResult>;
  pluginsInstall?: (packageName: string) => Promise<PluginInstallResult>;

  getNetwork?: (port?: number) => Promise<{ ok: boolean; peers?: unknown[]; error?: string | null; [key: string]: unknown }>;
  getData?: (
    endpoint: DataEndpoint,
    options?: { port?: number; query?: Record<string, string | number | boolean> }
  ) => Promise<DataResult>;
  updateConfig?: (
    config: Record<string, unknown>,
  ) => Promise<DataResult>;
  scanNetwork?: () => Promise<DataResult>;

  onLog?: (handler: (event: LogEvent) => void) => () => void;
  onState?: (handler: (states: RuntimeProcessState[]) => void) => () => void;
  onRuntimeActivity?: (handler: (event: RuntimeActivityEvent) => void) => () => void;
  onPeersChanged?: (handler: () => void) => () => void;

  chatAiListConversations?: () => Promise<{ ok: boolean; data: unknown[] }>;
  chatAiListDiscoverRows?: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
  chatAiGetConversation?: (id: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  chatAiCreateConversation?: (service: string, provider?: string, peerId?: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  chatAiDeleteConversation?: (id: string) => Promise<{ ok: boolean }>;
  chatAiRenameConversation?: (id: string, title: string) => Promise<{ ok: boolean; error?: string }>;
  chatPrepareAttachments?: (conversationId: string, attachments: RawChatAttachment[]) => Promise<{ ok: boolean; data?: PreparedChatAttachment[]; error?: string }>;
  attachmentDownload?: (conversationId: string, attachmentId: string, suggestedName: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  chatAiSend?: (conversationId: string, message: string, service?: string, provider?: string, attachments?: PreparedChatAttachment[], peerId?: string, permissionMode?: ChatPermissionMode) => Promise<{ ok: boolean; error?: string }>;
  chatAiSendStream?: (conversationId: string, message: string, service?: string, provider?: string, attachments?: PreparedChatAttachment[], peerId?: string, permissionMode?: ChatPermissionMode) => Promise<{ ok: boolean; error?: string; stopReason?: ChatAiStreamStopReason }>;
  chatPeerPermissionModeGet?: (peerId: string) => Promise<{ ok: boolean; mode?: ChatPermissionMode; error?: string }>;
  chatPeerPermissionModeSet?: (peerId: string, mode: ChatPermissionMode) => Promise<{ ok: boolean; mode?: ChatPermissionMode; error?: string }>;
  chatToolApprovalDecision?: (id: string, decision: ToolApprovalDecision) => Promise<{ ok: boolean; error?: string }>;
  chatAiAbort?: (conversationId?: string) => Promise<{ ok: boolean }>;
  chatAiSelectPeer?: (payload: { conversationId?: string | null; peerId?: string | null; service?: string | null; provider?: string | null }) => Promise<{ ok: boolean; error?: string }>;
  chatAiGetProxyStatus?: () => Promise<{ ok: boolean; data: { running: boolean; port: number } }>;
  apiTryProxyRequest?: (params: {
    port: number;
    path: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }) => Promise<{ ok: boolean; status: number; body: string; error: string | null }>;
  chatAiGetWorkspace?: () => Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }>;
  chatAiGetWorkspaceGitStatus?: () => Promise<{ ok: boolean; data?: ChatWorkspaceGitStatus; error?: string }>;
  chatAiSetWorkspace?: (workspacePath: string) => Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }>;
  pickDirectory?: () => Promise<{ ok: boolean; path: string | null }>;
  openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  openTool?: (toolName: string) => Promise<{ ok: boolean; error?: string; fallback?: string }>;
  /** Reopen a tool chat session: 'terminal' runs the tool's resume command
      (`codex resume <id>`, ...); 'app' launches the tool's desktop app. */
  openToolSession?: (tool: string, sessionKey: string, target?: 'terminal' | 'app') => Promise<{ ok: boolean; command?: string; error?: string }>;
  applyWindowView?: (viewName: string) => Promise<{ ok: true; skipped?: string }>;
  applyWindowPreset?: (presetName: string) => Promise<{ ok: true; skipped?: string }>;
  onNavigateView?: (handler: (viewName: string) => void) => () => void;
  voiceTranscribe?: (audio: ArrayBuffer) => Promise<{ ok: boolean; text?: string; error?: string }>;
  voiceGetStatus?: () => Promise<unknown>;
  voiceSetModel?: (modelId: string) => Promise<unknown>;
  voiceInstallModel?: (modelId: string) => Promise<unknown>;
  onChatAiDone?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> } }) => void) => () => void;
  onChatAiError?: (handler: (data: { conversationId: string; error: string }) => void) => () => void;
  onChatAiUserPersisted?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => void) => () => void;
  onChatConversationTitleUpdated?: (handler: (data: { conversationId: string; title: string }) => void) => () => void;
  onChatAiStreamStart?: (handler: (data: { conversationId: string; turn: number }) => void) => () => void;
  onChatAiStreamDelta?: (handler: (data: { conversationId: string; index: number; blockType: string; text: string }) => void) => () => void;
  onChatAiStreamBlockStart?: (handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string }) => void) => () => void;
  onChatAiStreamBlockStop?: (handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => void) => () => void;
  onChatAiStreamDone?: (handler: (data: { conversationId: string }) => void) => () => void;
  onChatAiStreamError?: (handler: (data: { conversationId: string; error: string; stopReason?: ChatAiStreamStopReason }) => void) => () => void;
  onChatAiToolExecuting?: (handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown> }) => void) => () => void;
  onChatAiToolUpdate?: (handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown>; output: string; details?: Record<string, unknown> }) => void) => () => void;
  onChatAiToolResult?: (handler: (data: { conversationId: string; toolUseId: string; output: string; isError: boolean; details?: Record<string, unknown> }) => void) => () => void;
  onChatToolApprovalRequested?: (handler: (data: ToolApprovalRequest) => void) => () => void;
  onChatToolApprovalCleared?: (handler: (data: { id: string; conversationId: string }) => void) => () => void;
  onBrowserPreviewOpen?: (handler: (data: { url: string }) => void) => () => void;
  sendBrowserPreviewElementSelected?: (data: { selector: string; tagName: string; text: string; attributes: Record<string, string> }) => void;
  onFullscreenChange?: (handler: (isFullscreen: boolean) => void) => () => void;
  onWindowFocusChange?: (handler: (isFocused: boolean) => void) => () => void;
  getAppSetupStatus?: () => Promise<{ needed: boolean; complete: boolean }>;
  onAppSetupStep?: (handler: (data: { step: string; label: string }) => void) => () => void;
  onAppSetupComplete?: (handler: () => void) => () => void;
  onUpdateStatus?: (handler: (data: UpdateStatus) => void) => () => void;
  installUpdate?: () => Promise<InstallUpdateResult>;
  setDebugLogs?: (enabled: boolean) => Promise<{ ok: true }>;
  creditsGetInfo?: () => Promise<{ ok: boolean; data: { evmAddress: string | null; operatorAddress: string | null; balanceUsdc: string; reservedUsdc: string; availableUsdc: string; pendingUsdc: string; spendableUsdc: string; creditLimitUsdc: string } | null; error: string | null }>;
  /** Prompts a native save dialog and writes the signer private key to the chosen file. */
  identityExportKey?: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string | null }>;
  /** Replaces the signer private key (the current one is backed up on disk first). */
  identityImportKey?: (privateKeyHex: string) => Promise<{ ok: boolean; address?: string; backupPath?: string | null; error?: string }>;

  paymentsSignSpendingAuth?: (params: {
    channelId: string;
    cumulativeAmountBaseUnits: string;
    metadataHash: string;
  }) => Promise<{ ok: boolean; data?: { spendingAuthSig: string; buyerEvmAddress: string }; error?: string }>;

  paymentsGetPeerInfo?: (peerId: string) => Promise<{
    ok: boolean;
    data?: {
      peerId: string;
      displayName: string | null;
      reputation: number;
      onChainChannelCount: number | null;
      onChainGhostCount: number | null;
      evmAddress: string | null;
      timestamp: number | null;
      providers: string[];
      services: string[];
    };
    error?: string;
  }>;

  paymentsOpenPayPage?: (opts: { kind?: 'deposit' | 'withdraw' | 'authorize' | 'claim' | 'diem' | 'close-channel'; amountUsdc?: string; channelId?: string }) => Promise<{ ok: boolean; url?: string; error?: string }>;
  paymentsCardProviders?: () => Promise<{ ok: boolean; data?: Array<{ id: string; label: string }>; error?: string }>;
  paymentsOpenCardProvider?: (opts?: { providerId?: string; amountUsdc?: string }) => Promise<{ ok: boolean; url?: string; error?: string }>;
  paymentsCrossmintConfig?: () => Promise<{ ok: boolean; data?: { clientKey: string; apiBase: string } | null; error?: string }>;
  paymentsGetBuyerUsage?: () => Promise<{ ok: boolean; data: DesktopBuyerUsageTotals | null; error: string | null; lastActivityAt?: number | null }>;
  paymentsGetChannels?: () => Promise<{ ok: boolean; data: DesktopPaymentChannelSummary[]; error: string | null }>;
  paymentsGetRewardsSummary?: () => Promise<{ ok: boolean; data: DesktopRewardsSummary | null; error: string | null }>;
  /** Fired when a browser pay page reports a completed payment action. */
  onPaymentsCompleted?: (handler: () => void) => () => void;
  depositsWatchStart?: () => Promise<{ ok: boolean; data?: { address: string; walletUsdcBaseUnits: string; usdcAddress: string; chainId: number }; error?: string }>;
  depositsWatchStop?: () => Promise<{ ok: boolean }>;
  onDepositsWatchStatus?: (handler: (data: DepositWatchStatus) => void) => () => void;

  systemProxyStart?: (opts: { peerId: string; port?: number; profiles?: string[]; defaultModel?: string; servedModels?: string[]; toolRoutes?: Record<string, { peerId: string; model: string }>; profileSwitch?: boolean }) => Promise<{ ok: boolean; state?: RuntimeProcessState; error?: string }>;
  systemProxyListProfiles?: () => Promise<SystemProxyProfileSummary[]>;
  /** Installed applications for the "Open with" picker (macOS .app bundles,
      Windows Start Menu shortcuts). */
  listInstalledApps?: () => Promise<{ ok: boolean; apps: InstalledAppEntry[]; error?: string }>;
  systemProxySetAppLaunch?: (opts: { name: string; app: InstalledAppEntry | null }) => Promise<{ ok: boolean; error?: string }>;
  /** Override the client names that attribute requests to an app profile;
      null resets to the profile's defaults. */
  systemProxySetAppIdentity?: (opts: { name: string; toolSlugs: string[] | null }) => Promise<{ ok: boolean; error?: string }>;
  systemProxyAddCustomApp?: (opts: { apiUrl: string; app?: { name: string; path: string } | null }) => Promise<{ ok: boolean; name?: string; error?: string }>;
  systemProxyRemoveCustomApp?: (name: string) => Promise<{ ok: boolean; error?: string }>;
  systemProxyStop?: () => Promise<{ ok: boolean; state?: RuntimeProcessState; error?: string }>;
  systemProxyGetState?: () => Promise<RuntimeProcessState | null>;
  systemProxyInstallCa?: () => Promise<{ ok: boolean; warning?: string; error?: string }>;
  systemProxyCaExists?: () => Promise<boolean>;
  systemProxyCaInfo?: () => Promise<{ path: string; exists: boolean }>;
  systemProxyRevealCa?: () => Promise<{ ok: boolean; error?: string }>;
  systemProxyCaTrustState?: () => Promise<{ ok: boolean; exists: boolean; trust: 'trusted' | 'stale' | 'absent' | 'unknown'; error?: string }>;
  systemProxyTestGui?: (opts?: { port?: number }) => Promise<{
    ok: boolean;
    proxyConfigured: boolean;
    proxyReachable: boolean;
    guiTrustOk: boolean;
    certTrustError: boolean;
    appRunning: boolean;
    needsAppRestart: boolean;
    appPid?: number;
    statusCode?: number;
    error?: string;
  }>;
  systemProxyRestartApp?: (app: string) => Promise<{ ok: boolean; error?: string }>;

  /* Floating always-on-top pill window */
  vprFloatSetExpanded?: (expanded: boolean) => void;
  /** null while the buyer is unreachable (e.g. still starting up). */
  buyerConversationsList?: () => Promise<BuyerConversationSummary[] | null>;
  buyerConversationsUpdate?: (opts: { id: string; label?: string | null; pinnedModel?: string; delete?: boolean }) => Promise<{ ok: boolean; conversation?: BuyerConversationSummary; error?: string }>;
  vprFloatOpen?: (data: VprFloatData) => Promise<{ ok: boolean }>;
  vprFloatClose?: () => Promise<{ ok: boolean }>;
  vprFloatIsOpen?: () => Promise<boolean>;
  vprFloatGetCompact?: () => Promise<boolean>;
  vprFloatMoveBy?: (dx: number, dy: number) => void;
  vprFloatUpdate?: (data: VprFloatData) => void;
  vprFloatAction?: (action: VprFloatAction) => void;
  onVprFloatData?: (handler: (data: VprFloatData) => void) => () => void;
  onVprFloatCompact?: (handler: (compact: boolean) => void) => () => void;
  onVprFloatClosed?: (handler: () => void) => () => void;
  onVprFloatAction?: (handler: (action: unknown) => void) => () => void;
};

/** One tool chat session seen by the buyer proxy (per-chat routing). */
export type BuyerConversationSummary = {
  id: string;
  tool: string;
  sessionKey: string;
  snippet: string;
  label: string | null;
  /** Per-chat route pin as `<peerId>@<service>`. The buyer pins a chat to
      the first model that serves it, so this is null only until the chat's
      first resolved request; the default route applies to new chats only. */
  pinnedModel: string | null;
  /** Model that served the most recent request (`<peerId>@<service>`). */
  lastModel: string | null;
  /** USDC base units this chat has cost (bigint string), subagents included.
      Rows written before spend tracking shipped report '0'. */
  spentUsdc?: string;
  /** `cachedInputTokens` is the cached subset of `inputTokens`, not a separate
      bucket — fresh input is the difference between the two. */
  inputTokens?: string;
  cachedInputTokens?: string;
  outputTokens?: string;
  requestCount?: number;
  createdAt: number;
  lastActiveAt: number;
};

export type VprFloatApp = {
  name: string;
  displayName: string;
  /** Client names that attribute conversations to this app (see
      SystemProxyProfileSummary.toolSlugs). */
  toolSlugs?: string[];
  /** The associated application's real icon, same as the main window's app
      rows use; without one the pill falls back to a drawn brand mark. */
  iconDataUri?: string;
};

/** Full catalog entries flow to the pill so its model list renders exactly
    like the Home dropdown (brand icon, discounted price, badges). Type-only
    import — no runtime cycle with core/state. */
export type VprFloatModel = import('../core/state').VprModelCatalogEntry;

/** One chat row in the pill's chat dropdown. */
export type VprFloatConversation = {
  id: string;
  tool: string;
  /** Display name: user label, else prompt snippet, else the session key. */
  title: string;
  /** Compact session identifier for the meta line ("019f83b7"). */
  sessionShort: string;
  /** Service id of the pinned model, or null when following the default route. */
  pinnedServiceId: string | null;
  lastActiveAt: number;
  /** True while the chat is receiving traffic (recent request activity) —
      drives the green pulse on its row. */
  active: boolean;
  /** Formatted spend for this chat ("$0.42", "<$0.01"), or null when nothing
      has been attributed to it yet. */
  cost: string | null;
};

/** Display payload the main window pushes to the floating pill. */
export type VprFloatData = {
  /** Connected app profiles the pill's app dropdown can switch between. */
  apps: VprFloatApp[];
  /** Which app the pill should track (profile name). */
  selectedApp: string;
  /** Models available in the pill's model dropdown: the same curated list as
      the Home dropdown (favorites, then the recommended lineup). */
  models: VprFloatModel[];
  /** `provider:serviceId` keys of user-starred models — matching rows get a
      star, same as the Home dropdown. */
  favoriteKeys?: string[];
  selectedModel: { provider: string; serviceId: string } | null;
  /** Seller names for pinned models, keyed `provider:serviceId` — pins are per
      model, so a model keeps its seller while another one is selected. */
  pinnedSellers?: Record<string, string>;
  /** Recent tool chats, newest first (per-chat routing scope picker). */
  conversations: VprFloatConversation[];
  /** Usage line: buyer-wide total tokens ("1.2M tok"). */
  usageLabel: string;
  /** Current available balance ("$12.34") — remaining, not spent. */
  balanceLabel?: string;
  /** True when the balance is effectively empty but the selected default
      model is paid — the pill shows an "Add balance" shortcut. */
  needsFunds?: boolean;
  /** True while the buyer (connect) runtime is running. When false the pill
      shows a "Not connected" state and hides recent chats. */
  runtimeOn?: boolean;
  /** Shortened buyer identity (signer address), e.g. "0x1234...abcd". */
  identityLabel?: string;
  /**
   * True when traffic moved through the system proxy or the buyer proxy
   * since the previous payload — drives the pulse on the app icon.
   */
  trafficActive: boolean;
  /**
   * One-shot: set only on the payload that opens the pill right after an app
   * connects — the pill expands out of compact mode and opens its dropdown so
   * the "start a new session" guidance is visible without a click.
   */
  openMenu?: boolean;
};

export type VprFloatAction =
  | 'open-main'
  | { type: 'open-deposit' }
  | { type: 'select-model'; provider: string; serviceId: string }
  | { type: 'pin-chat-model'; conversationId: string; provider: string; serviceId: string }
  | { type: 'open-chat-app'; conversationId: string }
  | { type: 'set-compact'; compact: boolean };

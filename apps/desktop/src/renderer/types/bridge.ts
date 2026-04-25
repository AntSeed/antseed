export type RuntimeMode = 'connect';

export type RuntimeProcessState = {
  mode: RuntimeMode;
  running: boolean;
  pid?: number | null;
  startedAt?: number | null;
  lastExitCode?: number | null;
  lastError?: string | null;
  [key: string]: unknown;
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
  chatAiSend?: (conversationId: string, message: string, service?: string, provider?: string, attachments?: PreparedChatAttachment[]) => Promise<{ ok: boolean; error?: string }>;
  chatAiSendStream?: (conversationId: string, message: string, service?: string, provider?: string, attachments?: PreparedChatAttachment[]) => Promise<{ ok: boolean; error?: string; stopReason?: ChatAiStreamStopReason }>;
  chatAiAbort?: (conversationId?: string) => Promise<{ ok: boolean }>;
  chatAiSelectPeer?: (peerId: string | null) => Promise<{ ok: boolean; error?: string }>;
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
  onChatAiDone?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> } }) => void) => () => void;
  onChatAiError?: (handler: (data: { conversationId: string; error: string }) => void) => () => void;
  onChatAiUserPersisted?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => void) => () => void;
  onChatAiStreamStart?: (handler: (data: { conversationId: string; turn: number }) => void) => () => void;
  onChatAiStreamDelta?: (handler: (data: { conversationId: string; index: number; blockType: string; text: string }) => void) => () => void;
  onChatAiStreamBlockStart?: (handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string }) => void) => () => void;
  onChatAiStreamBlockStop?: (handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => void) => () => void;
  onChatAiStreamDone?: (handler: (data: { conversationId: string }) => void) => () => void;
  onChatAiStreamError?: (handler: (data: { conversationId: string; error: string; stopReason?: ChatAiStreamStopReason }) => void) => () => void;
  onChatAiToolExecuting?: (handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown> }) => void) => () => void;
  onChatAiToolUpdate?: (handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown>; output: string; details?: Record<string, unknown> }) => void) => () => void;
  onChatAiToolResult?: (handler: (data: { conversationId: string; toolUseId: string; output: string; isError: boolean; details?: Record<string, unknown> }) => void) => () => void;
  onBrowserPreviewOpen?: (handler: (data: { url: string }) => void) => () => void;
  sendBrowserPreviewElementSelected?: (data: { selector: string; tagName: string; text: string; attributes: Record<string, string> }) => void;
  onFullscreenChange?: (handler: (isFullscreen: boolean) => void) => () => void;
  onWindowFocusChange?: (handler: (isFocused: boolean) => void) => () => void;
  getAppSetupStatus?: () => Promise<{ needed: boolean; complete: boolean }>;
  onAppSetupStep?: (handler: (data: { step: string; label: string }) => void) => () => void;
  onAppSetupComplete?: (handler: () => void) => () => void;
  setDebugLogs?: (enabled: boolean) => Promise<{ ok: true }>;
  creditsGetInfo?: () => Promise<{ ok: boolean; data: { evmAddress: string | null; operatorAddress: string | null; balanceUsdc: string; reservedUsdc: string; availableUsdc: string; creditLimitUsdc: string } | null; error: string | null }>;

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

  paymentsOpenPortal?: (tab?: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
};

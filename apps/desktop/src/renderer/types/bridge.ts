export type RuntimeMode = 'seed' | 'connect' | 'dashboard';

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

export type DaemonStateSnapshot = {
  exists: boolean;
  state: Record<string, unknown> | null;
};

export type RuntimeSnapshot = {
  processes: RuntimeProcessState[];
  daemonState: DaemonStateSnapshot;
  logs: LogEvent[];
};

export type DashboardEndpoint =
  | 'status'
  | 'network'
  | 'peers'
  | 'sessions'
  | 'earnings'
  | 'config'
  | 'data-sources';

export type DashboardDataResult<T = unknown> = {
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

export type WalletConnectState = {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  pairingUri: string | null;
};

export type StartOptions = {
  mode: RuntimeMode;
  provider?: string;
  router?: string;
  dashboardPort?: number;
  env?: Record<string, string>;
};

export type DesktopBridge = {
  getState?: () => Promise<RuntimeSnapshot>;
  start?: (options: StartOptions) => Promise<unknown>;
  stop?: (mode: RuntimeMode) => Promise<unknown>;
  openDashboard?: (port?: number) => Promise<{ ok: true }>;
  clearLogs?: () => Promise<{ ok: true }>;

  pluginsList?: () => Promise<PluginListResult>;
  pluginsInstall?: (packageName: string) => Promise<PluginInstallResult>;

  getNetwork?: (port?: number) => Promise<{ ok: boolean; peers?: unknown[]; error?: string | null; [key: string]: unknown }>;
  getDashboardData?: (
    endpoint: DashboardEndpoint,
    options?: { port?: number; query?: Record<string, string | number | boolean> }
  ) => Promise<DashboardDataResult>;
  scanNetwork?: (port?: number) => Promise<DashboardDataResult>;

  onLog?: (handler: (event: LogEvent) => void) => () => void;
  onState?: (handler: (states: RuntimeProcessState[]) => void) => () => void;

  walletGetInfo?: (port?: number) => Promise<{ ok: boolean; data: unknown; error: string | null }>;
  walletDeposit?: (amount: string) => Promise<{ ok: boolean; error?: string; message?: string }>;
  walletWithdraw?: (amount: string) => Promise<{ ok: boolean; error?: string; message?: string }>;

  walletConnectState?: () => Promise<{ ok: boolean; data: WalletConnectState }>;
  walletConnectConnect?: () => Promise<{ ok: boolean; data?: { uri: string }; error?: string }>;
  walletConnectDisconnect?: () => Promise<{ ok: boolean; error?: string }>;
  onWalletConnectStateChanged?: (handler: (state: WalletConnectState) => void) => () => void;

  chatAiListConversations?: () => Promise<{ ok: boolean; data: unknown[] }>;
  chatAiListModels?: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
  chatAiGetConversation?: (id: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  chatAiCreateConversation?: (model: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  chatAiDeleteConversation?: (id: string) => Promise<{ ok: boolean }>;
  chatAiSend?: (conversationId: string, message: string, model?: string) => Promise<{ ok: boolean; error?: string }>;
  chatAiSendStream?: (conversationId: string, message: string, model?: string) => Promise<{ ok: boolean; error?: string }>;
  chatAiAbort?: () => Promise<{ ok: boolean }>;
  chatAiGetProxyStatus?: () => Promise<{ ok: boolean; data: { running: boolean; port: number } }>;
  onChatAiDone?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => void) => () => void;
  onChatAiError?: (handler: (data: { conversationId: string; error: string }) => void) => () => void;
  onChatAiUserPersisted?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => void) => () => void;
  onChatAiStreamStart?: (handler: (data: { conversationId: string; turn: number }) => void) => () => void;
  onChatAiStreamDelta?: (handler: (data: { conversationId: string; index: number; blockType: string; text: string }) => void) => () => void;
  onChatAiStreamBlockStart?: (handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string }) => void) => () => void;
  onChatAiStreamBlockStop?: (handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => void) => () => void;
  onChatAiStreamDone?: (handler: (data: { conversationId: string }) => void) => () => void;
  onChatAiStreamError?: (handler: (data: { conversationId: string; error: string }) => void) => () => void;
  onChatAiToolExecuting?: (handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown> }) => void) => () => void;
  onChatAiToolResult?: (handler: (data: { conversationId: string; toolUseId: string; output: string; isError: boolean }) => void) => () => void;
};

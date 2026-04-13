import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeMode, RuntimeProcessState, StartOptions } from './process-manager.js';

type LogEvent = {
  mode: RuntimeMode;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  timestamp: number;
};

type RuntimeActivityTone = 'active' | 'idle' | 'warn' | 'bad';

type RuntimeActivityEvent = {
  mode: RuntimeMode;
  tone: RuntimeActivityTone;
  stage: string;
  message: string;
  holdMs: number;
  timestamp: number;
  requestId?: string;
  peerId?: string;
};

type RuntimeSnapshot = {
  processes: RuntimeProcessState[];
  daemonState: { exists: boolean; state: Record<string, unknown> | null };
  logs: LogEvent[];
};

type NetworkPeer = {
  peerId: string;
  host: string;
  port: number;
  providers: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  lastSeen: number;
  source: 'dht' | 'daemon';
};

type NetworkStats = {
  totalPeers: number;
  dhtNodeCount: number;
  dhtHealthy: boolean;
  lastScanAt: number | null;
  totalLookups?: number;
  successfulLookups?: number;
  lookupSuccessRate?: number;
  averageLookupLatencyMs?: number;
  healthReason?: string;
};

type NetworkSnapshot = {
  ok: boolean;
  peers: NetworkPeer[];
  stats: NetworkStats;
  error: string | null;
};

type DataEndpoint = 'status' | 'network' | 'peers' | 'config' | 'data-sources';

type DataResult = {
  ok: boolean;
  data: unknown | null;
  error: string | null;
  status: number | null;
};

type PluginInfo = {
  package: string;
  version: string;
};

type PluginListResult = {
  ok: boolean;
  plugins: PluginInfo[];
  error: string | null;
};

type PluginInstallResult = {
  ok: boolean;
  package: string;
  plugins: PluginInfo[];
  error: string | null;
};

const api = {
  getState(): Promise<RuntimeSnapshot> {
    return ipcRenderer.invoke('runtime:get-state') as Promise<RuntimeSnapshot>;
  },
  start(options: StartOptions): Promise<{ state: RuntimeProcessState; processes: RuntimeProcessState[]; daemonState: { exists: boolean; state: Record<string, unknown> | null } }> {
    return ipcRenderer.invoke('runtime:start', options) as Promise<{ state: RuntimeProcessState; processes: RuntimeProcessState[]; daemonState: { exists: boolean; state: Record<string, unknown> | null } }>;
  },
  stop(mode: RuntimeMode): Promise<{ state: RuntimeProcessState; processes: RuntimeProcessState[]; daemonState: { exists: boolean; state: Record<string, unknown> | null } }> {
    return ipcRenderer.invoke('runtime:stop', mode) as Promise<{ state: RuntimeProcessState; processes: RuntimeProcessState[]; daemonState: { exists: boolean; state: Record<string, unknown> | null } }>;
  },
  openDashboard(port?: number): Promise<{ ok: true }> {
    return ipcRenderer.invoke('runtime:open-dashboard', port) as Promise<{ ok: true }>;
  },
  clearLogs(): Promise<{ ok: true }> {
    return ipcRenderer.invoke('runtime:clear-logs') as Promise<{ ok: true }>;
  },
  pluginsList(): Promise<PluginListResult> {
    return ipcRenderer.invoke('plugins:list') as Promise<PluginListResult>;
  },
  pluginsInstall(packageName: string): Promise<PluginInstallResult> {
    return ipcRenderer.invoke('plugins:install', packageName) as Promise<PluginInstallResult>;
  },
  getNetwork(port?: number): Promise<NetworkSnapshot> {
    return ipcRenderer.invoke('runtime:get-network', port) as Promise<NetworkSnapshot>;
  },
  getData(
    endpoint: DataEndpoint,
    options?: { port?: number; query?: Record<string, string | number | boolean> },
  ): Promise<DataResult> {
    return ipcRenderer.invoke('runtime:get-data', endpoint, options) as Promise<DataResult>;
  },
  updateConfig(
    config: Record<string, unknown>,
  ): Promise<DataResult> {
    return ipcRenderer.invoke('runtime:update-config', config) as Promise<DataResult>;
  },
  scanNetwork(): Promise<DataResult> {
    return ipcRenderer.invoke('runtime:scan-network') as Promise<DataResult>;
  },
  lookupPeer(peerId: string): Promise<{ ok: boolean; peer: unknown; error: string | null }> {
    return ipcRenderer.invoke('runtime:lookup-peer', peerId) as Promise<{ ok: boolean; peer: unknown; error: string | null }>;
  },
  touchPeer(peerId: string): void {
    void ipcRenderer.invoke('runtime:touch-peer', peerId);
  },
  onLog(handler: (event: LogEvent) => void): () => void {
    const listener = (_: unknown, event: LogEvent) => handler(event);
    ipcRenderer.on('runtime:log', listener);
    return () => ipcRenderer.off('runtime:log', listener);
  },
  onPeersChanged(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('peers:changed', listener);
    return () => ipcRenderer.off('peers:changed', listener);
  },
  onState(handler: (states: RuntimeProcessState[]) => void): () => void {
    const listener = (_: unknown, states: RuntimeProcessState[]) => handler(states);
    ipcRenderer.on('runtime:state', listener);
    return () => ipcRenderer.off('runtime:state', listener);
  },
  onRuntimeActivity(handler: (event: RuntimeActivityEvent) => void): () => void {
    const listener = (_: unknown, event: RuntimeActivityEvent) => handler(event);
    ipcRenderer.on('runtime:activity', listener);
    return () => ipcRenderer.off('runtime:activity', listener);
  },

  // AI Chat API
  chatAiListConversations(): Promise<{ ok: boolean; data: unknown[] }> {
    return ipcRenderer.invoke('chat:ai-list-conversations');
  },
  chatAiGetConversation(id: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return ipcRenderer.invoke('chat:ai-get-conversation', id);
  },
  chatAiCreateConversation(service: string, provider?: string, peerId?: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return ipcRenderer.invoke('chat:ai-create-conversation', service, provider, peerId);
  },
  chatAiListDiscoverRows(): Promise<{ ok: boolean; data?: unknown[]; error?: string }> {
    return ipcRenderer.invoke('chat:ai-list-discover-rows');
  },
  chatAiDeleteConversation(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('chat:ai-delete-conversation', id);
  },
  chatAiRenameConversation(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-rename-conversation', id, title);
  },
  chatAiSend(conversationId: string, message: string, service?: string, provider?: string, imageBase64?: string, imageMimeType?: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-send', conversationId, message, service, provider, imageBase64, imageMimeType);
  },
  chatAiSendStream(conversationId: string, message: string, service?: string, provider?: string, imageBase64?: string, imageMimeType?: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-send-stream', conversationId, message, service, provider, imageBase64, imageMimeType);
  },
  chatAiAbort(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('chat:ai-abort');
  },
  chatAiSelectPeer(peerId: string | null): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-select-peer', peerId);
  },
  chatAiGetProxyStatus(): Promise<{ ok: boolean; data: { running: boolean; port: number } }> {
    return ipcRenderer.invoke('chat:ai-get-proxy-status');
  },
  chatAiGetWorkspace(): Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }> {
    return ipcRenderer.invoke('chat:ai-get-workspace');
  },
  chatAiGetWorkspaceGitStatus(): Promise<{
    ok: boolean;
    data?: {
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
    error?: string;
  }> {
    return ipcRenderer.invoke('chat:ai-get-workspace-git-status');
  },
  chatAiSetWorkspace(workspacePath: string): Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }> {
    return ipcRenderer.invoke('chat:ai-set-workspace', workspacePath);
  },
  pickDirectory(): Promise<{ ok: boolean; path: string | null }> {
    return ipcRenderer.invoke('desktop:pick-directory');
  },
  onChatAiDone(handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> } }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> } }) => handler(data);
    ipcRenderer.on('chat:ai-done', listener);
    return () => ipcRenderer.off('chat:ai-done', listener);
  },
  onChatAiError(handler: (data: { conversationId: string; error: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; error: string }) => handler(data);
    ipcRenderer.on('chat:ai-error', listener);
    return () => ipcRenderer.off('chat:ai-error', listener);
  },
  onChatAiUserPersisted(handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => handler(data);
    ipcRenderer.on('chat:ai-user-persisted', listener);
    return () => ipcRenderer.off('chat:ai-user-persisted', listener);
  },
  // Streaming events
  onChatAiStreamStart(handler: (data: { conversationId: string; turn: number }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; turn: number }) => handler(data);
    ipcRenderer.on('chat:ai-stream-start', listener);
    return () => ipcRenderer.off('chat:ai-stream-start', listener);
  },
  onChatAiStreamDelta(handler: (data: { conversationId: string; index: number; blockType: string; text: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; index: number; blockType: string; text: string }) => handler(data);
    ipcRenderer.on('chat:ai-stream-delta', listener);
    return () => ipcRenderer.off('chat:ai-stream-delta', listener);
  },
  onChatAiStreamBlockStart(handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string }) => handler(data);
    ipcRenderer.on('chat:ai-stream-block-start', listener);
    return () => ipcRenderer.off('chat:ai-stream-block-start', listener);
  },
  onChatAiStreamBlockStop(handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-stream-block-stop', listener);
    return () => ipcRenderer.off('chat:ai-stream-block-stop', listener);
  },
  onChatAiStreamDone(handler: (data: { conversationId: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string }) => handler(data);
    ipcRenderer.on('chat:ai-stream-done', listener);
    return () => ipcRenderer.off('chat:ai-stream-done', listener);
  },
  onChatAiStreamError(handler: (data: { conversationId: string; error: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; error: string }) => handler(data);
    ipcRenderer.on('chat:ai-stream-error', listener);
    return () => ipcRenderer.off('chat:ai-stream-error', listener);
  },
  onChatAiToolExecuting(handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-tool-executing', listener);
    return () => ipcRenderer.off('chat:ai-tool-executing', listener);
  },
  onChatAiToolUpdate(handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown>; output: string; details?: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown>; output: string; details?: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-tool-update', listener);
    return () => ipcRenderer.off('chat:ai-tool-update', listener);
  },
  onChatAiToolResult(handler: (data: { conversationId: string; toolUseId: string; output: string; isError: boolean; details?: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; toolUseId: string; output: string; isError: boolean; details?: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-tool-result', listener);
    return () => ipcRenderer.off('chat:ai-tool-result', listener);
  },
  onBrowserPreviewOpen(handler: (data: { url: string }) => void): () => void {
    const listener = (_: unknown, data: { url: string }) => handler(data);
    ipcRenderer.on('browser-preview:open', listener);
    return () => ipcRenderer.off('browser-preview:open', listener);
  },
  sendBrowserPreviewElementSelected(data: { selector: string; tagName: string; text: string; attributes: Record<string, string> }): void {
    ipcRenderer.send('browser-preview:element-selected', data);
  },
  onFullscreenChange(handler: (isFullscreen: boolean) => void): () => void {
    const listener = (_: unknown, isFullscreen: boolean) => handler(isFullscreen);
    ipcRenderer.on('fullscreen-change', listener);
    return () => ipcRenderer.off('fullscreen-change', listener);
  },
  onWindowFocusChange(handler: (isFocused: boolean) => void): () => void {
    const listener = (_: unknown, isFocused: boolean) => handler(isFocused);
    ipcRenderer.on('window-focus-change', listener);
    return () => ipcRenderer.off('window-focus-change', listener);
  },
  getAppSetupStatus(): Promise<{ needed: boolean; complete: boolean }> {
    return ipcRenderer.invoke('app:get-setup-status') as Promise<{ needed: boolean; complete: boolean }>;
  },
  onAppSetupStep(handler: (data: { step: string; label: string }) => void): () => void {
    const listener = (_: unknown, data: { step: string; label: string }) => handler(data);
    ipcRenderer.on('app:setup-step', listener);
    return () => ipcRenderer.off('app:setup-step', listener);
  },
  onAppSetupComplete(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('app:setup-complete', listener);
    return () => ipcRenderer.off('app:setup-complete', listener);
  },

  // Auto-update
  onUpdateStatus(handler: (data: { status: string; version: string }) => void): () => void {
    const listener = (_: unknown, data: { status: string; version: string }) => handler(data);
    ipcRenderer.on('app:update-status', listener);
    return () => ipcRenderer.off('app:update-status', listener);
  },
  installUpdate(): Promise<void> {
    return ipcRenderer.invoke('app:install-update') as Promise<void>;
  },
  setDebugLogs(enabled: boolean): Promise<{ ok: true }> {
    return ipcRenderer.invoke('desktop:set-debug-logs', enabled) as Promise<{ ok: true }>;
  },
  creditsGetInfo() {
    return ipcRenderer.invoke('credits:get-info');
  },
  paymentsSignSpendingAuth: (params: unknown) => ipcRenderer.invoke('payments:sign-spending-auth', params),
  paymentsGetPeerInfo: (peerId: string) => ipcRenderer.invoke('payments:get-peer-info', peerId),
  paymentsOpenPortal: (tab?: string) => ipcRenderer.invoke('payments:open-portal', tab),
};

contextBridge.exposeInMainWorld('antseedDesktop', api);

export type DesktopBridge = typeof api;

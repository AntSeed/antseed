import type { DaemonStateSnapshot, RuntimeProcessState } from '../types/bridge';

export type SortDirection = 'asc' | 'desc';

export type SortState = {
  key: string;
  dir: SortDirection;
};

export type PluginHints = {
  router: string | null;
};

export type RendererUiState = {
  processes: RuntimeProcessState[];
  refreshing: boolean;
  dashboardRunning: boolean;
  daemonState: DaemonStateSnapshot | null;
  lastDebugKey: string;
  peerSort: SortState;
  peerFilter: string;
  lastPeers: unknown[];
  chatActiveConversation: string | null;
  chatConversations: unknown[];
  chatMessages: unknown[];
  chatSending: boolean;
  installedPlugins: Set<string>;
  pluginHints: PluginHints;
  pluginInstallBusy: boolean;
};

export function createInitialUiState(): RendererUiState {
  return {
    processes: [],
    refreshing: false,
    dashboardRunning: false,
    daemonState: null,
    lastDebugKey: '',
    peerSort: { key: 'reputation', dir: 'desc' },
    peerFilter: '',
    lastPeers: [],
    chatActiveConversation: null,
    chatConversations: [],
    chatMessages: [],
    chatSending: false,
    installedPlugins: new Set<string>(),
    pluginHints: {
      router: null,
    },
    pluginInstallBusy: false,
  };
}

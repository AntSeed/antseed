import type { DaemonStateSnapshot, RuntimeProcessState, WalletConnectState } from '../types/bridge';

export type SortDirection = 'asc' | 'desc';

export type SortState = {
  key: string;
  dir: SortDirection;
};

export type PluginHints = {
  provider: string | null;
  router: string | null;
};

export type RendererAppMode = 'seeder' | 'connect';

export type RendererUiState = {
  processes: RuntimeProcessState[];
  refreshing: boolean;
  dashboardRunning: boolean;
  lastActiveSessions: number;
  daemonState: DaemonStateSnapshot | null;
  lastSessionDebugKey: string;
  peerSort: SortState;
  sessionSort: SortState;
  peerFilter: string;
  lastPeers: unknown[];
  lastSessionsPayload: unknown;
  earningsPeriod: string;
  walletInfo: unknown;
  walletMode: 'node' | 'external';
  wcState: WalletConnectState;
  chatActiveConversation: string | null;
  chatConversations: unknown[];
  chatMessages: unknown[];
  chatSending: boolean;
  appMode: RendererAppMode;
  installedPlugins: Set<string>;
  pluginHints: PluginHints;
  pluginInstallBusy: boolean;
};

export function createInitialUiState(): RendererUiState {
  return {
    processes: [],
    refreshing: false,
    dashboardRunning: false,
    lastActiveSessions: 0,
    daemonState: null,
    lastSessionDebugKey: '',
    peerSort: { key: 'reputation', dir: 'desc' },
    sessionSort: { key: 'startedAt', dir: 'desc' },
    peerFilter: '',
    lastPeers: [],
    lastSessionsPayload: null,
    earningsPeriod: 'month',
    walletInfo: null,
    walletMode: 'node',
    wcState: { connected: false, address: null, chainId: null, pairingUri: null },
    chatActiveConversation: null,
    chatConversations: [],
    chatMessages: [],
    chatSending: false,
    appMode: 'connect',
    installedPlugins: new Set<string>(),
    pluginHints: {
      provider: null,
      router: null,
    },
    pluginInstallBusy: false,
  };
}

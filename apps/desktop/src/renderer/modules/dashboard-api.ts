import type { DataResult, DesktopBridge } from '../types/bridge';
import type { RendererUiState } from '../core/state';
import { safeNumber, safeArray } from '../core/safe';

type RefreshHooks = {
  renderDashboardData: (payload: {
    network: DataResult;
    peers: DataResult;
    status: DataResult;
    dataSources: DataResult;
    config: DataResult;
  }) => void;
  setDashboardRefreshState?: (busy: boolean, stage: string) => void;
  refreshChatConversations: () => Promise<void> | void;
  refreshChatProxyStatus: () => Promise<void> | void;
};

type DashboardApiOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  defaultDashboardPort?: number;
};

export function initDashboardApiModule({
  bridge,
  uiState,
  defaultDashboardPort = 3117,
}: DashboardApiOptions) {
  let refreshHooks: RefreshHooks | null = null;

  function getDashboardPort(): number {
    const port = safeNumber(uiState.dashboardPortValue, defaultDashboardPort);
    if (port <= 0 || port > 65535) return defaultDashboardPort;
    return Math.floor(port);
  }

  function errorResult(message: string): DataResult {
    return { ok: false, data: null, error: message, status: null };
  }

  async function getDashboardData(
    endpoint: 'status' | 'network' | 'peers' | 'config' | 'data-sources',
    query: Record<string, string | number | boolean> | undefined = undefined,
  ): Promise<DataResult> {
    if (!bridge) return errorResult('Desktop bridge unavailable');

    // New bridge API (getData)
    if (bridge.getData) {
      try {
        return await bridge.getData(endpoint, { port: getDashboardPort(), query });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }

    // Legacy fallback: getNetwork for network/peers endpoints
    if ((endpoint === 'network' || endpoint === 'peers') && bridge.getNetwork) {
      const legacyNetwork = await bridge.getNetwork(getDashboardPort());
      if (!legacyNetwork.ok) return errorResult(legacyNetwork.error ?? 'Failed to query network');
      if (endpoint === 'peers') {
        return { ok: true, data: { peers: safeArray(legacyNetwork.peers), total: safeArray(legacyNetwork.peers).length, degraded: false }, error: null, status: 200 };
      }
      return { ok: true, data: legacyNetwork, error: null, status: 200 };
    }

    return errorResult('Data bridge unavailable');
  }

  async function scanDhtNow(): Promise<DataResult> {
    if (!bridge) return errorResult('Desktop bridge unavailable');
    if (!bridge.scanNetwork) return errorResult('Scan not available');
    try {
      return await bridge.scanNetwork();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  async function updateDashboardConfig(config: Record<string, unknown>): Promise<DataResult> {
    if (!bridge) return errorResult('Desktop bridge unavailable');
    if (!bridge.updateConfig) return errorResult('Config update not available');
    try {
      return await bridge.updateConfig(config);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  function setRefreshHooks(hooks: RefreshHooks): void {
    refreshHooks = hooks;
  }

  async function refreshDashboardData(_processes: unknown): Promise<void> {
    if (!refreshHooks) return;

    const { renderDashboardData, setDashboardRefreshState, refreshChatConversations, refreshChatProxyStatus } =
      refreshHooks;

    setDashboardRefreshState?.(true, 'Refreshing peers and network status...');

    try {
      setDashboardRefreshState?.(true, 'Loading network and peers...');
      const [network, peers] = await Promise.all([getDashboardData('network'), getDashboardData('peers')]);

      setDashboardRefreshState?.(true, 'Loading runtime status and settings...');
      const [status, dataSources, config] = await Promise.all([
        getDashboardData('status'),
        getDashboardData('data-sources'),
        getDashboardData('config'),
      ]);

      renderDashboardData({ network, peers, status, dataSources, config });
      setDashboardRefreshState?.(true, 'Dashboard data refreshed.');
    } finally {
      setDashboardRefreshState?.(false, 'Idle');
    }

    void refreshChatConversations();
    void refreshChatProxyStatus();
  }

  return {
    getDashboardPort,
    getDashboardData,
    updateDashboardConfig,
    scanDhtNow,
    setRefreshHooks,
    refreshDashboardData,
  };
}

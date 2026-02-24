import type { DashboardDataResult, DesktopBridge } from '../types/bridge';

type DashboardApiElements = Record<string, unknown> & {
  dashboardPort?: HTMLInputElement | null;
};

type DashboardApiUiState = Record<string, any>;

type RefreshHooks = {
  renderDashboardData: (payload: {
    network: DashboardDataResult;
    peers: DashboardDataResult;
    sessions: DashboardDataResult;
    earnings: DashboardDataResult;
    status: DashboardDataResult;
    dataSources: DashboardDataResult;
    config: DashboardDataResult;
  }) => void;
  refreshWalletInfo: () => Promise<void> | void;
  refreshChatConversations: () => Promise<void> | void;
  refreshChatProxyStatus: () => Promise<void> | void;
  [key: string]: unknown;
};

type DashboardApiOptions = {
  bridge?: DesktopBridge;
  elements: DashboardApiElements;
  uiState: DashboardApiUiState;
  defaultDashboardPort?: number;
  safeNumber: (value: unknown, fallback?: number) => number;
  safeArray: (value: unknown) => unknown[];
};

export function initDashboardApiModule({
  bridge,
  elements,
  uiState,
  defaultDashboardPort = 3117,
  safeNumber,
  safeArray,
}: DashboardApiOptions) {
  let refreshHooks: RefreshHooks | null = null;

  function getDashboardPort(): number {
    const port = safeNumber(elements.dashboardPort?.value, defaultDashboardPort);
    if (port <= 0 || port > 65535) {
      return defaultDashboardPort;
    }
    return Math.floor(port);
  }

  function dashboardBridgeError(message: string): DashboardDataResult {
    return {
      ok: false,
      data: null,
      error: message,
      status: null,
    };
  }

  async function getDashboardData(
    endpoint: 'status' | 'network' | 'peers' | 'sessions' | 'earnings' | 'config' | 'data-sources',
    query: Record<string, string | number | boolean> | undefined = undefined,
  ): Promise<DashboardDataResult> {
    if (!bridge) {
      return dashboardBridgeError('Desktop bridge unavailable');
    }

    if (!bridge.getDashboardData) {
      if (endpoint === 'network' && bridge.getNetwork) {
        const legacyNetwork = await bridge.getNetwork(getDashboardPort());
        if (!legacyNetwork.ok) {
          return dashboardBridgeError(legacyNetwork.error ?? 'Failed to query network endpoint');
        }
        return {
          ok: true,
          data: legacyNetwork,
          error: null,
          status: 200,
        };
      }

      if (endpoint === 'peers' && bridge.getNetwork) {
        const legacyNetwork = await bridge.getNetwork(getDashboardPort());
        if (!legacyNetwork.ok) {
          return dashboardBridgeError(legacyNetwork.error ?? 'Failed to query peers endpoint');
        }
        return {
          ok: true,
          data: {
            peers: safeArray(legacyNetwork.peers),
            total: safeArray(legacyNetwork.peers).length,
            degraded: false,
          },
          error: null,
          status: 200,
        };
      }

      return dashboardBridgeError('Dashboard data bridge unavailable');
    }

    try {
      return await bridge.getDashboardData(endpoint, {
        port: getDashboardPort(),
        query,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("No handler registered for 'runtime:get-dashboard-data'")) {
        if (endpoint === 'network' && bridge.getNetwork) {
          const legacyNetwork = await bridge.getNetwork(getDashboardPort());
          if (!legacyNetwork.ok) {
            return dashboardBridgeError(legacyNetwork.error ?? 'Failed to query network endpoint');
          }
          return {
            ok: true,
            data: legacyNetwork,
            error: null,
            status: 200,
          };
        }

        return dashboardBridgeError('Desktop main process is outdated. Fully quit and relaunch AntSeed Desktop.');
      }

      return dashboardBridgeError(message);
    }
  }

  async function scanDhtNow(): Promise<DashboardDataResult> {
    if (!bridge) {
      return dashboardBridgeError('Desktop bridge unavailable');
    }
    if (!bridge.scanNetwork) {
      return dashboardBridgeError('Desktop main process does not support DHT scan yet. Rebuild and relaunch app.');
    }

    try {
      return await bridge.scanNetwork(getDashboardPort());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return dashboardBridgeError(message);
    }
  }

  function setRefreshHooks(hooks: RefreshHooks): void {
    refreshHooks = hooks;
  }

  async function refreshDashboardData(_processes: unknown): Promise<void> {
    if (!refreshHooks) {
      return;
    }

    const {
      renderDashboardData,
      refreshWalletInfo,
      refreshChatConversations,
      refreshChatProxyStatus,
    } = refreshHooks;

    const [
      network,
      peers,
      sessions,
      earnings,
      status,
      dataSources,
      config,
    ] = await Promise.all([
      getDashboardData('network'),
      getDashboardData('peers'),
      getDashboardData('sessions', { limit: 100, offset: 0 }),
      getDashboardData('earnings', { period: uiState.earningsPeriod }),
      getDashboardData('status'),
      getDashboardData('data-sources'),
      getDashboardData('config'),
    ]);

    renderDashboardData({
      network,
      peers,
      sessions,
      earnings,
      status,
      dataSources,
      config,
    });

    void refreshWalletInfo();
    void refreshChatConversations();
    void refreshChatProxyStatus();
  }

  return {
    getDashboardPort,
    getDashboardData,
    scanDhtNow,
    setRefreshHooks,
    refreshDashboardData,
  };
}

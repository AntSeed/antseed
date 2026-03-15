import type { DashboardDataResult, DesktopBridge } from '../types/bridge';
import type { RendererUiState } from '../core/state';
import { safeNumber, safeArray } from '../core/safe';

type RefreshHooks = {
  renderDashboardData: (payload: {
    network: DashboardDataResult;
    peers: DashboardDataResult;
    status: DashboardDataResult;
    dataSources: DashboardDataResult;
    config: DashboardDataResult;
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
  let dashboardReady = false;
  let lastDashboardCheck = 0;

  function getDashboardPort(): number {
    const port = safeNumber(uiState.dashboardPortValue, defaultDashboardPort);
    if (port <= 0 || port > 65535) return defaultDashboardPort;
    return Math.floor(port);
  }

  function dashboardBridgeError(message: string): DashboardDataResult {
    return { ok: false, data: null, error: message, status: null };
  }

  async function getDashboardData(
    endpoint: 'status' | 'network' | 'peers' | 'config' | 'data-sources',
    query: Record<string, string | number | boolean> | undefined = undefined,
  ): Promise<DashboardDataResult> {
    if (!bridge) return dashboardBridgeError('Desktop bridge unavailable');

    if (!bridge.getDashboardData) {
      // Always try legacy fallback for network/peers if new API is unavailable
      if ((endpoint === 'network' || endpoint === 'peers') && bridge.getNetwork) {
        const legacyNetwork = await bridge.getNetwork(getDashboardPort());
        if (!legacyNetwork.ok) return dashboardBridgeError(legacyNetwork.error ?? 'Failed to query network endpoint');
        
        if (endpoint === 'network') {
          return { ok: true, data: legacyNetwork, error: null, status: 200 };
        } else {
          return {
            ok: true,
            data: { peers: safeArray(legacyNetwork.peers), total: safeArray(legacyNetwork.peers).length, degraded: false },
            error: null,
            status: 200,
          };
        }
      }

      return dashboardBridgeError('Dashboard data bridge unavailable');
    }

    try {
      return await bridge.getDashboardData(endpoint, { port: getDashboardPort(), query });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("No handler registered for 'runtime:get-dashboard-data'")) {
        // Consistent legacy fallback for both network and peers
        if ((endpoint === 'network' || endpoint === 'peers') && bridge.getNetwork) {
          const legacyNetwork = await bridge.getNetwork(getDashboardPort());
          if (!legacyNetwork.ok) return dashboardBridgeError(legacyNetwork.error ?? 'Failed to query network endpoint');
          
          if (endpoint === 'network') {
            return { ok: true, data: legacyNetwork, error: null, status: 200 };
          } else {
            return {
              ok: true,
              data: { peers: safeArray(legacyNetwork.peers), total: safeArray(legacyNetwork.peers).length, degraded: false },
              error: null,
              status: 200,
            };
          }
        }
        return dashboardBridgeError('Desktop main process is outdated. Fully quit and relaunch AntSeed Desktop.');
      }

      // On any API error, try legacy fallback for network/peers data
      if ((endpoint === 'network' || endpoint === 'peers') && bridge.getNetwork) {
        try {
          const legacyNetwork = await bridge.getNetwork(getDashboardPort());
          if (legacyNetwork.ok) {
            if (endpoint === 'network') {
              return { ok: true, data: legacyNetwork, error: null, status: 200 };
            } else {
              return {
                ok: true,
                data: { peers: safeArray(legacyNetwork.peers), total: safeArray(legacyNetwork.peers).length, degraded: false },
                error: null,
                status: 200,
              };
            }
          }
        } catch {
          // If legacy fallback also fails, return original error
        }
      }

      return dashboardBridgeError(message);
    }
  }

  async function scanDhtNow(): Promise<DashboardDataResult> {
    if (!bridge) return dashboardBridgeError('Desktop bridge unavailable');
    if (!bridge.scanNetwork)
      return dashboardBridgeError('Desktop main process does not support DHT scan yet. Rebuild and relaunch app.');

    try {
      return await bridge.scanNetwork(getDashboardPort());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return dashboardBridgeError(message);
    }
  }

  async function updateDashboardConfig(config: Record<string, unknown>): Promise<DashboardDataResult> {
    if (!bridge) return dashboardBridgeError('Desktop bridge unavailable');
    if (!bridge.updateDashboardConfig) {
      return dashboardBridgeError('Dashboard config update bridge unavailable');
    }

    try {
      return await bridge.updateDashboardConfig(config, { port: getDashboardPort() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return dashboardBridgeError(message);
    }
  }

  async function ensureDashboardReady(): Promise<boolean> {
    const now = Date.now();
    // Cache readiness check for 5 seconds to avoid hammering the API
    if (dashboardReady && now - lastDashboardCheck < 5000) {
      return true;
    }

    try {
      const result = await getDashboardData('status');
      dashboardReady = result.ok;
      lastDashboardCheck = now;
      return dashboardReady;
    } catch {
      dashboardReady = false;
      lastDashboardCheck = now;
      return false;
    }
  }

  function setRefreshHooks(hooks: RefreshHooks): void {
    refreshHooks = hooks;
  }

  async function refreshDashboardData(_processes: unknown): Promise<void> {
    if (!refreshHooks) return;

    const { renderDashboardData, setDashboardRefreshState, refreshChatConversations, refreshChatProxyStatus } =
      refreshHooks;

    setDashboardRefreshState?.(true, 'Checking dashboard readiness...');

    try {
      // Ensure dashboard is ready before attempting data fetch
      const ready = await ensureDashboardReady();
      if (!ready) {
        setDashboardRefreshState?.(true, 'Waiting for dashboard service...');
        // Wait a bit longer for dashboard to start
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retryReady = await ensureDashboardReady();
        if (!retryReady) {
          // Fall back to showing offline state
          setDashboardRefreshState?.(false, 'Dashboard service unavailable');
          return;
        }
      }

      // First attempt: Load network and peers data
      setDashboardRefreshState?.(true, 'Loading network and peers...');
      let network = await getDashboardData('network');
      let peers = await getDashboardData('peers');

      // If both network and peers failed, retry once after a short delay
      if (!network.ok && !peers.ok) {
        setDashboardRefreshState?.(true, 'Retrying peer discovery...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const retryResults = await Promise.all([
          getDashboardData('network'),
          getDashboardData('peers')
        ]);
        network = retryResults[0];
        peers = retryResults[1];
      }

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
    ensureDashboardReady,
  };
}

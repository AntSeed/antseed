import type { ViewModelProps } from '../types';

type RuntimeToolbarProps = {
  vm: ViewModelProps['vm'];
};

export function RuntimeToolbar({ vm }: RuntimeToolbarProps) {
  return (
    <section className={`runtime-toolbar ${vm.shellState.activeView === 'overview' || vm.shellState.activeView === 'desktop' ? '' : 'hidden'}`}>
      <div className="toolbar-header">
        <h2>Buyer Runtime</h2>
        <div className="toolbar-actions">
          <button
            id="startAllBtn"
            onClick={() => void vm.withRuntimeAction(async () => {
              if (!vm.bridge?.start) return;
              await vm.bridge.start({ mode: 'connect', router: 'local' });
              vm.setConnectWarning(null);
            })}
          >
            Start Connect
          </button>
          <button
            id="stopAllBtn"
            className="danger"
            onClick={() => void vm.withRuntimeAction(async () => {
              if (!vm.bridge?.stop) return;
              await vm.bridge.stop('connect');
            })}
          >
            Stop Connect
          </button>
          <button id="scanNetworkBtn" className="secondary" onClick={() => void vm.withRuntimeAction(vm.scanDht)}>Scan DHT</button>
          <button id="refreshBtn" className="secondary" onClick={() => void vm.refreshAll()}>Refresh</button>
          <button
            id="clearLogsBtn"
            className="danger"
            onClick={() => void vm.withRuntimeAction(async () => {
              if (!vm.bridge?.clearLogs) return;
              await vm.bridge.clearLogs();
              vm.setLogs([]);
            })}
          >
            Clear Logs
          </button>
        </div>
      </div>
      <div className="runtime-grid">
        <article className="control-card" data-mode="connect">
          <h3>Buyer Runtime</h3>
          <label>Router<input id="connectRouter" value="local" readOnly /></label>
          <div className="row">
            <button
              id="connectStartBtn"
              onClick={() => void vm.withRuntimeAction(async () => {
                if (!vm.bridge?.start) return;
                await vm.bridge.start({ mode: 'connect', router: 'local' });
                vm.setConnectWarning(null);
              })}
            >
              Start
            </button>
            <button
              id="connectStopBtn"
              className="danger"
              onClick={() => void vm.withRuntimeAction(async () => {
                if (!vm.bridge?.stop) return;
                await vm.bridge.stop('connect');
              })}
            >
              Stop
            </button>
          </div>
          <p id="connectState" className={`state ${vm.buyerRunning ? 'status-running' : 'status-stopped'}`}>
            {vm.buyerRunning
              ? `Running (pid=${vm.safeNumber(vm.connectProcess?.pid, 0) || 'unknown'}, uptime=${vm.formatDuration(Date.now() - vm.safeNumber(vm.connectProcess?.startedAt, Date.now()))})`
              : `Stopped${vm.connectProcess?.lastError ? ` | error=${vm.connectProcess.lastError}` : ''}`}
          </p>
        </article>
      </div>
      <article id="pluginSetupCard" className="plugin-setup-card">
        <div className="plugin-setup-head">
          <h3>Plugin Setup</h3>
          <button id="refreshPluginsBtn" className="secondary" onClick={() => void vm.refreshPluginInventory()} disabled={vm.pluginInstallBusy}>Recheck</button>
        </div>
        <p id="pluginSetupStatus" className="plugin-setup-status">
          {vm.routerInstalled ? 'Required runtime plugins are installed.' : `Missing plugin: ${vm.expectedRouterPlugin}`}
        </p>
        <div className="plugin-setup-actions">
          <button
            id="installConnectPluginBtn"
            className="secondary"
            disabled={vm.pluginInstallBusy || vm.routerInstalled || !vm.bridge?.pluginsInstall}
            onClick={() => void vm.runPluginInstall(vm.expectedRouterPlugin)}
          >
            {vm.routerInstalled ? `Buyer Ready (${vm.expectedRouterPlugin})` : `Install ${vm.expectedRouterPlugin}`}
          </button>
        </div>
      </article>
    </section>
  );
}

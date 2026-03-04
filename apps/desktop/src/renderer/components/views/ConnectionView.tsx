import type { ViewModelProps } from '../types';

type ConnectionViewProps = {
  vm: ViewModelProps['vm'];
};

export function ConnectionView({ vm }: ConnectionViewProps) {
  return (
    <section id="view-connection" className={vm.viewClass(vm.shellState.activeView === 'connection')} role="tabpanel">
      <div className="page-header">
        <h2>Connection</h2>
        <div id="connectionMeta" className={vm.toneClass(vm.dhtState.tone)}>{`DHT ${vm.dhtState.label}`}</div>
      </div>
      <div className="panel-grid two-col">
        <article className="panel">
          <div className="panel-head"><h3>Node Status</h3></div>
          <pre id="connectionStatus">{vm.dashboardData.status.ok ? vm.connectionStatusPayload : `Unable to load status: ${vm.dashboardData.status.error ?? 'unknown error'}`}</pre>
        </article>
        <article className="panel">
          <div className="panel-head"><h3>Network Stats</h3></div>
          <pre id="connectionNetwork">
            {vm.dashboardData.network.ok || vm.dashboardData.peers.ok
              ? JSON.stringify({ peers: vm.normalizedNetwork.peers.slice(0, 200), stats: vm.normalizedNetwork.stats }, null, 2)
              : `Unable to load network: ${vm.dashboardData.network.error ?? 'unknown error'}`}
          </pre>
        </article>
        <article className="panel">
          <div className="panel-head"><h3>Data Sources</h3></div>
          <pre id="connectionSources">{vm.dashboardData.dataSources.ok ? JSON.stringify(vm.dataSourcesPayload, null, 2) : `Unable to load data sources: ${vm.dashboardData.dataSources.error ?? 'unknown error'}`}</pre>
        </article>
        <article className="panel">
          <div className="panel-head"><h3>Connection Notes</h3></div>
          <pre id="connectionNotes">{vm.connectionNotes}</pre>
        </article>
      </div>
    </section>
  );
}

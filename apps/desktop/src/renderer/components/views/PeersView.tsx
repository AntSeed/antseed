import type { ViewModelProps } from '../types';

type PeersViewProps = {
  vm: ViewModelProps['vm'];
};

export function PeersView({ vm }: PeersViewProps) {
  return (
    <section id="view-peers" className={vm.viewClass(vm.shellState.activeView === 'peers')} role="tabpanel">
      <div className="page-header">
        <h2>Peers</h2>
        <div className="page-header-right">
          <input id="peerFilter" type="text" className="filter-input" placeholder="Filter peers..." value={vm.peerFilter} onChange={(event) => vm.setPeerFilter(event.target.value)} />
          <button id="scanNetworkBtnPeers" className="secondary" onClick={() => void vm.withRuntimeAction(vm.scanDht)}>Scan DHT</button>
          <div id="peersMeta" className={vm.toneClass(vm.dhtState.tone)}>{`${vm.formatInt(vm.normalizedNetwork.peers.length)} peers`}</div>
        </div>
      </div>
      <p id="peersMessage" className="message">
        {vm.dashboardData.network.ok || vm.dashboardData.peers.ok
          ? `Peer visibility merged from daemon and DHT. Last scan: ${vm.formatRelativeTime(vm.normalizedNetwork.stats.lastScanAt)}`
          : `Unable to load peers: ${vm.dashboardData.network.error ?? vm.dashboardData.peers.error ?? 'network unavailable'}`}
      </p>
      <div className="panel">
        <div className="table-wrap">
          <table className="table">
            <thead id="peersHead">
              <tr>
                <th className={`sortable ${vm.peerSort.key === 'peerId' ? `sort-${vm.peerSort.dir}` : ''}`} onClick={() => vm.setPeerSort((current) => ({ key: 'peerId', dir: current.key === 'peerId' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Peer</th>
                <th className={`sortable ${vm.peerSort.key === 'source' ? `sort-${vm.peerSort.dir}` : ''}`} onClick={() => vm.setPeerSort((current) => ({ key: 'source', dir: current.key === 'source' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Source</th>
                <th className={`sortable ${vm.peerSort.key === 'providers' ? `sort-${vm.peerSort.dir}` : ''}`} onClick={() => vm.setPeerSort((current) => ({ key: 'providers', dir: current.key === 'providers' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Providers</th>
                <th className={`sortable ${vm.peerSort.key === 'inputUsdPerMillion' ? `sort-${vm.peerSort.dir}` : ''}`} onClick={() => vm.setPeerSort((current) => ({ key: 'inputUsdPerMillion', dir: current.key === 'inputUsdPerMillion' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Input $/1M</th>
                <th className={`sortable ${vm.peerSort.key === 'outputUsdPerMillion' ? `sort-${vm.peerSort.dir}` : ''}`} onClick={() => vm.setPeerSort((current) => ({ key: 'outputUsdPerMillion', dir: current.key === 'outputUsdPerMillion' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Output $/1M</th>
                <th className={`sortable ${vm.peerSort.key === 'capacityMsgPerHour' ? `sort-${vm.peerSort.dir}` : ''}`} onClick={() => vm.setPeerSort((current) => ({ key: 'capacityMsgPerHour', dir: current.key === 'capacityMsgPerHour' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Capacity</th>
                <th className={`sortable ${vm.peerSort.key === 'reputation' ? `sort-${vm.peerSort.dir}` : ''}`} onClick={() => vm.setPeerSort((current) => ({ key: 'reputation', dir: current.key === 'reputation' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Rep</th>
                <th className={`sortable ${vm.peerSort.key === 'location' ? `sort-${vm.peerSort.dir}` : ''}`} onClick={() => vm.setPeerSort((current) => ({ key: 'location', dir: current.key === 'location' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Location</th>
                <th>Endpoint</th>
              </tr>
            </thead>
            <tbody id="peersBody">
              {vm.peerRows.length === 0 && (
                <tr><td colSpan={9} className="empty">{vm.normalizedNetwork.peers.length > 0 ? 'No peers match filter.' : 'No peers discovered yet.'}</td></tr>
              )}
              {vm.peerRows}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

import type { ViewModelProps } from '../types';

type OverviewViewProps = {
  vm: ViewModelProps['vm'];
};

export function OverviewView({ vm }: OverviewViewProps) {
  return (
    <section id="view-overview" className={vm.viewClass(vm.shellState.activeView === 'overview')} role="tabpanel">
      <div className="page-header">
        <h2>Overview</h2>
        <div id="overviewBadge" className={vm.toneClass(vm.dhtState.tone)}>
          {`DHT ${vm.dhtState.label}`}
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Active Peers</p>
          <p id="ovPeers" className="stat-value">{vm.formatInt(vm.normalizedNetwork.peers.length)}</p>
        </div>
        <div id="ovSessionsCard" className="stat-card">
          <p className="stat-label">Active Sessions</p>
          <p id="ovSessions" className="stat-value">{vm.formatInt(vm.activeSessions)}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">DHT Health</p>
          <p id="ovDhtHealth" className="stat-value">{vm.dhtState.label}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Proxy Port</p>
          <p id="ovUptime" className="stat-value">{vm.safeNumber(vm.statusPayload.proxyPort, 0) || '-'}</p>
        </div>
      </div>
      <article className="panel panel-span-full">
        <div className="panel-head">
          <h3>Top Peers</h3>
          <span id="ovPeersCount" className="panel-count">{vm.formatInt(vm.normalizedNetwork.peers.length)}</span>
        </div>
        <div className="table-wrap compact">
          <table className="table">
            <thead>
              <tr>
                <th>Peer</th>
                <th>Providers</th>
                <th>Rep</th>
              </tr>
            </thead>
            <tbody id="overviewPeersBody">
              {vm.topPeers.length === 0 && (
                <tr><td colSpan={3} className="empty">No peers yet.</td></tr>
              )}
              {vm.topPeers.map((peer) => (
                <tr key={peer.peerId}>
                  <td title={`${vm.resolvePeerDisplayName(peer)}\n${peer.peerId}`}>{`${vm.resolvePeerDisplayName(peer)} (${vm.formatShortId(peer.peerId)})`}</td>
                  <td>{peer.providers.length > 0 ? peer.providers.join(', ') : 'n/a'}</td>
                  <td>{vm.formatInt(peer.reputation)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}

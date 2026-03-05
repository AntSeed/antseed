import { memo } from 'react';

type PeersViewProps = {
  active: boolean;
};

const PeersContent = memo(function PeersContent() {
  return (
    <>
      <div className="page-header">
        <h2>Peers</h2>
        <div className="page-header-right">
          <input id="peerFilter" type="text" className="filter-input" placeholder="Filter peers..." />
          <button id="scanNetworkBtnPeers" className="secondary">
            Scan DHT
          </button>
          <div id="peersMeta" className="connection-badge badge-idle">
            0 peers
          </div>
        </div>
      </div>
      <p id="peersMessage" className="message">
        Loading peer visibility...
      </p>
      <div className="panel">
        <div className="table-wrap">
          <table className="table">
            <thead id="peersHead">
              <tr>
                <th className="sortable" data-sort="peerId">
                  Peer
                </th>
                <th className="sortable" data-sort="source">
                  Source
                </th>
                <th className="sortable" data-sort="providers">
                  Providers
                </th>
                <th className="sortable" data-sort="inputUsdPerMillion">
                  Input $/1M
                </th>
                <th className="sortable" data-sort="outputUsdPerMillion">
                  Output $/1M
                </th>
                <th className="sortable" data-sort="capacityMsgPerHour">
                  Capacity
                </th>
                <th className="sortable" data-sort="reputation">
                  Rep
                </th>
                <th className="sortable" data-sort="location">
                  Location
                </th>
                <th>Endpoint</th>
              </tr>
            </thead>
            <tbody id="peersBody">
              <tr>
                <td colSpan={9} className="empty">
                  No peers yet.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
});

export function PeersView({ active }: PeersViewProps) {
  return (
    <section id="view-peers" className={`view${active ? ' active' : ''}`} role="tabpanel">
      <PeersContent />
    </section>
  );
}

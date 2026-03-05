import { memo } from 'react';

type OverviewViewProps = {
  active: boolean;
};

const OverviewContent = memo(function OverviewContent() {
  return (
    <>
      <div className="page-header">
        <h2>Overview</h2>
        <div id="overviewBadge" className="connection-badge badge-idle">
          Idle
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Buyer Runtime</p>
          <p id="ovNodeState" className="stat-value">
            idle
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Active Peers</p>
          <p id="ovPeers" className="stat-value">
            0
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-label">DHT Health</p>
          <p id="ovDhtHealth" className="stat-value">
            Down
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Proxy Port</p>
          <p id="ovUptime" className="stat-value">
            -
          </p>
        </div>
      </div>

      <div className="panel-grid two-col">
        <article className="panel panel-span-full">
          <div className="panel-head">
            <h3>Top Peers</h3>
            <span id="ovPeersCount" className="panel-count">
              0
            </span>
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
                <tr>
                  <td colSpan={3} className="empty">
                    No peers yet.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </>
  );
});

export function OverviewView({ active }: OverviewViewProps) {
  return (
    <section id="view-overview" className={`view${active ? ' active' : ''}`} role="tabpanel">
      <OverviewContent />
    </section>
  );
}

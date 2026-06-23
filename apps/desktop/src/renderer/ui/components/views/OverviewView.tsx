import { useMemo } from 'react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { formatShortId, formatInt } from '../../../core/format';
import {
  buildPeerReputationScoreMap,
  formatReputationScore,
  getPeerReputationScore,
} from '../../../core/peer-utils';

type OverviewViewProps = {
  active: boolean;
};

export function OverviewView({ active }: OverviewViewProps) {
  const {
    overviewBadge,
    ovNodeState,
    ovPeers,
    ovDhtHealth,
    ovProxyPort,
    ovServiceCount,
    ovLastScan,
    ovPeersCount,
    overviewPeers,
    discoverRows,
  } = useUiSelector((state) => ({
    overviewBadge: state.overviewBadge,
    ovNodeState: state.ovNodeState,
    ovPeers: state.ovPeers,
    ovDhtHealth: state.ovDhtHealth,
    ovProxyPort: state.ovProxyPort,
    ovServiceCount: state.ovServiceCount,
    ovLastScan: state.ovLastScan,
    ovPeersCount: state.ovPeersCount,
    overviewPeers: state.overviewPeers,
    discoverRows: state.discoverRows,
  }), shallowEqual);

  const reputationScoresByPeerId = useMemo(
    () => buildPeerReputationScoreMap(discoverRows),
    [discoverRows],
  );

  const topPeersByReputation = useMemo(
    () => [...overviewPeers].sort((a, b) => {
      const ar = getPeerReputationScore(a, reputationScoresByPeerId) ?? -1;
      const br = getPeerReputationScore(b, reputationScoresByPeerId) ?? -1;
      if (br !== ar) return br - ar;
      return b.lastSeen - a.lastSeen;
    }),
    [overviewPeers, reputationScoresByPeerId],
  );

  return (
    <section className={`view${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>Overview</h2>
        <div className={`connection-badge badge-${overviewBadge.tone}`}>{overviewBadge.label}</div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Buyer Runtime</p>
          <p className="stat-value">{ovNodeState}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Active Peers</p>
          <p className="stat-value">{ovPeers}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">DHT Health</p>
          <p className="stat-value">{ovDhtHealth}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Proxy Port</p>
          <p className="stat-value">{ovProxyPort}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Network Services</p>
          <p className="stat-value">{ovServiceCount}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Last Scan</p>
          <p className="stat-value">{ovLastScan}</p>
        </div>
      </div>

      <div className="panel-grid two-col">
        <article className="panel panel-span-full">
          <div className="panel-head">
            <h3>Top Peers</h3>
            <span className="panel-count">{ovPeersCount}</span>
          </div>
          <div className="table-wrap compact">
            <table className="table">
              <thead>
                <tr>
                  <th>Peer</th>
                  <th>ID</th>
                  <th>Services</th>
                  <th>Rep</th>
                </tr>
              </thead>
              <tbody>
                {topPeersByReputation.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty">
                      No peers yet.
                    </td>
                  </tr>
                ) : (
                  topPeersByReputation.map((peer) => (
                    <tr key={peer.peerId}>
                      <td>{peer.displayName || '-'}</td>
                      <td title={peer.peerId}>{formatShortId(peer.peerId)}</td>
                      <td>{formatInt(peer.services.length)}</td>
                      <td>{formatReputationScore(getPeerReputationScore(peer, reputationScoresByPeerId))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </section>
  );
}

import { useMemo } from 'react';
import { getPeerServices, type Peer } from '../api';
import { formatLargeNumber, PeerSigil, shortPeerId } from '../utils';

const PEER_TABLE_SERVICE_LIMIT = 3;

function PeerCell({ peer }: { peer: Peer }) {
  const id = shortPeerId(peer.peerId);
  const agentId = peer.onChainStats?.agentId;
  const region = peer.region && peer.region.toLowerCase() !== 'unknown' ? peer.region : null;

  const tags: string[] = [];
  if (agentId != null && agentId > 0) tags.push(`agent #${agentId}`);
  if (region) tags.push(region);

  const idMark = (
    <>
      {id.head}
      {id.tail && (
        <>
          <span className="dim">…</span>
          {id.tail}
        </>
      )}
    </>
  );

  return (
    <div className="peer-cell">
      <PeerSigil id={peer.peerId} />
      <div className="peer-cell-text">
        {peer.displayName ? (
          <>
            <span className="peer-cell-name">{peer.displayName}</span>
            <span className="peer-cell-meta">
              <span className="peer-cell-id">{idMark}</span>
              {tags.map((t) => (
                <span key={t} className="peer-cell-meta-pill">
                  {t}
                </span>
              ))}
            </span>
          </>
        ) : (
          <>
            <span className="peer-cell-name peer-cell-name--id">{idMark}</span>
            {tags.length > 0 && (
              <span className="peer-cell-meta">
                {tags.map((t) => (
                  <span key={t} className="peer-cell-meta-pill">
                    {t}
                  </span>
                ))}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function PeersTable({
  peers,
  onOpenServices,
  onNavigatePeer,
}: {
  peers: Peer[];
  onOpenServices: (peer: Peer, services: string[]) => void;
  onNavigatePeer: (peerId: string) => void;
}) {
  const sortedPeers = useMemo(() => {
    return [...peers].sort((a, b) => {
      const aReq = BigInt(a.onChainStats?.totalRequests ?? '0');
      const bReq = BigInt(b.onChainStats?.totalRequests ?? '0');
      if (aReq !== bReq) return aReq > bReq ? -1 : 1;
      const aSvc = getPeerServices(a).length;
      const bSvc = getPeerServices(b).length;
      if (aSvc !== bSvc) return bSvc - aSvc;
      return a.peerId.localeCompare(b.peerId);
    });
  }, [peers]);

  return (
    <div className="table-wrap">
      <table className="peer-table">
        <thead>
          <tr>
            <th>Peer</th>
            <th>Services</th>
            <th>Requests</th>
            <th>Input tokens</th>
            <th>Output tokens</th>
            <th>Buyers</th>
          </tr>
        </thead>
        <tbody>
          {sortedPeers.map((p) => {
            const services = getPeerServices(p);
            const visibleServices = services.slice(0, PEER_TABLE_SERVICE_LIMIT);
            const hiddenServiceCount = Math.max(
              0,
              services.length - PEER_TABLE_SERVICE_LIMIT,
            );
            const stats = p.onChainStats;
            return (
              <tr
                key={p.peerId}
                className="peer-row"
                tabIndex={0}
                role="link"
                onClick={() => onNavigatePeer(p.peerId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onNavigatePeer(p.peerId);
                  }
                }}
              >
                <td>
                  <PeerCell peer={p} />
                </td>
                <td>
                  {services.length === 0 ? (
                    <span className="em-dash">—</span>
                  ) : (
                    <span className="svc-tags svc-tags--table">
                      {visibleServices.map((s) => (
                        <span key={s} className="svc-tag">
                          {s}
                        </span>
                      ))}
                      {hiddenServiceCount > 0 && (
                        <button
                          type="button"
                          className="svc-more"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenServices(p, services);
                          }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                          }}
                        >
                          Show {hiddenServiceCount} more
                        </button>
                      )}
                    </span>
                  )}
                </td>
                <td className="num">
                  {stats ? formatLargeNumber(stats.totalRequests) : <span className="em-dash">—</span>}
                </td>
                <td className="num">
                  {stats ? formatLargeNumber(stats.totalInputTokens) : <span className="em-dash">—</span>}
                </td>
                <td className="num">
                  {stats ? formatLargeNumber(stats.totalOutputTokens) : <span className="em-dash">—</span>}
                </td>
                <td className="num">
                  {stats ? formatLargeNumber(stats.uniqueBuyers) : <span className="em-dash">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

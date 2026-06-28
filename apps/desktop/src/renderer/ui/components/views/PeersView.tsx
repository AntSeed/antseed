import { useMemo, useCallback } from 'react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useRetainedState } from '../../hooks/useRetainedState';
import { formatShortId, formatInt, formatEndpoint } from '../../../core/format';
import {
  buildPeerReputationScoreMap,
  formatReputationScore,
  getPeerReputationScore,
} from '../../../core/peer-utils';
import { safeString } from '../../../core/safe';
import type { PeerEntry, SortDirection } from '../../../core/state';

type PeersViewProps = {
  active: boolean;
};

type SortKey = string;

function sortPeers(
  items: PeerEntry[],
  key: SortKey,
  dir: SortDirection,
  reputationScoresByPeerId: ReadonlyMap<string, number>,
): PeerEntry[] {
  return [...items].sort((a, b) => {
    let va: unknown = (a as Record<string, unknown>)[key];
    let vb: unknown = (b as Record<string, unknown>)[key];
    if (key === 'services') {
      va = a.services.length;
      vb = b.services.length;
    } else if (key === 'reputation') {
      va = getPeerReputationScore(a, reputationScoresByPeerId) ?? -1;
      vb = getPeerReputationScore(b, reputationScoresByPeerId) ?? -1;
    }
    if (Array.isArray(va)) va = (va as string[]).join(', ');
    if (Array.isArray(vb)) vb = (vb as string[]).join(', ');
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va == null) va = '';
    if (vb == null) vb = '';
    if ((va as string | number) < (vb as string | number)) return dir === 'asc' ? -1 : 1;
    if ((va as string | number) > (vb as string | number)) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function filterPeers(
  peers: PeerEntry[],
  filterText: string,
  reputationScoresByPeerId: ReadonlyMap<string, number>,
): PeerEntry[] {
  if (!filterText) return peers;
  const lower = filterText.toLowerCase();
  return peers.filter((peer) => {
    const searchable = [
      peer.peerId,
      safeString(peer.source, ''),
      peer.services.join(' '),
      String(peer.inputUsdPerMillion),
      String(peer.outputUsdPerMillion),
      String(peer.capacityMsgPerHour),
      formatReputationScore(getPeerReputationScore(peer, reputationScoresByPeerId)),
      formatEndpoint(peer),
    ]
      .join(' ')
      .toLowerCase();
    return searchable.includes(lower);
  });
}

const COLUMNS: { key: string; label: string; sortable: boolean }[] = [
  { key: 'online', label: 'Status', sortable: true },
  { key: 'displayName', label: 'Peer', sortable: true },
  { key: 'peerId', label: 'ID', sortable: true },
  { key: 'source', label: 'Source', sortable: true },
  { key: 'services', label: 'Services', sortable: true },
  { key: 'inputUsdPerMillion', label: 'Input $/1M', sortable: true },
  { key: 'outputUsdPerMillion', label: 'Output $/1M', sortable: true },
  { key: 'capacityMsgPerHour', label: 'Capacity', sortable: true },
  { key: 'reputation', label: 'Rep', sortable: true },
  { key: 'endpoint', label: 'Endpoint', sortable: false },
];

// Renderer-lifetime cache: table controls survive lazy page unmounts.
const peersViewCache = {
  sortKey: 'reputation',
  sortDir: 'desc' as SortDirection,
  filter: '',
};

export function PeersView({ active }: PeersViewProps) {
  const { lastPeers, peersMessage, discoverRows } = useUiSelector((state) => ({
    lastPeers: state.lastPeers,
    peersMessage: state.peersMessage,
    discoverRows: state.discoverRows,
  }), shallowEqual);
  const actions = useActions();

  const [sortKey, setSortKey] = useRetainedState(peersViewCache, 'sortKey');
  const [sortDir, setSortDir] = useRetainedState(peersViewCache, 'sortDir');
  const [filter, setFilter] = useRetainedState(peersViewCache, 'filter');

  const handleSort = useCallback(
    (key: string) => {
      if (sortKey === key) {
        setSortDir((dir) => dir === 'asc' ? 'desc' : 'asc');
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [setSortDir, setSortKey, sortKey],
  );

  const reputationScoresByPeerId = useMemo(
    () => buildPeerReputationScoreMap(discoverRows),
    [discoverRows],
  );

  const displayPeers = useMemo(() => {
    const filtered = filterPeers(lastPeers, filter, reputationScoresByPeerId);
    return sortPeers(filtered, sortKey, sortDir, reputationScoresByPeerId);
  }, [lastPeers, filter, sortKey, sortDir, reputationScoresByPeerId]);

  return (
    <section className={`view${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>Peers</h2>
        <div className="page-header-right">
          <input
            type="text"
            className="filter-input"
            placeholder="Filter peers..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="secondary" onClick={() => void actions.scanDht()}>
            Scan DHT
          </button>
          {/* <div className={`connection-badge badge-${peersMeta.tone}`}>{peersMeta.label}</div> */}
        </div>
      </div>
      <div className="panel-grid">
        <div className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={
                        col.sortable
                          ? `sortable${sortKey === col.key ? (sortDir === 'asc' ? ' sort-asc' : ' sort-desc') : ''}`
                          : undefined
                      }
                      data-sort={col.sortable ? col.key : undefined}
                      onClick={col.sortable ? () => handleSort(col.key) : undefined}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayPeers.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="empty">
                      {lastPeers.length > 0 ? 'No peers match filter.' : 'No peers discovered yet.'}
                    </td>
                  </tr>
                ) : (
                  displayPeers.map((peer) => (
                    <tr key={peer.peerId}>
                      <td>
                        <span className={`peer-status ${peer.online ? 'online' : 'offline'}`}>
                          {peer.online ? 'Online' : 'Offline'}
                        </span>
                      </td>
                      <td>{peer.displayName || '-'}</td>
                      <td title={peer.peerId}>{formatShortId(peer.peerId)}</td>
                      <td>{safeString(peer.source, 'n/a').toUpperCase()}</td>
                      <td>{formatInt(peer.services.length)}</td>
                      <td>{String(peer.inputUsdPerMillion)}</td>
                      <td>{String(peer.outputUsdPerMillion)}</td>
                      <td>
                        {peer.capacityMsgPerHour > 0
                          ? `${formatInt(peer.capacityMsgPerHour)}/h`
                          : 'n/a'}
                      </td>
                      <td>{formatReputationScore(getPeerReputationScore(peer, reputationScoresByPeerId))}</td>
                      <td>{formatEndpoint(peer)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="message">{peersMessage}</p>
      </div>
    </section>
  );
}

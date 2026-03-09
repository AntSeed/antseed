import { useState, useMemo, useCallback } from 'react';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { formatShortId, formatInt, formatEndpoint } from '../../../core/format';
import { safeString } from '../../../core/safe';
import type { PeerEntry, SortDirection } from '../../../core/state';

type PeersViewProps = {
  active: boolean;
};

type SortKey = string;

function sortPeers(items: PeerEntry[], key: SortKey, dir: SortDirection): PeerEntry[] {
  return [...items].sort((a, b) => {
    let va: unknown = (a as Record<string, unknown>)[key];
    let vb: unknown = (b as Record<string, unknown>)[key];
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

function filterPeers(peers: PeerEntry[], filterText: string): PeerEntry[] {
  if (!filterText) return peers;
  const lower = filterText.toLowerCase();
  return peers.filter((peer) => {
    const searchable = [
      peer.peerId,
      safeString(peer.source, ''),
      peer.models.join(' '),
      String(peer.inputUsdPerMillion),
      String(peer.outputUsdPerMillion),
      String(peer.capacityMsgPerHour),
      String(peer.reputation),
      safeString(peer.location, ''),
      formatEndpoint(peer),
    ]
      .join(' ')
      .toLowerCase();
    return searchable.includes(lower);
  });
}

const COLUMNS: { key: string; label: string; sortable: boolean }[] = [
  { key: 'displayName', label: 'Peer', sortable: true },
  { key: 'peerId', label: 'ID', sortable: true },
  { key: 'source', label: 'Source', sortable: true },
  { key: 'models', label: 'Models', sortable: true },
  { key: 'inputUsdPerMillion', label: 'Input $/1M', sortable: true },
  { key: 'outputUsdPerMillion', label: 'Output $/1M', sortable: true },
  { key: 'capacityMsgPerHour', label: 'Capacity', sortable: true },
  { key: 'reputation', label: 'Rep', sortable: true },
  { key: 'location', label: 'Location', sortable: true },
  { key: 'endpoint', label: 'Endpoint', sortable: false },
];

export function PeersView({ active }: PeersViewProps) {
  const { lastPeers, peersMeta, peersMessage } = useUiSnapshot();
  const actions = useActions();

  const [sortKey, setSortKey] = useState('reputation');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [filter, setFilter] = useState('');

  const handleSort = useCallback(
    (key: string) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey],
  );

  const displayPeers = useMemo(() => {
    const filtered = filterPeers(lastPeers, filter);
    return sortPeers(filtered, sortKey, sortDir);
  }, [lastPeers, filter, sortKey, sortDir]);

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
                      <td>{peer.displayName || '-'}</td>
                      <td title={peer.peerId}>{formatShortId(peer.peerId)}</td>
                      <td>{safeString(peer.source, 'n/a').toUpperCase()}</td>
                      <td>{peer.models.join(', ')}</td>
                      <td>{String(peer.inputUsdPerMillion)}</td>
                      <td>{String(peer.outputUsdPerMillion)}</td>
                      <td>
                        {peer.capacityMsgPerHour > 0
                          ? `${formatInt(peer.capacityMsgPerHour)}/h`
                          : 'n/a'}
                      </td>
                      <td>{formatInt(peer.reputation)}</td>
                      <td>
                        {peer.location && peer.location.trim().length > 0 ? peer.location : '-'}
                      </td>
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

import { useState, useEffect, useCallback } from 'react';
import { fetchJson } from '../api';
import { truncateAddress } from '../utils/format';

interface PeerInfo {
  peerId: string;
  displayName: string | null;
  services: string[];
  capacityMsgPerHour: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  reputation: number;
}

interface PeersResponse {
  peers: PeerInfo[];
  total: number;
}

export function Network() {
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');

  const refresh = useCallback(() => {
    fetchJson<PeersResponse>('/api/peers')
      .then(data => { setPeers(data.peers); setTotal(data.total); })
      .catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);

  const filtered = peers.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      p.peerId.toLowerCase().includes(q) ||
      (p.displayName?.toLowerCase().includes(q) ?? false) ||
      p.services.some(s => s.toLowerCase().includes(q))
    );
  });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Network</h1>
        <div className="page-actions">
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{total} peers</span>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <input
          className="input-field"
          placeholder="Search peers..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Peer ID</th>
              <th>Name</th>
              <th>Services</th>
              <th>Capacity</th>
              <th>Input $/1M</th>
              <th>Output $/1M</th>
              <th>Reputation</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No peers found</td></tr>
            ) : filtered.map(p => (
              <tr key={p.peerId}>
                <td className="mono">{truncateAddress(p.peerId, 8)}</td>
                <td>{p.displayName || '--'}</td>
                <td>{p.services.length > 0 ? p.services.join(', ') : '--'}</td>
                <td>{p.capacityMsgPerHour > 0 ? `${p.capacityMsgPerHour}/hr` : '--'}</td>
                <td>${p.inputUsdPerMillion.toFixed(2)}</td>
                <td>${p.outputUsdPerMillion.toFixed(2)}</td>
                <td>{p.reputation > 0 ? p.reputation.toFixed(1) : '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

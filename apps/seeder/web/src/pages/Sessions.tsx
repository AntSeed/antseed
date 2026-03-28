import { useState, useEffect, useCallback } from 'react';
import { fetchJson } from '../api';
import { formatTokens, formatDuration, formatLatency, timeAgo } from '../utils/format';

interface SessionMetrics {
  sessionId: string;
  provider: string;
  startedAt: number;
  totalTokens: number;
  totalRequests: number;
  durationMs: number;
  avgLatencyMs: number;
  active: boolean;
}

interface SessionsResponse {
  sessions: SessionMetrics[];
  total: number;
}

export function Sessions() {
  const [sessions, setSessions] = useState<SessionMetrics[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>('all');

  const refresh = useCallback(() => {
    const params = filter !== 'all' ? `?status=${filter}` : '';
    fetchJson<SessionsResponse>(`/api/sessions${params}`)
      .then(data => { setSessions(data.sessions); setTotal(data.total); })
      .catch(() => {});
  }, [filter]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Sessions</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{total} total</span>
      </div>

      <div className="tabs">
        {(['all', 'active', 'closed'] as const).map(f => (
          <button key={f} className={`tab ${filter === f ? 'tab--active' : ''}`} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Session ID</th>
              <th>Provider</th>
              <th>Started</th>
              <th>Tokens</th>
              <th>Requests</th>
              <th>Duration</th>
              <th>Avg Latency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No sessions</td></tr>
            ) : sessions.map(s => (
              <tr key={s.sessionId}>
                <td className="mono">{s.sessionId.slice(0, 12)}...</td>
                <td>{s.provider}</td>
                <td>{timeAgo(s.startedAt)}</td>
                <td>{formatTokens(s.totalTokens)}</td>
                <td>{s.totalRequests}</td>
                <td>{formatDuration(s.durationMs)}</td>
                <td>{formatLatency(s.avgLatencyMs)}</td>
                <td>
                  <span className={`status-badge ${s.active ? 'status-badge--active' : ''}`}>
                    <span className="status-badge-dot" />
                    {s.active ? 'Active' : 'Closed'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

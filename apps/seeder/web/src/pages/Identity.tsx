import { useState, useEffect } from 'react';
import { fetchJson } from '../api';
import { truncateAddress, formatUSDC, formatTokens } from '../utils/format';

interface IdentityResponse {
  evmAddress: string;
  agentCount?: number;
  agentId?: string;
  stats?: {
    sessionCount: number;
    ghostCount: number;
    totalVolumeUsdc: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalLatencyMs: number;
    totalRequestCount: number;
    lastSettledAt: number;
  };
}

export function Identity() {
  const [data, setData] = useState<IdentityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<IdentityResponse>('/api/identity')
      .then(setData)
      .catch(err => setError(err.message));
  }, []);

  const stats = data?.stats;
  const ghostRatio = stats && stats.sessionCount > 0
    ? ((stats.ghostCount / stats.sessionCount) * 100).toFixed(1)
    : '0.0';

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Identity</h1>
      </div>

      {error && (
        <div className="status-msg status-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      <div className="card section">
        <div className="card-section-title">Wallet</div>
        {data ? (
          <div className="address">{data.evmAddress}</div>
        ) : (
          <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
        )}
      </div>

      <div className="two-col section">
        <div className="card">
          <div className="card-section-title">Agent</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Agent ID</span>
              <span style={{ fontWeight: 600 }}>{data?.agentId && data.agentId !== '0' ? `#${data.agentId}` : 'Not registered'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Agents Owned</span>
              <span style={{ fontWeight: 600 }}>{data?.agentCount ?? '--'}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-section-title">Reputation Risk</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Ghost Ratio</span>
              <span style={{ fontWeight: 600, color: parseFloat(ghostRatio) >= 30 ? 'var(--danger)' : 'var(--text-primary)' }}>
                {ghostRatio}%
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Ghosts / Sessions</span>
              <span style={{ fontWeight: 600 }}>{stats?.ghostCount ?? 0} / {stats?.sessionCount ?? 0}</span>
            </div>
          </div>
        </div>
      </div>

      {stats && (
        <div className="card section">
          <div className="card-section-title">On-Chain Stats</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Total Volume</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatUSDC(stats.totalVolumeUsdc)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Total Tokens</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatTokens(stats.totalInputTokens + stats.totalOutputTokens)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Total Requests</div>
              <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatTokens(stats.totalRequestCount)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

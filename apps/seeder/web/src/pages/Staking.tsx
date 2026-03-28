import { useState, useEffect, useCallback } from 'react';
import { fetchJson } from '../api';
import { formatUSDC } from '../utils/format';

interface StakeResponse {
  stake: string;
  stakedAt: number;
  isAboveMin: boolean;
  agentId: string;
  activeSessions: number;
}

export function Staking() {
  const [data, setData] = useState<StakeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stakeAmount, setStakeAmount] = useState('');
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(false);
  const [txResult, setTxResult] = useState<{ ok: boolean; txHash?: string; error?: string } | null>(null);

  const refresh = useCallback(() => {
    fetchJson<StakeResponse>('/api/stake').then(setData).catch(err => setError(err.message));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleStake = async () => {
    setLoading(true);
    setTxResult(null);
    try {
      const result = await fetchJson<{ ok: boolean; txHash?: string; error?: string }>('/api/stake', {
        method: 'POST',
        body: JSON.stringify({ amount: stakeAmount, agentId }),
      });
      setTxResult(result);
      if (result.ok) { setStakeAmount(''); refresh(); }
    } catch (err) {
      setTxResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  };

  const handleUnstake = async () => {
    if (!confirm('Are you sure you want to unstake? Slashing may apply based on your ghost ratio.')) return;
    setLoading(true);
    setTxResult(null);
    try {
      const result = await fetchJson<{ ok: boolean; txHash?: string; error?: string }>('/api/unstake', { method: 'POST' });
      setTxResult(result);
      if (result.ok) refresh();
    } catch (err) {
      setTxResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  };

  const stakedAt = data?.stakedAt ? new Date(data.stakedAt * 1000).toLocaleDateString() : '--';

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Staking</h1>
      </div>

      {error && <div className="status-msg status-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Current stake info */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat-card">
          <span className="stat-card-label">Current Stake</span>
          <span className="stat-card-value stat-card-value--accent">{data ? formatUSDC(data.stake) : '--'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Min. Stake Met</span>
          <span className={`stat-card-value ${data?.isAboveMin ? 'stat-card-value--accent' : 'stat-card-value--danger'}`}>
            {data ? (data.isAboveMin ? 'Yes' : 'No') : '--'}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Agent ID</span>
          <span className="stat-card-value">{data?.agentId && data.agentId !== '0' ? `#${data.agentId}` : '--'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Active Sessions</span>
          <span className="stat-card-value">{data?.activeSessions ?? '--'}</span>
          {data && data.activeSessions > 0 && (
            <span className="stat-card-hint" style={{ color: 'var(--amber)' }}>Cannot unstake while active</span>
          )}
        </div>
      </div>

      <div className="two-col">
        {/* Stake form */}
        <div className="card">
          <div className="card-section-title">Stake USDC</div>
          <div className="input-group">
            <label className="input-label">Amount (USDC)</label>
            <input
              className="input-field"
              type="number"
              placeholder="100.00"
              value={stakeAmount}
              onChange={e => setStakeAmount(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label className="input-label">Agent ID</label>
            <input
              className="input-field"
              type="number"
              placeholder="Your ERC-8004 agent ID"
              value={agentId || data?.agentId || ''}
              onChange={e => setAgentId(e.target.value)}
            />
            <div className="hint">Your registered ERC-8004 agent NFT ID</div>
          </div>
          <button
            className="btn-primary"
            onClick={handleStake}
            disabled={loading || !stakeAmount || !(agentId || data?.agentId)}
          >
            {loading ? 'Processing...' : 'Approve & Stake'}
          </button>
        </div>

        {/* Unstake */}
        <div className="card">
          <div className="card-section-title">Unstake</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
            Withdraw your staked USDC. Slashing may apply based on your ghost ratio and inactivity period. You cannot unstake while sessions are active.
          </p>
          {data && data.activeSessions > 0 && (
            <div className="warning-banner">
              {data.activeSessions} active session{data.activeSessions > 1 ? 's' : ''} — unstake blocked
            </div>
          )}
          <button
            className="btn-danger"
            onClick={handleUnstake}
            disabled={loading || (data?.activeSessions ?? 0) > 0 || !data || parseFloat(data.stake) === 0}
          >
            Unstake
          </button>
          {data && (
            <div className="hint" style={{ marginTop: 8 }}>Staked since: {stakedAt}</div>
          )}
        </div>
      </div>

      {txResult && (
        <div className={`status-msg ${txResult.ok ? 'status-success' : 'status-error'}`} style={{ marginTop: 16 }}>
          {txResult.ok ? `Transaction: ${txResult.txHash}` : `Error: ${txResult.error}`}
        </div>
      )}
    </div>
  );
}

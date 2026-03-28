import { useState, useEffect } from 'react';
import { fetchJson } from '../api';
import { formatUSDC, formatTokens } from '../utils/format';

interface StatusResponse {
  state: string;
  peerCount: number;
  earningsToday: string;
  tokensToday: number;
  activeSessions: number;
  uptime: string;
  walletAddress: string | null;
  capacityUsedPercent: number;
  daemonAlive: boolean;
}

interface StakeResponse {
  stake: string;
  isAboveMin: boolean;
  agentId: string;
  activeSessions: number;
}

interface EarningsResponse {
  pendingUsdc: string;
  pendingAnts: { seller: string; buyer: string } | null;
  today: string;
  thisWeek: string;
  thisMonth: string;
}

interface OverviewProps {
  status: StatusResponse | null;
}

export function Overview({ status }: OverviewProps) {
  const [stake, setStake] = useState<StakeResponse | null>(null);
  const [earnings, setEarnings] = useState<EarningsResponse | null>(null);

  useEffect(() => {
    fetchJson<StakeResponse>('/api/stake').then(setStake).catch(() => {});
    fetchJson<EarningsResponse>('/api/earnings').then(setEarnings).catch(() => {});
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Overview</h1>
        {status && (
          <span className={`status-badge ${status.state !== 'idle' ? 'status-badge--active' : 'status-badge--idle'}`}>
            <span className="status-badge-dot" />
            {status.state === 'seeding' ? 'Seeding' : status.state === 'connected' ? 'Connected' : 'Offline'}
          </span>
        )}
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-card-label">Active Sessions</span>
          <span className="stat-card-value">{status?.activeSessions ?? 0}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Peers</span>
          <span className="stat-card-value">{status?.peerCount ?? 0}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Uptime</span>
          <span className="stat-card-value">{status?.uptime ?? '0s'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Stake</span>
          <span className="stat-card-value stat-card-value--accent">
            {stake ? formatUSDC(stake.stake) : '--'}
          </span>
          {stake && !stake.isAboveMin && (
            <span className="stat-card-hint" style={{ color: 'var(--danger)' }}>Below minimum</span>
          )}
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Pending Earnings</span>
          <span className="stat-card-value stat-card-value--accent">
            {earnings ? formatUSDC(earnings.pendingUsdc) : '--'}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Earnings Today</span>
          <span className="stat-card-value">
            {earnings ? formatUSDC(earnings.today) : '--'}
          </span>
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-section-title">Earnings Summary</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Today</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatUSDC(earnings?.today ?? '0')}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>This Week</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatUSDC(earnings?.thisWeek ?? '0')}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>This Month</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatUSDC(earnings?.thisMonth ?? '0')}</span>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-section-title">Node Info</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Tokens Today</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatTokens(status?.tokensToday ?? 0)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Capacity Used</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{status?.capacityUsedPercent ?? 0}%</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Agent ID</span>
              <span className="mono" style={{ fontWeight: 500 }}>{stake?.agentId && stake.agentId !== '0' ? `#${stake.agentId}` : '--'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

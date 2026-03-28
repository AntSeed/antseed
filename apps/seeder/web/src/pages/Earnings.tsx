import { useState, useEffect, useCallback } from 'react';
import { fetchJson } from '../api';
import { formatUSDC } from '../utils/format';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

interface EarningsResponse {
  pendingUsdc: string;
  pendingAnts: { seller: string; buyer: string } | null;
  today: string;
  thisWeek: string;
  thisMonth: string;
  daily: { date: string; amount: string }[];
  byProvider: { provider: string; amount: string }[];
}

const PIE_COLORS = ['#1fd87a', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export function Earnings() {
  const [data, setData] = useState<EarningsResponse | null>(null);
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('month');
  const [claimLoading, setClaimLoading] = useState<string | null>(null);
  const [txResult, setTxResult] = useState<{ ok: boolean; txHash?: string; error?: string } | null>(null);

  const refresh = useCallback(() => {
    fetchJson<EarningsResponse>(`/api/earnings?period=${period}`).then(setData).catch(() => {});
  }, [period]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleClaim = async (type: 'earnings' | 'emissions') => {
    setClaimLoading(type);
    setTxResult(null);
    try {
      const endpoint = type === 'earnings' ? '/api/claim-earnings' : '/api/claim-emissions';
      const result = await fetchJson<{ ok: boolean; txHash?: string; error?: string }>(endpoint, { method: 'POST' });
      setTxResult(result);
      if (result.ok) refresh();
    } catch (err) {
      setTxResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setClaimLoading(null);
    }
  };

  const chartData = (data?.daily ?? []).map(d => ({ date: d.date.slice(5), amount: parseFloat(d.amount) }));
  const pieData = (data?.byProvider ?? []).filter(p => parseFloat(p.amount) > 0);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Earnings</h1>
        <div className="page-actions">
          <div className="tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
            {(['day', 'week', 'month'] as const).map(p => (
              <button key={p} className={`tab ${period === p ? 'tab--active' : ''}`} onClick={() => setPeriod(p)}>
                {p === 'day' ? '24h' : p === 'week' ? '7d' : '30d'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Claim cards */}
      <div className="two-col section">
        <div className="card">
          <div className="card-section-title">Pending USDC Earnings</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent-text)', marginBottom: 16, fontVariantNumeric: 'tabular-nums' }}>
            {data ? formatUSDC(data.pendingUsdc) : '--'}
          </div>
          <button
            className="btn-primary"
            onClick={() => handleClaim('earnings')}
            disabled={claimLoading !== null || !data || parseFloat(data.pendingUsdc) === 0}
          >
            {claimLoading === 'earnings' ? 'Claiming...' : 'Claim USDC'}
          </button>
        </div>
        <div className="card">
          <div className="card-section-title">Pending ANTS Emissions</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent-text)', marginBottom: 16, fontVariantNumeric: 'tabular-nums' }}>
            {data?.pendingAnts ? `${BigInt(data.pendingAnts.seller).toString()} ANTS` : '--'}
          </div>
          <button
            className="btn-primary"
            onClick={() => handleClaim('emissions')}
            disabled={claimLoading !== null || !data?.pendingAnts}
          >
            {claimLoading === 'emissions' ? 'Claiming...' : 'Claim ANTS'}
          </button>
        </div>
      </div>

      {/* Metering summary */}
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-card-label">Today</span>
          <span className="stat-card-value">{formatUSDC(data?.today ?? '0')}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">This Week</span>
          <span className="stat-card-value">{formatUSDC(data?.thisWeek ?? '0')}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">This Month</span>
          <span className="stat-card-value">{formatUSDC(data?.thisMonth ?? '0')}</span>
        </div>
      </div>

      {/* Charts */}
      <div className="two-col section">
        <div className="card">
          <div className="card-section-title">Earnings Over Time</div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={50} />
                <Tooltip contentStyle={{ background: 'var(--box-bg)', border: '1px solid var(--card-border)', borderRadius: 8, fontSize: 13 }} />
                <Line type="monotone" dataKey="amount" stroke="#1fd87a" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ color: 'var(--text-muted)', padding: '40px 0', textAlign: 'center' }}>No data yet</div>
          )}
        </div>
        <div className="card">
          <div className="card-section-title">By Provider</div>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} dataKey="amount" nameKey="provider" cx="50%" cy="50%" outerRadius={70} label={({ provider }) => provider}>
                  {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: 'var(--box-bg)', border: '1px solid var(--card-border)', borderRadius: 8, fontSize: 13 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ color: 'var(--text-muted)', padding: '40px 0', textAlign: 'center' }}>No data yet</div>
          )}
        </div>
      </div>

      {txResult && (
        <div className={`status-msg ${txResult.ok ? 'status-success' : 'status-error'}`}>
          {txResult.ok ? `Transaction: ${txResult.txHash}` : `Error: ${txResult.error}`}
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { EarningsResponse } from './api-types';
import { debugError } from '../utils/debug';

type Period = 'day' | 'week' | 'month';

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#e94560',
  openai: '#00c853',
  google: '#4285f4',
  moonshot: '#ffd600',
};

export function Earnings() {
  const [earnings, setEarnings] = useState<EarningsResponse | null>(null);
  const [period, setPeriod] = useState<Period>('month');

  useEffect(() => {
    fetch(`/api/earnings?period=${period}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setEarnings)
      .catch(debugError);
  }, [period]);

  if (!earnings) return <div className="loading">Loading...</div>;

  const lineData = earnings.daily.map((d) => ({
    date: d.date,
    amount: parseFloat(d.amount),
  }));

  const pieData = earnings.byProvider.map((p) => ({
    name: p.provider,
    value: parseFloat(p.amount),
  }));

  return (
    <div className="earnings-page">
      <div className="page-header">
        <h2>Earnings</h2>
        <div className="period-toggle">
          {(['day', 'week', 'month'] as Period[]).map((p) => (
            <button
              key={p}
              className={`toggle-btn ${period === p ? 'active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="earnings-summary">
        <div className="stat-card">
          <div className="stat-label">Today</div>
          <div className="stat-value" style={{ color: 'var(--accent-green)' }}>
            ${parseFloat(earnings.today).toFixed(2)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">This Week</div>
          <div className="stat-value">${parseFloat(earnings.thisWeek).toFixed(2)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">This Month</div>
          <div className="stat-value">${parseFloat(earnings.thisMonth).toFixed(2)}</div>
        </div>
      </div>

      {/* Line chart: earnings over time */}
      <div className="chart-section">
        <h3>Earnings Over Time</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={lineData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" stroke="var(--text-secondary)" fontSize={11} />
            <YAxis stroke="var(--text-secondary)" fontSize={11} tickFormatter={(v) => `$${v}`} />
            <Tooltip
              contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              labelStyle={{ color: 'var(--text-primary)' }}
              formatter={(value: number) => [`$${value.toFixed(2)}`, 'Earnings']}
            />
            <Line type="monotone" dataKey="amount" stroke="var(--accent-green)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Pie chart: per-provider breakdown */}
      <div className="chart-section">
        <h3>By Provider</h3>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              outerRadius={100}
              dataKey="value"
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
            >
              {pieData.map((entry) => (
                <Cell key={entry.name} fill={PROVIDER_COLORS[entry.name] ?? '#888'} />
              ))}
            </Pie>
            <Tooltip formatter={(value: number) => [`$${value.toFixed(2)}`, 'Earnings']} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

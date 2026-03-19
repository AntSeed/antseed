import React, { useEffect, useState, useCallback } from 'react';
import { StatusResponse, EarningsResponse, NetworkResponse, NetworkPeer } from './api-types';
import { PeerInfo } from './shared-types';
import { useWebSocket, type WsEvent } from '../hooks/useWebSocket';
import { debugError } from '../utils/debug';

const REFRESH_INTERVAL = 5000;

function getCapacityColor(percent: number): string {
  if (percent > 80) {
    return 'var(--accent)';
  }
  if (percent > 50) {
    return 'var(--accent-yellow)';
  }
  return 'var(--accent-green)';
}

interface StatCardProps {
  label: string;
  value: string;
  color?: string;
  sub?: string;
  icon?: React.ReactNode;
}

function StatCard({ label, value, color, sub, icon }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="stat-card-header">
        <div className="stat-label">{label}</div>
        {icon && <div className="stat-icon">{icon}</div>}
      </div>
      <div className="stat-value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function ConnectionBadge({ state, daemonAlive }: { state: string; daemonAlive: boolean }) {
  const isActive = state === 'seeding' || state === 'connected';
  return (
    <div className={`connection-badge ${isActive ? 'badge-active' : 'badge-idle'}`}>
      <span className={`dot ${daemonAlive ? 'dot-active' : 'dot-idle'}`} />
      <span className="connection-label">{state.toUpperCase()}</span>
    </div>
  );
}

function CapacityRing({ percent }: { percent: number }) {
  const r = 40;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;
  const color = getCapacityColor(percent);

  return (
    <div className="capacity-ring">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
        <circle
          cx="50" cy="50" r={r} fill="none"
          stroke={color} strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <div className="capacity-ring-label">
        <div className="capacity-ring-value" style={{ color }}>{percent}%</div>
        <div className="capacity-ring-text">capacity</div>
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source?: 'daemon' | 'dht' }) {
  if (!source) return null;
  const cls = source === 'daemon' ? 'source-badge-daemon' : 'source-badge-dht';
  return <span className={`source-badge ${cls}`}>{source.toUpperCase()}</span>;
}

function PeerRow({ peer, isSelf }: { peer: PeerInfo; isSelf: boolean }) {
  return (
    <div className={`peer-row ${isSelf ? 'peer-self' : ''}`}>
      <div className="peer-row-id">
        <span className={`dot-sm ${isSelf ? 'dot-active' : 'dot-peer'}`} />
        <span className="mono">{peer.peerId.slice(0, 12)}...</span>
        {isSelf && <span className="peer-badge-you">YOU</span>}
        <SourceBadge source={peer.source} />
      </div>
      <div className="peer-row-providers">
        {peer.providers.map((p) => (
          <span key={p} className={`provider-chip provider-${p}`}>{p}</span>
        ))}
      </div>
      <div className="peer-row-rep">
        {isSelf ? '-' : `${Math.round(peer.reputation)}%`}
      </div>
    </div>
  );
}

function MiniChart({ data }: { data: { date: string; amount: number }[] }) {
  if (data.length === 0) {
    return <div className="mini-chart-empty">No earnings data yet</div>;
  }
  const max = Math.max(...data.map((d) => d.amount), 0.01);
  const barWidth = Math.max(4, Math.floor((100 - data.length) / data.length));

  return (
    <div className="mini-chart">
      <div className="mini-chart-bars">
        {data.slice(-14).map((d, i) => (
          <div key={i} className="mini-chart-bar-group" title={`${d.date}: $${d.amount.toFixed(2)}`}>
            <div
              className="mini-chart-bar"
              style={{
                height: `${Math.max(2, (d.amount / max) * 60)}px`,
                width: `${barWidth}px`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mini-chart-labels">
        <span>{data[data.length - Math.min(14, data.length)]?.date.slice(5)}</span>
        <span>{data[data.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

export function Overview() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [network, setNetwork] = useState<NetworkResponse | null>(null);
  const [earnings, setEarnings] = useState<EarningsResponse | null>(null);

  const fetchAll = useCallback(() => {
    fetch('/api/status').then((r) => { if (r.ok) return r.json(); }).then((d) => { if (d) setStatus(d); }).catch(debugError);
    fetch('/api/network').then((r) => { if (r.ok) return r.json(); }).then((d) => { if (d) setNetwork(d); }).catch(debugError);
    fetch('/api/earnings?period=month').then((r) => { if (r.ok) return r.json(); }).then((d) => { if (d) setEarnings(d); }).catch(debugError);
  }, []);

  useWebSocket({
    network_peers_updated: (event: WsEvent) => {
      const peers = (event.data as NetworkPeer[]) ?? [];
      setNetwork((prev) => ({
        peers,
        stats: prev?.stats ?? {
          totalPeers: peers.length,
          dhtNodeCount: 0,
          dhtHealthy: false,
          lastScanAt: event.timestamp,
        },
      }));
    },
  });

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (!status) return <div className="loading"><div className="loading-spinner" /><span>Loading dashboard...</span></div>;

  const chartData = (earnings?.daily ?? []).map((d) => ({ date: d.date, amount: parseFloat(d.amount) }));
  const capacityPercent = status.capacityUsedPercent ?? 0;
  const peers: PeerInfo[] = (network?.peers ?? []).map((p) => ({
    peerId: p.peerId,
    providers: p.providers,
    capacityMsgPerHour: p.capacityMsgPerHour,
    inputUsdPerMillion: p.inputUsdPerMillion,
    outputUsdPerMillion: p.outputUsdPerMillion,
    reputation: p.reputation,
    location: null,
    source: p.source,
  }));
  const stats = network?.stats;

  return (
    <div className="overview-page">
      <div className="page-header">
        <h2>Overview</h2>
        <ConnectionBadge state={status.state} daemonAlive={status.daemonAlive} />
      </div>

      {/* Top stats row */}
      <div className="stat-grid">
        <StatCard
          label="Active Peers"
          value={String(status.peerCount)}
          color="var(--accent)"
          sub={`${peers.length} in network`}
        />
        <StatCard
          label="Earnings Today"
          value={`$${parseFloat(status.earningsToday).toFixed(2)}`}
          color="var(--accent-green)"
          sub={earnings ? `$${parseFloat(earnings.thisMonth).toFixed(2)} this month` : undefined}
        />
        <StatCard
          label="Tokens Today"
          value={formatTokens(status.tokensToday)}
        />
        <StatCard label="Uptime" value={status.uptime} />
        <StatCard
          label="Active Sessions"
          value={String(status.activeSessions)}
        />
        <StatCard
          label="Wallet"
          value={status.walletAddress ? truncateAddress(status.walletAddress) : 'Not configured'}
          sub={status.walletAddress ? 'ETH' : undefined}
        />
      </div>

      {/* Two-column detail section */}
      <div className="overview-detail-grid">
        {/* Left: Capacity + Earnings chart */}
        <div className="overview-panel">
          <div className="panel-header">
            <h3>Capacity & Earnings</h3>
          </div>
          <div className="capacity-section">
            <CapacityRing percent={capacityPercent} />
            <div className="capacity-meta">
              <div className="capacity-row">
                <span className="capacity-label">Proxy Port</span>
                <span className="capacity-val mono">{status.proxyPort ?? '-'}</span>
              </div>
              <div className="capacity-row">
                <span className="capacity-label">Sessions</span>
                <span className="capacity-val">{status.activeSessions}</span>
              </div>
              <div className="capacity-row">
                <span className="capacity-label">Peers</span>
                <span className="capacity-val">{status.peerCount}</span>
              </div>
              <div className="capacity-row">
                <span className="capacity-label">DHT Nodes</span>
                <span className="capacity-val">{stats?.dhtNodeCount ?? 0}</span>
              </div>
            </div>
          </div>
          <div className="panel-divider" />
          <div className="panel-header"><h3>Recent Earnings</h3></div>
          <MiniChart data={chartData} />
        </div>

        {/* Right: Network peers */}
        <div className="overview-panel">
          <div className="panel-header">
            <h3>Network Peers</h3>
            <span className="panel-count">{peers.length}</span>
          </div>
          <div className="peer-list">
            {peers.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                </div>
                <div className="empty-text">No peers connected</div>
                <div className="empty-hint">Start seeding to join the network</div>
              </div>
            ) : (
              <>
                <div className="peer-list-header">
                  <span>Peer ID</span>
                  <span>Providers</span>
                  <span>Rep</span>
                </div>
                {peers.map((peer, i) => (
                  <PeerRow key={peer.peerId} peer={peer} isSelf={i === 0} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

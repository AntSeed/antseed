import { useQuery } from '@tanstack/react-query';
import { fetchStats } from './api';

function formatLargeNumber(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString();
}

function formatDate(value: string | number | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime()) || d.getTime() === 0) return '—';
  return d.toLocaleString();
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export function App() {
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
  });

  return (
    <div className="container">
      <header className="header">
        <div>
          <h1>AntSeed Network Stats</h1>
          <div className="muted">Live observation of the AntSeed peer network</div>
        </div>
        <div className="header-meta">
          <div className="muted">Last updated: {data ? formatDate(data.updatedAt) : '—'}</div>
          {isFetching && <div className="muted small">refreshing…</div>}
        </div>
      </header>

      {isLoading && <div className="status">Loading…</div>}
      {error && <div className="status error">Error: {(error as Error).message}</div>}

      {data && (
        <>
          <section className="cards">
            <StatCard label="Active peers" value={String(data.peers.length)} />
            {data.totals && (
              <>
                <StatCard label="Total requests" value={formatLargeNumber(data.totals.totalRequests)} />
                <StatCard label="Input tokens" value={formatLargeNumber(data.totals.totalInputTokens)} />
                <StatCard label="Output tokens" value={formatLargeNumber(data.totals.totalOutputTokens)} />
                <StatCard label="Settlements" value={formatLargeNumber(data.totals.settlementCount)} />
                <StatCard label="Sellers on-chain" value={formatLargeNumber(data.totals.sellerCount)} />
              </>
            )}
          </section>

          {data.indexer && (
            <section className="panel">
              <h2>Indexer</h2>
              <div className="row">
                <span>Chain: <code>{data.indexer.chainId}</code></span>
                <span>
                  Block: <code>
                    {data.indexer.lastBlock.toLocaleString()}
                    {data.indexer.latestBlock != null
                      ? ` / ${data.indexer.latestBlock.toLocaleString()}`
                      : ''}
                  </code>
                </span>
                <span>
                  Status: <code className={data.indexer.synced ? 'ok' : 'warn'}>
                    {data.indexer.synced ? 'synced' : 'syncing'}
                  </code>
                </span>
              </div>
            </section>
          )}

          <section>
            <h2>Peers ({data.peers.length})</h2>
            {data.peers.length === 0 ? (
              <div className="status muted">
                No peers discovered yet — DHT poll runs every 15 minutes after a 15s warmup.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="peer-table">
                  <thead>
                    <tr>
                      <th>Peer</th>
                      <th>Services</th>
                      <th>Requests</th>
                      <th>Input tokens</th>
                      <th>Output tokens</th>
                      <th>Buyers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.peers.map((p) => (
                      <tr key={p.peerId}>
                        <td><code>{p.peerId.slice(0, 16)}…</code></td>
                        <td>{(p.services ?? []).join(', ') || '—'}</td>
                        <td>{p.onChainStats ? formatLargeNumber(p.onChainStats.totalRequests) : '—'}</td>
                        <td>{p.onChainStats ? formatLargeNumber(p.onChainStats.totalInputTokens) : '—'}</td>
                        <td>{p.onChainStats ? formatLargeNumber(p.onChainStats.totalOutputTokens) : '—'}</td>
                        <td>{p.onChainStats ? formatLargeNumber(p.onChainStats.uniqueBuyers) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

import type { LeaderboardEntry, Leaderboards as LeaderboardsData } from '../api';
import { formatLargeNumber, formatUsd, PeerSigil, shortPeerId } from '../utils';

const HEX_LIKE = /^[0-9a-f]+$/i;

function isHexLike(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && HEX_LIKE.test(value);
}

function entryDisplayId(entry: LeaderboardEntry): string {
  if (entry.peerId) return entry.peerId;
  if (entry.agentId != null) return `agent-${entry.agentId}`;
  return 'unknown';
}

function EntryCell({ entry }: { entry: LeaderboardEntry }) {
  const id = entryDisplayId(entry);
  // PeerSigil is keyed off any string, but it works best with the actual peerId
  // so two boards that surface the same peer share a sigil.
  const sigilSeed = entry.peerId ?? id;
  const idMark = isHexLike(entry.peerId) ? shortPeerId(entry.peerId!) : null;
  const tags: string[] = [];
  if (entry.agentId != null) tags.push(`agent #${entry.agentId}`);
  if (entry.region && entry.region.toLowerCase() !== 'unknown') tags.push(entry.region);

  return (
    <div className="peer-cell">
      <PeerSigil id={sigilSeed} />
      <div className="peer-cell-text">
        {entry.displayName ? (
          <>
            <span className="peer-cell-name">{entry.displayName}</span>
            <span className="peer-cell-meta">
              {idMark && (
                <span className="peer-cell-id">
                  {idMark.head}
                  {idMark.tail && (
                    <>
                      <span className="dim">…</span>
                      {idMark.tail}
                    </>
                  )}
                </span>
              )}
              {tags.map((t) => (
                <span key={t} className="peer-cell-meta-pill">
                  {t}
                </span>
              ))}
            </span>
          </>
        ) : (
          <>
            <span className="peer-cell-name peer-cell-name--id">
              {idMark ? (
                <>
                  {idMark.head}
                  {idMark.tail && (
                    <>
                      <span className="dim">…</span>
                      {idMark.tail}
                    </>
                  )}
                </>
              ) : (
                id
              )}
            </span>
            {tags.length > 0 && (
              <span className="peer-cell-meta">
                {tags.map((t) => (
                  <span key={t} className="peer-cell-meta-pill">
                    {t}
                  </span>
                ))}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface BoardSpec {
  key: keyof LeaderboardsData;
  title: string;
  caption: string;
  metricLabel: string;
  secondaryLabel?: string;
  formatMetric: (value: string) => string;
  formatSecondary?: (value: number) => string;
}

const BOARDS: BoardSpec[] = [
  {
    key: 'mostActive',
    title: 'Most active',
    caption: 'Sellers ranked by total on-chain requests served.',
    metricLabel: 'Requests',
    secondaryLabel: 'Settlements',
    formatMetric: (v) => formatLargeNumber(v),
    formatSecondary: (v) => formatLargeNumber(v),
  },
  {
    key: 'mostSettlements',
    title: 'Most settlements',
    caption: 'Sellers with the largest count of payment-channel close events.',
    metricLabel: 'Settlements',
    secondaryLabel: 'Requests',
    formatMetric: (v) => formatLargeNumber(v),
    formatSecondary: (v) => formatLargeNumber(v),
  },
  {
    key: 'mostBuyers',
    title: 'Most buyers',
    caption: 'Sellers serving the largest distinct buyer counts.',
    metricLabel: 'Buyers',
    secondaryLabel: 'Requests',
    formatMetric: (v) => formatLargeNumber(v),
    formatSecondary: (v) => formatLargeNumber(v),
  },
  {
    key: 'mostStaked',
    title: 'Most staked',
    caption: 'Live peers ranked by USDC stake announced on the DHT.',
    metricLabel: 'Stake',
    formatMetric: (v) => formatUsd(Number(v)),
  },
  {
    key: 'mostDiverse',
    title: 'Most diverse',
    caption: 'Live peers offering the widest mix of services + categories.',
    metricLabel: 'Breadth',
    secondaryLabel: 'Services',
    formatMetric: (v) => formatLargeNumber(v),
    formatSecondary: (v) => formatLargeNumber(v),
  },
  {
    key: 'newest',
    title: 'Newest sellers',
    caption: 'Most recently observed for the first time on-chain.',
    metricLabel: 'First seen',
    secondaryLabel: 'Requests',
    formatMetric: formatTimestampDay,
    formatSecondary: (v) => formatLargeNumber(v),
  },
  {
    key: 'oldest',
    title: 'Oldest sellers',
    caption: 'Earliest indexed first-seen timestamp on-chain.',
    metricLabel: 'First seen',
    secondaryLabel: 'Requests',
    formatMetric: formatTimestampDay,
    formatSecondary: (v) => formatLargeNumber(v),
  },
  {
    key: 'trendingUp',
    title: 'Trending up',
    caption: 'Sellers whose 24h activity dwarfs their prior-7d daily average.',
    metricLabel: 'Ratio',
    secondaryLabel: '24h Δ',
    formatMetric: formatTrendRatio,
    formatSecondary: (v) => formatLargeNumber(v),
  },
  {
    key: 'trendingDown',
    title: 'Trending down',
    caption: 'Sellers whose 24h activity is shrinking relative to their prior-7d baseline.',
    metricLabel: 'Ratio',
    secondaryLabel: '24h Δ',
    formatMetric: formatTrendRatio,
    formatSecondary: (v) => formatLargeNumber(v),
  },
];

function formatTimestampDay(v: string): string {
  const ts = Number(v);
  if (!Number.isFinite(ts) || ts === 0) return '—';
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function formatTrendRatio(v: string): string {
  // The server emits 'new' as a sentinel for sellers with no prior-window
  // activity (Infinity ratio), and a 4-decimal float string otherwise.
  if (v === 'new') return 'new';
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}×`;
}

function LeaderboardCard({
  board,
  entries,
  onNavigatePeer,
}: {
  board: BoardSpec;
  entries: LeaderboardEntry[];
  onNavigatePeer: (peerId: string) => void;
}) {
  return (
    <div className="leaderboard-card">
      <div className="leaderboard-head">
        <span className="leaderboard-title">{board.title}</span>
        <span className="leaderboard-caption">{board.caption}</span>
      </div>
      {entries.length === 0 ? (
        <div className="leaderboard-empty">No data yet.</div>
      ) : (
        <table className="leaderboard-table">
          <thead>
            <tr>
              <th className="leaderboard-rank">#</th>
              <th>Peer</th>
              <th className="num">{board.metricLabel}</th>
              {board.secondaryLabel && <th className="num">{board.secondaryLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => {
              const clickable = entry.peerId != null;
              return (
                <tr
                  key={`${entry.peerId ?? entry.agentId ?? i}`}
                  className={`leaderboard-row${clickable ? ' is-clickable' : ''}`}
                  tabIndex={clickable ? 0 : -1}
                  // role="button" rather than "link": clickable rows behave
                  // like buttons (activate on Enter/Space, no URL semantics).
                  // role="link" would be a lie since we navigate via hash
                  // routing, not href, and the AT contract for link requires
                  // a URL relationship.
                  role={clickable ? 'button' : undefined}
                  onClick={() => clickable && onNavigatePeer(entry.peerId!)}
                  onKeyDown={(e) => {
                    if (clickable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onNavigatePeer(entry.peerId!);
                    }
                  }}
                >
                  <td className="leaderboard-rank">{i + 1}</td>
                  <td>
                    <EntryCell entry={entry} />
                  </td>
                  <td className="num">{board.formatMetric(entry.metric)}</td>
                  {board.secondaryLabel && (
                    <td className="num">
                      {entry.secondary != null && board.formatSecondary
                        ? board.formatSecondary(entry.secondary)
                        : <span className="em-dash">—</span>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Leaderboards({
  data,
  onNavigatePeer,
}: {
  data: LeaderboardsData;
  onNavigatePeer: (peerId: string) => void;
}) {
  return (
    <div className="leaderboard-grid">
      {BOARDS.map((board) => (
        <LeaderboardCard
          key={board.key}
          board={board}
          entries={data[board.key]}
          onNavigatePeer={onNavigatePeer}
        />
      ))}
    </div>
  );
}

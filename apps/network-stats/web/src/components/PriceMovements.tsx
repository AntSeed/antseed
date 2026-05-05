import type {
  PriceMoverEntry,
  PriceMovers,
  PriceStability,
  PriceStabilityEntry,
} from '../api';
import { PeerSigil, SectionHead, shortPeerId } from '../utils';

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function PeerCell({ peerId, displayName }: { peerId: string; displayName: string | null }) {
  const idMark = shortPeerId(peerId);
  return (
    <div className="peer-cell">
      <PeerSigil id={peerId} />
      <div className="peer-cell-text">
        {displayName ? (
          <>
            <span className="peer-cell-name">{displayName}</span>
            <span className="peer-cell-meta">
              <span className="peer-cell-id">
                {idMark.head}
                {idMark.tail && (
                  <>
                    <span className="dim">…</span>
                    {idMark.tail}
                  </>
                )}
              </span>
            </span>
          </>
        ) : (
          <span className="peer-cell-name peer-cell-name--id">
            {idMark.head}
            {idMark.tail && (
              <>
                <span className="dim">…</span>
                {idMark.tail}
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function StabilityCard({
  title,
  caption,
  entries,
  emptyHint,
}: {
  title: string;
  caption: string;
  entries: PriceStabilityEntry[];
  emptyHint: string;
}) {
  return (
    <div className="leaderboard-card">
      <div className="leaderboard-head">
        <span className="leaderboard-title">{title}</span>
        <span className="leaderboard-caption">{caption}</span>
      </div>
      {entries.length === 0 ? (
        <div className="leaderboard-empty">{emptyHint}</div>
      ) : (
        <table className="leaderboard-table">
          <thead>
            <tr>
              <th>Peer</th>
              <th>Service</th>
              <th className="num">Changes</th>
              <th className="num">Latest in/out</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={`${entry.peerId}/${entry.provider}/${entry.service}`} className="leaderboard-row">
                <td>
                  <PeerCell peerId={entry.peerId} displayName={entry.displayName} />
                </td>
                <td><span className="svc-tag">{entry.service}</span></td>
                <td className="num">
                  {entry.changeCount}
                  <span className="velocity-stat-aside"> · {entry.sampleCount} samples</span>
                </td>
                <td className="num">
                  {formatPrice(entry.latestInputUsdPerMillion)} / {formatPrice(entry.latestOutputUsdPerMillion)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MoverCard({
  title,
  caption,
  entries,
  emptyHint,
}: {
  title: string;
  caption: string;
  entries: PriceMoverEntry[];
  emptyHint: string;
}) {
  return (
    <div className="leaderboard-card">
      <div className="leaderboard-head">
        <span className="leaderboard-title">{title}</span>
        <span className="leaderboard-caption">{caption}</span>
      </div>
      {entries.length === 0 ? (
        <div className="leaderboard-empty">{emptyHint}</div>
      ) : (
        <table className="leaderboard-table">
          <thead>
            <tr>
              <th>Peer</th>
              <th>Service</th>
              <th className="num">Change</th>
              <th className="num">From → to</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={`${entry.peerId}/${entry.provider}/${entry.service}`} className="leaderboard-row">
                <td>
                  <PeerCell peerId={entry.peerId} displayName={entry.displayName} />
                </td>
                <td><span className="svc-tag">{entry.service}</span></td>
                <td
                  className={`num price-mover-pct${
                    entry.inputChangePct < 0 ? ' is-drop' : ' is-hike'
                  }`}
                >
                  {formatPct(entry.inputChangePct)}
                </td>
                <td className="num">
                  {formatPrice(entry.fromInputUsdPerMillion)}
                  <span className="dim"> → </span>
                  {formatPrice(entry.toInputUsdPerMillion)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PriceMovements({
  stability,
  movers,
}: {
  stability: PriceStability;
  movers: PriceMovers;
}) {
  const totalEntries =
    stability.mostStable.length
    + stability.mostVolatile.length
    + movers.biggestDrops.length
    + movers.biggestHikes.length;

  return (
    <section className="dashboard-section">
      <SectionHead
        title="Pricing dynamics"
        sub="Peers ranked by how stable their per-service pricing has been over the last 30 days, plus the largest input-price moves in that window."
      />
      {totalEntries === 0 ? (
        <div className="card empty-cell">
          No pricing history yet — peers need to announce a few price changes before this fills in.
        </div>
      ) : (
        <div className="leaderboard-grid">
          <StabilityCard
            title="Most stable pricing"
            caption="Fewest distinct (input, output) price tuples observed in the window."
            entries={stability.mostStable}
            emptyHint="No stable peers yet."
          />
          <StabilityCard
            title="Most volatile pricing"
            caption="Most distinct (input, output) tuples — peers re-pricing the most often."
            entries={stability.mostVolatile}
            emptyHint="No peers with multiple price changes yet."
          />
          <MoverCard
            title="Biggest price drops"
            caption="Largest input-price reductions vs the start of the window."
            entries={movers.biggestDrops}
            emptyHint="No price drops in the window."
          />
          <MoverCard
            title="Biggest price hikes"
            caption="Largest input-price increases vs the start of the window."
            entries={movers.biggestHikes}
            emptyHint="No price hikes in the window."
          />
        </div>
      )}
    </section>
  );
}

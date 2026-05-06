import { useMemo, useState } from 'react';

const HISTOGRAM_DEFAULT_LIMIT = 12;

export function Histogram({
  title,
  caption,
  data,
  formatLabel,
  limit = HISTOGRAM_DEFAULT_LIMIT,
}: {
  title: string;
  caption: string;
  data: Record<string, number>;
  formatLabel?: (key: string) => string;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const entries = useMemo(
    () => Object.entries(data).sort(([, a], [, b]) => b - a),
    [data],
  );
  const max = entries[0]?.[1] ?? 0;
  const truncated = !expanded && entries.length > limit;
  const visible = truncated ? entries.slice(0, limit) : entries;
  const hiddenCount = entries.length - limit;

  return (
    <div className="histogram">
      <div className="histogram-head">
        <span className="histogram-title">{title}</span>
        {entries.length > 0 && (
          <span className="histogram-total">{entries.length} buckets</span>
        )}
      </div>
      <div className="histogram-cap">{caption}</div>
      {entries.length === 0 ? (
        <div className="histogram-empty">no data yet</div>
      ) : (
        <>
          <div className="histogram-rows">
            {visible.map(([key, count], i) => (
              <div key={key} className={`histogram-row rank-${Math.min(i, 3)}`}>
                <span className="histogram-label" title={formatLabel?.(key) ?? key}>
                  {formatLabel?.(key) ?? key}
                </span>
                <div className="histogram-bar-wrap">
                  <div
                    className="histogram-bar"
                    style={{ width: `${(count / max) * 100}%` }}
                  />
                </div>
                <span className="histogram-count">{count}</span>
              </div>
            ))}
          </div>
          {entries.length > limit && (
            <button
              type="button"
              className="histogram-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {truncated ? `Show ${hiddenCount} more` : 'Show less'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

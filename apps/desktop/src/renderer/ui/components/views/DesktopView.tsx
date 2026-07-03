import { useEffect, useMemo, useRef, useState } from 'react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatClock } from '../../../core/format';

type DesktopViewProps = {
};

type RuntimeLogEntry = {
  timestamp: number;
  mode: string;
  stream: string;
  line: string;
};

type LogSourceSummary = {
  source: string;
  count: number;
};

const ALL_SOURCES = '__all__';

function normalizeLogSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return 'runtime';
  }
  if (/^proxy$/i.test(trimmed)) {
    return 'proxy';
  }
  return trimmed;
}

function getLogSource(entry: RuntimeLogEntry): string {
  if (entry.stream === 'system') {
    return 'system';
  }

  const prefixMatch = /^\s*\[([^\]]{1,48})\]/.exec(entry.line);
  if (prefixMatch?.[1]) {
    return normalizeLogSource(prefixMatch[1]);
  }

  return entry.stream === 'stderr' ? 'stderr' : 'runtime';
}

function sourceSortRank(source: string): number {
  const normalized = source.toLowerCase();
  if (normalized === 'proxymux') return 0;
  if (normalized === 'paymentmux') return 1;
  if (normalized === 'buyerpayment') return 2;
  if (normalized === 'buyernegotiator') return 3;
  if (normalized === 'buyerrequest') return 4;
  if (normalized === 'proxy') return 5;
  if (normalized === 'node') return 6;
  if (normalized === 'system') return 98;
  if (normalized === 'stderr') return 99;
  return 50;
}

function getLogSources(logs: RuntimeLogEntry[]): LogSourceSummary[] {
  const counts = new Map<string, number>();
  for (const entry of logs) {
    const source = getLogSource(entry);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => {
      const rankDelta = sourceSortRank(left.source) - sourceSortRank(right.source);
      if (rankDelta !== 0) return rankDelta;
      return left.source.localeCompare(right.source);
    });
}

function matchesSearch(entry: RuntimeLogEntry, source: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }

  return [
    source,
    entry.mode,
    entry.stream,
    entry.line,
  ].some((value) => value.toLowerCase().includes(normalized));
}

function downloadLogs(logs: RuntimeLogEntry[]): void {
  const text = logs.map((e) => `${formatClock(e.timestamp)} [${e.mode}] [${e.stream}] ${e.line}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `antseed-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    URL.revokeObjectURL(url);
  }
}

export function DesktopView(_props: DesktopViewProps) {
  const [selectedSource, setSelectedSource] = useState(ALL_SOURCES);
  const [searchQuery, setSearchQuery] = useState('');
  const { logs, daemonState } = useUiSelector((state) => ({
    logs: state.logs,
    daemonState: state.daemonState,
  }), shallowEqual);
  const actions = useActions();
  const logsEndRef = useRef<HTMLDivElement>(null);

  const sourceSummaries = useMemo(() => getLogSources(logs), [logs]);
  const filteredLogs = useMemo(() => logs.filter((entry) => {
    const source = getLogSource(entry);
    return (selectedSource === ALL_SOURCES || source === selectedSource)
      && matchesSearch(entry, source, searchQuery);
  }), [logs, searchQuery, selectedSource]);
  const selectedSourceExists = selectedSource === ALL_SOURCES
    || sourceSummaries.some((summary) => summary.source === selectedSource);

  useEffect(() => {
    const el = logsEndRef.current?.parentElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredLogs.length]);

  useEffect(() => {
    if (!selectedSourceExists) {
      setSelectedSource(ALL_SOURCES);
    }
  }, [selectedSourceExists]);

  const daemonText = !daemonState || !daemonState.exists
    ? 'No daemon state file found yet.'
    : !daemonState.state
      ? 'Daemon state file exists but could not be parsed.'
      : JSON.stringify(daemonState.state, null, 2);

  return (
    <section className={`view view-desktop`} role="tabpanel">
      <div className="page-header">
        <h2>Logs</h2>
        <div className="page-header-right">
          <button className="secondary" onClick={() => downloadLogs(filteredLogs)} disabled={filteredLogs.length === 0}>
            Download Visible
          </button>
          <button className="secondary" onClick={() => void actions.clearLogs()}>
            Clear Logs
          </button>
          {/* <div className="connection-badge badge-idle">live stream</div> */}
        </div>
      </div>

      <pre hidden>{daemonText}</pre>
      <div className="panel-grid">
        <article className="panel">
          <div className="panel-head">
            <h3>Runtime Logs</h3>
            <span className="log-count">
              {filteredLogs.length} / {logs.length}
            </span>
          </div>
          <div className="log-toolbar" aria-label="Runtime log filters">
            <div className="log-source-filters" role="list" aria-label="Log sources">
              <button
                type="button"
                className={`log-filter-chip${selectedSource === ALL_SOURCES ? ' active' : ''}`}
                onClick={() => setSelectedSource(ALL_SOURCES)}
              >
                All
                <span>{logs.length}</span>
              </button>
              {sourceSummaries.map(({ source, count }) => (
                <button
                  key={source}
                  type="button"
                  className={`log-filter-chip${selectedSource === source ? ' active' : ''}`}
                  onClick={() => setSelectedSource(source)}
                  title={`Show only ${source} logs`}
                >
                  {source}
                  <span>{count}</span>
                </button>
              ))}
            </div>
            <input
              type="search"
              className="log-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter text, source, stream..."
              aria-label="Filter logs by text"
            />
          </div>
          <div className="logs" aria-live="polite">
            {filteredLogs.length === 0 && (
              <div className="log-empty">No logs match the current filter.</div>
            )}
            {filteredLogs.map((entry, i) => (
              <div key={`${entry.timestamp}-${i}-${entry.line}`} className={`log-entry ${entry.stream}`}>
                <span className="ts">{formatClock(entry.timestamp)}</span>
                <span className="log-source">{getLogSource(entry)}</span>
                {`[${entry.mode}] ${entry.line}`}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </article>
      </div>
    </section>
  );
}

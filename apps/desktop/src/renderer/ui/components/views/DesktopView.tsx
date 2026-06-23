import { useEffect, useRef } from 'react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatClock } from '../../../core/format';

type DesktopViewProps = {
  active: boolean;
};

function downloadLogs(logs: { timestamp: number; mode: string; stream: string; line: string }[]): void {
  const text = logs.map((e) => `${formatClock(e.timestamp)} [${e.mode}] [${e.stream}] ${e.line}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `antseed-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

export function DesktopView({ active }: DesktopViewProps) {
  const { logs, daemonState } = useUiSelector((state) => ({
    logs: state.logs,
    daemonState: state.daemonState,
  }), shallowEqual);
  const actions = useActions();
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logsEndRef.current?.parentElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);

  const daemonText = !daemonState || !daemonState.exists
    ? 'No daemon state file found yet.'
    : !daemonState.state
      ? 'Daemon state file exists but could not be parsed.'
      : JSON.stringify(daemonState.state, null, 2);

  return (
    <section className={`view view-desktop${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>Logs</h2>
        <div className="page-header-right">
          <button className="secondary" onClick={() => downloadLogs(logs)} disabled={logs.length === 0}>
            Download Logs
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
          </div>
          <div className="logs" aria-live="polite">
            {logs.map((entry, i) => (
              <div key={i} className={`log-entry ${entry.stream}`}>
                <span className="ts">{formatClock(entry.timestamp)}</span>
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

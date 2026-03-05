import { useEffect, useRef } from 'react';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { formatClock } from '../../../core/format';

type DesktopViewProps = {
  active: boolean;
};

export function DesktopView({ active }: DesktopViewProps) {
  const { logs, daemonState } = useUiSnapshot();
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
          <button className="secondary" onClick={() => void actions.clearLogs()}>
            Clear Logs
          </button>
          <div className="connection-badge badge-idle">live stream</div>
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

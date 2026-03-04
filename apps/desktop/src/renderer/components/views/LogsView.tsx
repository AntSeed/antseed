import type { ViewModelProps } from '../types';

type LogsViewProps = {
  vm: ViewModelProps['vm'];
};

export function LogsView({ vm }: LogsViewProps) {
  return (
    <section id="view-desktop" className={vm.viewClass(vm.shellState.activeView === 'desktop')} role="tabpanel">
      <div className="page-header">
        <h2>Logs</h2>
        <div id="desktopMeta" className={vm.toneClass('idle')}>live stream</div>
      </div>
      <pre id="daemonState" hidden>{vm.daemonState ? JSON.stringify(vm.daemonState, null, 2) : 'No daemon state'}</pre>
      <div className="panel-grid">
        <article className="panel">
          <div className="panel-head"><h3>Runtime Logs</h3></div>
          <div id="logs" className="logs" aria-live="polite">
            {vm.logs.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}-${entry.line}`} className={`log-entry ${entry.stream}`}>
                <span className="ts">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                {`[${entry.mode}] ${entry.line}`}
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

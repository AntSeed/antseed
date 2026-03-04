import type { ViewModelProps } from '../types';

type SessionsViewProps = {
  vm: ViewModelProps['vm'];
};

export function SessionsView({ vm }: SessionsViewProps) {
  return (
    <section id="view-sessions" className={vm.viewClass(vm.shellState.activeView === 'sessions')} role="tabpanel">
      <div className="page-header">
        <h2>Sessions</h2>
        <div id="sessionsMeta" className={vm.toneClass(vm.activeSessions > 0 ? 'active' : 'idle')}>{`${vm.formatInt(Math.max(vm.activeSessions, vm.safeNumber(vm.sessionsPayload.total, 0)))} sessions`}</div>
      </div>
      <p id="sessionsMessage" className="message">
        {vm.dashboardData.sessions.ok
          ? 'Session metrics from metering storage.'
          : vm.activeSessions > 0
            ? `${vm.formatInt(vm.activeSessions)} active session(s) detected from daemon state. Sessions API is degraded, showing live placeholders.`
            : `Unable to load sessions: ${vm.dashboardData.sessions.error ?? 'unknown error'}`}
      </p>
      <div className="panel">
        <div className="table-wrap">
          <table className="table">
            <thead id="sessionsHead">
              <tr>
                <th className={`sortable ${vm.sessionSort.key === 'sessionId' ? `sort-${vm.sessionSort.dir}` : ''}`} onClick={() => vm.setSessionSort((current) => ({ key: 'sessionId', dir: current.key === 'sessionId' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Session</th>
                <th className={`sortable ${vm.sessionSort.key === 'provider' ? `sort-${vm.sessionSort.dir}` : ''}`} onClick={() => vm.setSessionSort((current) => ({ key: 'provider', dir: current.key === 'provider' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Provider</th>
                <th className={`sortable ${vm.sessionSort.key === 'startedAt' ? `sort-${vm.sessionSort.dir}` : ''}`} onClick={() => vm.setSessionSort((current) => ({ key: 'startedAt', dir: current.key === 'startedAt' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Started</th>
                <th className={`sortable ${vm.sessionSort.key === 'totalTokens' ? `sort-${vm.sessionSort.dir}` : ''}`} onClick={() => vm.setSessionSort((current) => ({ key: 'totalTokens', dir: current.key === 'totalTokens' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Tokens</th>
                <th className={`sortable ${vm.sessionSort.key === 'totalRequests' ? `sort-${vm.sessionSort.dir}` : ''}`} onClick={() => vm.setSessionSort((current) => ({ key: 'totalRequests', dir: current.key === 'totalRequests' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Requests</th>
                <th className={`sortable ${vm.sessionSort.key === 'durationMs' ? `sort-${vm.sessionSort.dir}` : ''}`} onClick={() => vm.setSessionSort((current) => ({ key: 'durationMs', dir: current.key === 'durationMs' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Duration</th>
                <th className={`sortable ${vm.sessionSort.key === 'avgLatencyMs' ? `sort-${vm.sessionSort.dir}` : ''}`} onClick={() => vm.setSessionSort((current) => ({ key: 'avgLatencyMs', dir: current.key === 'avgLatencyMs' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Latency</th>
                <th className={`sortable ${vm.sessionSort.key === 'peerSwitches' ? `sort-${vm.sessionSort.dir}` : ''}`} onClick={() => vm.setSessionSort((current) => ({ key: 'peerSwitches', dir: current.key === 'peerSwitches' && current.dir === 'asc' ? 'desc' : 'asc' }))}>Switches</th>
              </tr>
            </thead>
            <tbody id="sessionsBody">
              {vm.sessionRows.length === 0 && (
                <tr><td colSpan={8} className="empty">No sessions yet.</td></tr>
              )}
              {vm.sessionRows}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

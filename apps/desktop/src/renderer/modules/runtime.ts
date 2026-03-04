import type { LogEvent, RuntimeProcessState } from '../types/bridge';

type RuntimeElements = Record<string, HTMLElement | null | undefined>;

type RuntimeUiState = Record<string, any>;

type RuntimeModuleOptions = {
  elements: RuntimeElements;
  uiState: RuntimeUiState;
  formatClock: (timestamp: number) => string;
  formatDuration: (durationMs: number) => string;
  setText: (el: HTMLElement | null | undefined, value: string) => void;
};

type BadgeState = 'running' | 'stopped' | 'error';

export function initRuntimeModule({
  elements,
  uiState,
  formatClock,
  formatDuration,
  setText,
}: RuntimeModuleOptions) {
  function setRuntimeBadge(el: HTMLElement | null | undefined, state: BadgeState): void {
    if (!el) return;
    el.classList.remove('running', 'stopped', 'error');
    el.classList.add(state);

    if (state === 'running') {
      el.textContent = 'Running';
    } else if (state === 'error') {
      el.textContent = 'Error';
    } else {
      el.textContent = 'Stopped';
    }
  }

  function appendLog(entry: LogEvent): void {
    if (!elements.logs) return;

    const line = document.createElement('div');
    line.className = `log-entry ${entry.stream}`;

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatClock(entry.timestamp);

    line.appendChild(ts);
    line.appendChild(document.createTextNode(`[${entry.mode}] ${entry.line}`));

    elements.logs.appendChild(line);
    elements.logs.scrollTop = elements.logs.scrollHeight;
  }

  function renderLogs(entries: LogEvent[]): void {
    if (!elements.logs) return;
    elements.logs.innerHTML = '';
    for (const entry of entries) {
      appendLog(entry);
    }
  }

  function processByMode(mode: string, processes: RuntimeProcessState[] = uiState.processes): RuntimeProcessState | null {
    return processes.find((proc) => proc.mode === mode) ?? null;
  }

  function isModeRunning(mode: string, processes: RuntimeProcessState[] = uiState.processes): boolean {
    const proc = processByMode(mode, processes);
    return Boolean(proc && proc.running);
  }

  function renderProcessState(
    mode: string,
    stateEl: HTMLElement | null | undefined,
    badgeEl: HTMLElement | null | undefined,
    processInfo: RuntimeProcessState | null,
  ): void {
    if (!stateEl || !badgeEl) return;

    stateEl.classList.remove('status-running', 'status-stopped');

    if (!processInfo) {
      stateEl.textContent = 'Unknown';
      stateEl.classList.add('status-stopped');
      setRuntimeBadge(badgeEl, 'stopped');
      return;
    }

    if (processInfo.running) {
      const uptimeMs = processInfo.startedAt ? Date.now() - processInfo.startedAt : 0;
      stateEl.textContent = `Running (pid=${processInfo.pid ?? 'unknown'}, uptime=${formatDuration(uptimeMs)})`;
      stateEl.classList.add('status-running');
      setRuntimeBadge(badgeEl, 'running');
      return;
    }

    const segments = ['Stopped'];
    if (processInfo.lastExitCode !== null) {
      segments.push(`exit=${processInfo.lastExitCode}`);
    }
    if (processInfo.lastError) {
      segments.push(`error=${processInfo.lastError}`);
    }
    stateEl.textContent = segments.join(' | ');
    stateEl.classList.add('status-stopped');
    setRuntimeBadge(badgeEl, processInfo.lastError ? 'error' : 'stopped');

    if (mode === 'dashboard') {
      uiState.dashboardRunning = false;
    }
  }

  function renderProcesses(processes: RuntimeProcessState[]): void {
    uiState.processes = Array.isArray(processes) ? processes : [];
    uiState.dashboardRunning = isModeRunning('dashboard', uiState.processes);

    renderProcessState('seed', elements.seedState, elements.seedBadge, processByMode('seed'));
    renderProcessState('connect', elements.connectState, elements.connectBadge, processByMode('connect'));
    renderProcessState('dashboard', elements.dashboardState, elements.dashboardBadge, processByMode('dashboard'));

  }

  function renderDaemonState(snapshot: { exists: boolean; state: Record<string, unknown> | null } | null): void {
    if (!elements.daemonState) return;
    uiState.daemonState = snapshot ?? null;

    if (!snapshot || !snapshot.exists) {
      elements.daemonState.textContent = 'No daemon state file found yet.';
      return;
    }

    if (!snapshot.state) {
      elements.daemonState.textContent = 'Daemon state file exists but could not be parsed.';
      return;
    }

    elements.daemonState.textContent = JSON.stringify(snapshot.state, null, 2);
  }

  function appendSystemLog(message: string): void {
    appendLog({
      mode: 'dashboard' as const,
      stream: 'system' as const,
      line: message,
      timestamp: Date.now(),
    });
  }

  return {
    appendLog,
    renderLogs,
    processByMode,
    isModeRunning,
    renderProcesses,
    renderDaemonState,
    appendSystemLog,
  };
}

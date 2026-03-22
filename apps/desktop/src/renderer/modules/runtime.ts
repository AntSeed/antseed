import type { LogEvent, RuntimeProcessState } from '../types/bridge';
import type { RendererUiState, BadgeTone } from '../core/state';
import { appendLogEntry, replaceLogEntries } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import { formatClock, formatDuration } from '../core/format';

type RuntimeModuleOptions = {
  uiState: RendererUiState;
};

type ProcessBadgeState = 'running' | 'stopped' | 'error';

function processBadgeToDisplay(state: ProcessBadgeState): { tone: BadgeTone; label: string } {
  if (state === 'running') return { tone: 'active', label: 'Running' };
  if (state === 'error') return { tone: 'warn', label: 'Error' };
  return { tone: 'idle', label: 'Stopped' };
}

export function initRuntimeModule({ uiState }: RuntimeModuleOptions) {
  function appendLog(entry: LogEvent): void {
    appendLogEntry(uiState, entry);
    notifyUiStateChanged();
  }

  function renderLogs(entries: LogEvent[]): void {
    replaceLogEntries(uiState, entries);
    notifyUiStateChanged();
  }

  function processByMode(
    mode: string,
    processes: RuntimeProcessState[] = uiState.processes,
  ): RuntimeProcessState | null {
    return processes.find((proc) => proc.mode === mode) ?? null;
  }

  function isModeRunning(
    mode: string,
    processes: RuntimeProcessState[] = uiState.processes,
  ): boolean {
    const proc = processByMode(mode, processes);
    return Boolean(proc && proc.running);
  }

  function computeProcessState(
    mode: string,
    processInfo: RuntimeProcessState | null,
  ): { stateText: string; badge: ProcessBadgeState } {
    if (!processInfo) {
      return { stateText: 'Unknown', badge: 'stopped' };
    }

    if (processInfo.running) {
      const uptimeMs = processInfo.startedAt ? Date.now() - processInfo.startedAt : 0;
      return {
        stateText: `Running (pid=${processInfo.pid ?? 'unknown'}, uptime=${formatDuration(uptimeMs)})`,
        badge: 'running',
      };
    }

    const segments = ['Stopped'];
    if (processInfo.lastExitCode !== null) {
      segments.push(`exit=${processInfo.lastExitCode}`);
    }
    if (processInfo.lastError) {
      segments.push(`error=${processInfo.lastError}`);
    }

    const badge: ProcessBadgeState = processInfo.lastError ? 'error' : 'stopped';
    return { stateText: segments.join(' | '), badge };
  }

  function renderProcesses(processes: RuntimeProcessState[]): void {
    uiState.processes = Array.isArray(processes) ? processes : [];

    const connect = computeProcessState('connect', processByMode('connect'));
    uiState.connectState = connect.stateText;
    uiState.connectBadge = processBadgeToDisplay(connect.badge);

    notifyUiStateChanged();
  }

  function renderDaemonState(
    snapshot: { exists: boolean; state: Record<string, unknown> | null } | null,
  ): void {
    uiState.daemonState = snapshot ?? null;
    notifyUiStateChanged();
  }

  function appendSystemLog(message: string): void {
    appendLog({
      mode: 'connect' as const,
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

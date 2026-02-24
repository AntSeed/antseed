import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardConfig, NodeStatus } from './types.js';

/** Stale threshold: 30 seconds */
const STALE_THRESHOLD_MS = 30_000;

function asFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullablePort(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

/**
 * Check if a process with the given PID is alive.
 * Uses process.kill(pid, 0) which checks existence without sending a signal.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Query the current node status.
 * Reads from the running daemon's state file at ~/.antseed/daemon.state.json.
 * Uses PID-based liveness check first, falls back to 30s stale threshold.
 * Returns idle state with zeroed metrics if no daemon is running or the state file is stale.
 */
export async function getNodeStatus(config: DashboardConfig): Promise<NodeStatus> {
  const stateFilePath = join(homedir(), '.antseed', 'daemon.state.json');

  try {
    const raw = await readFile(stateFilePath, 'utf-8');
    const state = JSON.parse(raw) as Record<string, unknown>;

    // PID-based liveness check
    const pid = typeof state['pid'] === 'number' ? state['pid'] : null;
    const alive = pid !== null && isProcessAlive(pid);

    // If PID is present and process is dead, return idle immediately
    if (pid !== null && !alive) {
      return idleStatus(config, pid);
    }

    // Fallback: if no PID in state file, use stale threshold
    if (pid === null) {
      const fileStat = await stat(stateFilePath);
      const ageMs = Date.now() - fileStat.mtimeMs;
      if (ageMs > STALE_THRESHOLD_MS) {
        return idleStatus(config, null);
      }
    }

    const validStates = ['seeding', 'connected', 'idle'] as const;
    const rawState = typeof state['state'] === 'string' && validStates.includes(state['state'] as NodeStatus['state'])
      ? (state['state'] as NodeStatus['state'])
      : 'idle';

    return {
      state: rawState,
      peerCount: asFiniteNumber(state['peerCount'], 0),
      earningsToday: typeof state['earningsToday'] === 'string' ? state['earningsToday'] : '0',
      tokensToday: asFiniteNumber(state['tokensToday'], 0),
      activeSessions: asFiniteNumber(state['activeSessions'], 0),
      uptime: typeof state['uptime'] === 'string' ? state['uptime'] : '0s',
      walletAddress: typeof state['walletAddress'] === 'string' ? state['walletAddress'] : (config.identity.walletAddress ?? null),
      proxyPort: asNullablePort(state['proxyPort']),
      capacityUsedPercent: asFiniteNumber(state['capacityUsedPercent'], 0),
      daemonPid: pid,
      daemonAlive: alive,
    };
  } catch {
    // State file doesn't exist or is unreadable — daemon is not running
    return idleStatus(config, null);
  }
}

function idleStatus(config: DashboardConfig, pid: number | null): NodeStatus {
  return {
    state: 'idle',
    peerCount: 0,
    earningsToday: '0',
    tokensToday: 0,
    activeSessions: 0,
    uptime: '0s',
    walletAddress: config.identity.walletAddress ?? null,
    proxyPort: null,
    capacityUsedPercent: 0,
    daemonPid: pid,
    daemonAlive: false,
  };
}

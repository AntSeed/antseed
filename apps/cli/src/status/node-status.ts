import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AntseedConfig } from '../config/types.js';

export interface NodeStatus {
  state: 'seeding' | 'connected' | 'idle';
  peerCount: number;
  earningsToday: string;
  tokensToday: number;
  activeChannels: number;
  uptime: string;
  walletAddress: string | null;
  proxyPort: number | null;
  capacityUsedPercent: number;
  daemonPid: number | null;
  daemonAlive: boolean;
}

/** Stale threshold: 30 seconds */
const STALE_THRESHOLD_MS = 30_000;

/**
 * Check if a process with the given PID is alive.
 * Uses `process.kill(pid, 0)` which checks existence without sending a signal.
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
export async function getNodeStatus(config: AntseedConfig): Promise<NodeStatus> {
  const stateFilePath = join(homedir(), '.antseed', 'daemon.state.json');

  try {
    const raw = await readFile(stateFilePath, 'utf-8');
    const state = JSON.parse(raw) as Record<string, unknown>;

    // PID-based liveness check
    const pid = typeof state.pid === 'number' ? state.pid : null;
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
    const rawState = typeof state.state === 'string' && validStates.includes(state.state as NodeStatus['state'])
      ? (state.state as NodeStatus['state'])
      : 'idle';

    return {
      state: rawState,
      peerCount: typeof state.peerCount === 'number' ? state.peerCount : 0,
      earningsToday: typeof state.earningsToday === 'string' ? state.earningsToday : '0',
      tokensToday: typeof state.tokensToday === 'number' ? state.tokensToday : 0,
      activeChannels: typeof state.activeChannels === 'number' ? state.activeChannels : 0,
      uptime: typeof state.uptime === 'string' ? state.uptime : '0s',
      walletAddress: typeof state.walletAddress === 'string' ? state.walletAddress : (config.identity.walletAddress ?? null),
      proxyPort: typeof state.proxyPort === 'number' ? state.proxyPort : null,
      capacityUsedPercent: typeof state.capacityUsedPercent === 'number' ? state.capacityUsedPercent : 0,
      daemonPid: pid,
      daemonAlive: alive,
    };
  } catch {
    // State file doesn't exist or is unreadable — daemon is not running
    return idleStatus(config, null);
  }
}

function idleStatus(config: AntseedConfig, pid: number | null): NodeStatus {
  return {
    state: 'idle',
    peerCount: 0,
    earningsToday: '0',
    tokensToday: 0,
    activeChannels: 0,
    uptime: '0s',
    walletAddress: config.identity.walletAddress ?? null,
    proxyPort: null,
    capacityUsedPercent: 0,
    daemonPid: pid,
    daemonAlive: false,
  };
}

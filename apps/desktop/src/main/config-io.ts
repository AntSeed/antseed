import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG_PATH } from './constants.js';
import { asString, asNumber } from './utils.js';

const DEFAULT_CONFIG: Record<string, unknown> = {
  identity: { displayName: 'AntSeed Node' },
  seller: {
    reserveFloor: 10,
    maxConcurrentBuyers: 5,
    enabledProviders: [],
    pricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
  },
  buyer: {
    maxPricing: { defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } },
    minPeerReputation: 50,
    proxyPort: 8377,
  },
  network: { bootstrapNodes: [] },
  payments: { preferredMethod: 'crypto', platformFeeRate: 0.05 },
  providers: [],
  plugins: [],
};

/**
 * Ensure config.json exists. Creates it with defaults on first launch.
 */
export async function ensureConfig(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  if (existsSync(configPath)) return;
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.config.${randomUUID()}.json.tmp`);
  await writeFile(tmp, JSON.stringify(DEFAULT_CONFIG, null, 2));
  await rename(tmp, configPath);
}

/**
 * Read config.json and return parsed config with safe defaults.
 */
export async function readConfig(configPath = DEFAULT_CONFIG_PATH): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Merge a partial config into the existing config.json (read-modify-write, atomic).
 */
export async function mergeConfig(
  patch: Record<string, unknown>,
  configPath = DEFAULT_CONFIG_PATH,
): Promise<Record<string, unknown>> {
  const existing = await readConfig(configPath);
  const merged = { ...existing };

  // Deep-merge top-level keys (one level deep).
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && existing[key] && typeof existing[key] === 'object' && !Array.isArray(existing[key])) {
      merged[key] = { ...(existing[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }

  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.config.${randomUUID()}.json.tmp`);
  await writeFile(tmp, JSON.stringify(merged, null, 2));
  await rename(tmp, configPath);

  return merged;
}

/**
 * Read the daemon (seller) state file.
 */
export async function readDaemonState(statePath?: string): Promise<Record<string, unknown>> {
  const file = statePath ?? path.join(path.dirname(DEFAULT_CONFIG_PATH), 'daemon.state.json');
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Build a status-like object from daemon.state.json, matching what the
 * dashboard's /api/status endpoint returns.
 */
export async function readNodeStatus(statePath?: string): Promise<Record<string, unknown>> {
  const state = await readDaemonState(statePath);
  return {
    state: asString(state.state as string, 'idle'),
    daemonAlive: state.state === 'seeding' || state.state === 'connected',
    peerId: asString(state.peerId as string, ''),
    walletAddress: asString(state.walletAddress as string, ''),
    peerCount: asNumber(state.activeSessions, 0),
    activeSessions: asNumber(state.activeSessions, 0),
    capacityUsedPercent: asNumber(state.capacityUsedPercent, 0),
    earningsToday: asString(state.earningsToday as string, '0.00'),
    tokensToday: asNumber(state.tokensToday, 0),
    uptime: asString(state.uptime as string, '0s'),
    proxyPort: state.proxyPort ?? null,
  };
}

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG_PATH } from './constants.js';
import { asString, asNumber } from './utils.js';

export const DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION = 5;
export const DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION = 30;

const DEFAULT_CONFIG: Record<string, unknown> = {
  identity: { displayName: 'AntSeed Node' },
  seller: {
    reserveFloor: 10,
    maxConcurrentBuyers: 5,
    enabledProviders: [],
    pricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
  },
  buyer: {
    maxPricing: {
      defaults: {
        inputUsdPerMillion: DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION,
        outputUsdPerMillion: DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION,
      },
    },
    minPeerReputation: 50,
    proxyPort: 8377,
  },
  network: { bootstrapNodes: [] },
  payments: { preferredMethod: 'crypto', platformFeeRate: 0.05 },
  providers: [],
  plugins: [],
};

function asRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function writeConfigAtomic(config: Record<string, unknown>, configPath: string): Promise<void> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.config.${randomUUID()}.json.tmp`);
  await writeFile(tmp, JSON.stringify(config, null, 2));
  await rename(tmp, configPath);
}

function migrateDesktopBuyerMaxPricing(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  migrated: boolean;
} {
  const buyer = asRecordValue(config.buyer);
  const maxPricing = asRecordValue(buyer.maxPricing);
  const defaults = asRecordValue(maxPricing.defaults);

  const input = defaults.inputUsdPerMillion;
  const output = defaults.outputUsdPerMillion;

  const nextDefaults = { ...defaults };
  let migrated = false;

  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    input > DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION
  ) {
    nextDefaults.inputUsdPerMillion = DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION;
    migrated = true;
  }

  if (
    typeof output !== 'number' ||
    !Number.isFinite(output) ||
    output > DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION
  ) {
    nextDefaults.outputUsdPerMillion = DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION;
    migrated = true;
  }

  if (!migrated) return { config, migrated: false };

  return {
    config: {
      ...config,
      buyer: {
        ...buyer,
        maxPricing: {
          ...maxPricing,
          defaults: nextDefaults,
        },
      },
    },
    migrated: true,
  };
}

/**
 * Ensure config.json exists and legacy desktop defaults are migrated.
 */
export async function ensureConfig(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  if (!existsSync(configPath)) {
    await writeConfigAtomic(DEFAULT_CONFIG, configPath);
    return;
  }

  const existing = await readConfig(configPath);
  if (Object.keys(existing).length === 0) {
    await writeConfigAtomic(DEFAULT_CONFIG, configPath);
    return;
  }

  const migration = migrateDesktopBuyerMaxPricing(existing);
  if (migration.migrated) {
    await writeConfigAtomic(migration.config, configPath);
  }
}

/**
 * Read config.json and return parsed config.
 * Distinguishes "file not found" (returns {}) from "corrupt JSON" (throws).
 */
export async function readConfig(configPath = DEFAULT_CONFIG_PATH): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    // File doesn't exist — return empty (first-run scenario).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
  // Parse errors propagate — corrupt config should not be silently swallowed.
  return JSON.parse(raw) as Record<string, unknown>;
}

// Serialise config writes to prevent concurrent read-modify-write races.
let configWriteChain: Promise<void> = Promise.resolve();

/**
 * Merge a partial config into the existing config.json (serialised, atomic).
 */
export async function mergeConfig(
  patch: Record<string, unknown>,
  configPath = DEFAULT_CONFIG_PATH,
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = {};
  let writeError: Error | null = null;

  const op = configWriteChain.then(async () => {
    const existing = await readConfig(configPath);
    const merged = { ...existing };

    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value)
          && existing[key] && typeof existing[key] === 'object' && !Array.isArray(existing[key])) {
        merged[key] = { ...(existing[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        merged[key] = value;
      }
    }

    await writeConfigAtomic(merged, configPath);

    result = merged;
  }).catch((err) => {
    writeError = err instanceof Error ? err : new Error(String(err));
  });

  configWriteChain = op;
  await op;
  if (writeError) throw writeError;
  return result;
}

/**
 * Resolve the data directory from a config path.
 */
function resolveDataDir(configPath: string): string {
  return path.dirname(configPath);
}

/**
 * Read the daemon (seller) state file.
 */
export async function readDaemonState(configPath = DEFAULT_CONFIG_PATH): Promise<Record<string, unknown>> {
  const file = path.join(resolveDataDir(configPath), 'daemon.state.json');
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Build a status-like object from daemon.state.json.
 * Uses the same data directory as the config path so ANTSEED_CONFIG_PATH is respected.
 */
export async function readNodeStatus(configPath = DEFAULT_CONFIG_PATH): Promise<Record<string, unknown>> {
  const state = await readDaemonState(configPath);
  return {
    state: asString(state.state as string, 'idle'),
    daemonAlive: state.state === 'seeding' || state.state === 'connected',
    peerId: asString(state.peerId as string, ''),
    walletAddress: asString(state.walletAddress as string, ''),
    peerCount: 0, // Desktop is buyer-only; seller's activeChannels is not meaningful here.
    activeChannels: asNumber(state.activeChannels, 0),
    capacityUsedPercent: asNumber(state.capacityUsedPercent, 0),
    earningsToday: asString(state.earningsToday as string, '0.00'),
    tokensToday: asNumber(state.tokensToday, 0),
    uptime: asString(state.uptime as string, '0s'),
    proxyPort: state.proxyPort ?? null,
  };
}

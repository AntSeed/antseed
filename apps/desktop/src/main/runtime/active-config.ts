/**
 * Where the desktop reads the buyer runtime's configuration from, and the
 * buyer proxy port that config names.
 *
 * Split out of `main.ts` so the payments modules can resolve both without
 * importing the entry point back.
 */
import { DEFAULT_CONFIG_PATH } from '../constants.js';
import { asRecord } from '../utils.js';
import { readConfig } from './config-io.js';

export const DEFAULT_BUYER_PROXY_PORT = 8377;

function resolveActiveConfigPath(): string {
  const explicit = process.env['ANTSEED_CONFIG_PATH']?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  return DEFAULT_CONFIG_PATH;
}

export const ACTIVE_CONFIG_PATH = resolveActiveConfigPath();

export async function resolveBuyerProxyPort(): Promise<number> {
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const buyer = asRecord(config['buyer']);
    const port = Number(buyer['proxyPort']);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
  } catch {
    // Fall back to the default proxy port when config is unavailable.
  }
  return DEFAULT_BUYER_PROXY_PORT;
}

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { CONTRACTS_ROOT } from './paths.mjs';
import { fileExists } from './fsx.mjs';

/** Loads packages/contracts/.env without overriding values already in the environment. */
export async function loadDotEnv() {
  const file = path.join(CONTRACTS_ROOT, '.env');
  if (!(await fileExists(file))) return;
  const contents = await readFile(file, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

export function requireEnvironment(names, env = process.env) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);
}

export function rpcEnvName(network) {
  return `${network.replaceAll('-', '_').toUpperCase()}_RPC_URL`;
}

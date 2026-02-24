import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DashboardConfig } from './types.js';

/**
 * Resolve a config path, expanding ~ to the user's home directory.
 */
function resolveConfigPath(configPath: string): string {
  if (configPath.startsWith('~')) {
    return resolve(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}

/**
 * Persist the dashboard config to disk.
 * Creates the directory if it doesn't exist.
 */
export async function saveConfig(configPath: string, config: DashboardConfig): Promise<void> {
  const resolved = resolveConfigPath(configPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(config, null, 2), 'utf-8');
}

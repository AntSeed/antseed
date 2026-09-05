import { safeStorage } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  parsePublicTunnelSettings,
  type PublicTunnelSettings,
} from './settings.js';

export type { PublicTunnelSettings, TunnelProvider, TunnelProviderSettings } from './settings.js';

const SETTINGS_PATH = path.join(homedir(), '.antseed', 'tunnel.enc');

export async function loadPublicTunnelSettings(): Promise<PublicTunnelSettings | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return parsePublicTunnelSettings(JSON.parse(safeStorage.decryptString(await readFile(SETTINGS_PATH))));
  } catch {
    return null;
  }
}

export async function savePublicTunnelSettings(settings: PublicTunnelSettings): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable.');
  const temporaryPath = `${SETTINGS_PATH}.tmp`;
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(temporaryPath, safeStorage.encryptString(JSON.stringify(settings)), { mode: 0o600 });
  await rename(temporaryPath, SETTINGS_PATH);
}

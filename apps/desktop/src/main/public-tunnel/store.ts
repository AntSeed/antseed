import { safeStorage } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const SETTINGS_PATH = path.join(homedir(), '.antseed', 'tunnel.enc');

export type TunnelProvider = 'cloudflare' | 'ngrok';
export type TunnelProviderSettings = { tunnelToken: string; publicUrl: string };
export type PublicTunnelSettings = {
  activeProvider: TunnelProvider;
  providers: Partial<Record<TunnelProvider, TunnelProviderSettings>>;
  apiKey: string;
};

function resolveActiveProvider(
  preferred: TunnelProvider,
  providers: PublicTunnelSettings['providers'],
): TunnelProvider {
  if (providers[preferred]) return preferred;
  if (providers.cloudflare) return 'cloudflare';
  return 'ngrok';
}

export async function loadPublicTunnelSettings(): Promise<PublicTunnelSettings | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const parsed = JSON.parse(safeStorage.decryptString(await readFile(SETTINGS_PATH))) as Record<string, unknown>;
    if (typeof parsed.apiKey !== 'string') return null;
    if (typeof parsed.tunnelToken === 'string' && typeof parsed.publicUrl === 'string') {
      return {
        activeProvider: 'cloudflare',
        providers: { cloudflare: { tunnelToken: parsed.tunnelToken, publicUrl: parsed.publicUrl } },
        apiKey: parsed.apiKey,
      };
    }
    const activeProvider: TunnelProvider = parsed.activeProvider === 'ngrok' ? 'ngrok' : 'cloudflare';
    const rawProviders = parsed.providers && typeof parsed.providers === 'object'
      ? parsed.providers as Record<string, unknown>
      : {};
    const providers: PublicTunnelSettings['providers'] = {};
    for (const provider of ['cloudflare', 'ngrok'] as const) {
      const value = rawProviders[provider];
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.tunnelToken === 'string' && typeof entry.publicUrl === 'string') {
        providers[provider] = { tunnelToken: entry.tunnelToken, publicUrl: entry.publicUrl };
      }
    }
    if (Object.keys(providers).length === 0) return null;
    const resolvedActiveProvider = resolveActiveProvider(activeProvider, providers);
    return { activeProvider: resolvedActiveProvider, providers, apiKey: parsed.apiKey };
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

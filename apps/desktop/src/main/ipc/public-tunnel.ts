import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ipcMain } from 'electron';
import type { ProcessManager } from '../runtime/process-manager.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import { resolveConnectDataDir } from '../runtime/process-manager.js';
import { loadPublicTunnelSettings, savePublicTunnelSettings, type TunnelProvider } from '../public-tunnel/store.js';

type PublicTunnelStatus = {
  configured: boolean;
  configuredProviders: TunnelProvider[];
  activeProvider: TunnelProvider | null;
  running: boolean;
  baseUrl: string | null;
};

const STATUS_ATTEMPTS = 60;
const STATUS_INTERVAL_MS = 250;

function statePath(): string {
  return path.join(resolveConnectDataDir(), 'tunnel', 'tunnel.state.json');
}

function parseTunnelProvider(value: unknown): TunnelProvider | null {
  if (value === 'cloudflare' || value === 'ngrok') return value;
  return null;
}

function providerName(provider: TunnelProvider): string {
  return provider === 'ngrok' ? 'ngrok' : 'Cloudflare';
}

function providerTokenName(provider: TunnelProvider): string {
  return provider === 'ngrok' ? 'ngrok authtoken' : 'Cloudflare tunnel token';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readStatus(processManager: ProcessManager): Promise<PublicTunnelStatus> {
  const running = processManager.getState().some((state) => state.mode === 'tunnel' && state.running);
  let baseUrl: string | null = null;
  let runningProvider: TunnelProvider | null = null;
  try {
    const state = JSON.parse(await readFile(statePath(), 'utf8')) as Record<string, unknown>;
    baseUrl = typeof state.baseUrl === 'string' ? state.baseUrl : null;
    runningProvider = parseTunnelProvider(state.provider);
  } catch { /* not ready */ }
  const settings = await loadPublicTunnelSettings();
  return {
    configured: settings !== null,
    configuredProviders: Object.keys(settings?.providers ?? {}) as TunnelProvider[],
    activeProvider: runningProvider ?? settings?.activeProvider ?? null,
    running,
    baseUrl,
  };
}

async function waitForBaseUrl(processManager: ProcessManager): Promise<PublicTunnelStatus> {
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt += 1) {
    const status = await readStatus(processManager);
    if (status.baseUrl || !status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, STATUS_INTERVAL_MS));
  }
  return readStatus(processManager);
}

export function registerPublicTunnelIpc(deps: { processManager: ProcessManager }): void {
  const { processManager } = deps;
  ipcMain.handle('public-tunnel:get-status', () => readStatus(processManager));
  ipcMain.handle('public-tunnel:configure', async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') return { ok: false, error: 'Tunnel settings are required.' };
    const raw = input as Record<string, unknown>;
    const provider = parseTunnelProvider(raw.provider) ?? 'cloudflare';
    const tunnelToken = typeof raw.tunnelToken === 'string' ? raw.tunnelToken.trim() : '';
    const publicUrlInput = typeof raw.publicUrl === 'string' ? raw.publicUrl.trim() : '';
    let publicUrl = '';
    if (tunnelToken.length < 20) {
      return { ok: false, error: `Enter a valid ${providerTokenName(provider)}.` };
    }
    if (publicUrlInput) {
      try {
        const parsed = new URL(publicUrlInput);
        if (parsed.protocol !== 'https:') throw new Error();
        publicUrl = parsed.origin;
      } catch {
        return { ok: false, error: 'Enter a valid public https:// hostname.' };
      }
    } else if (provider === 'cloudflare') {
      return { ok: false, error: 'Enter the public https:// hostname configured for this Cloudflare tunnel.' };
    }
    const existing = await loadPublicTunnelSettings();
    const apiKey = existing?.apiKey ?? `antseed_${randomBytes(24).toString('base64url')}`;
    await savePublicTunnelSettings({
      activeProvider: provider,
      providers: { ...existing?.providers, [provider]: { tunnelToken, publicUrl } },
      apiKey,
    });
    return { ok: true, status: await readStatus(processManager) };
  });
  ipcMain.handle('public-tunnel:start', async (_event, input: unknown) => {
    const settings = await loadPublicTunnelSettings();
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const requestedProvider = parseTunnelProvider(raw.provider);
    const provider = requestedProvider ?? settings?.activeProvider ?? 'cloudflare';
    const providerSettings = settings?.providers[provider];
    if (!settings || !providerSettings) {
      return { ok: false, error: `Configure ${providerName(provider)} first.` };
    }
    try {
      if (processManager.getState().some((state) => state.mode === 'tunnel' && state.running)) {
        await processManager.stop('tunnel');
      }
      if (settings.activeProvider !== provider) {
        await savePublicTunnelSettings({ ...settings, activeProvider: provider });
      }
      await processManager.start({
        mode: 'tunnel',
        tunnelBuyerPort: await resolveBuyerProxyPort(),
        env: {
          ANTSEED_TUNNEL_PROVIDER: provider,
          ANTSEED_TUNNEL_TOKEN: providerSettings.tunnelToken,
          CLOUDFLARED_TUNNEL_TOKEN: provider === 'cloudflare' ? providerSettings.tunnelToken : '',
          NGROK_AUTHTOKEN: provider === 'ngrok' ? providerSettings.tunnelToken : '',
          ANTSEED_TUNNEL_PUBLIC_URL: providerSettings.publicUrl,
          ANTSEED_TUNNEL_API_KEY: settings.apiKey,
        },
      });
      const status = await waitForBaseUrl(processManager);
      if (status.baseUrl) return { ok: true, status };
      return {
        ok: false,
        status,
        error: `Tunnel exited before becoming ready. Check the runtime logs and ${providerTokenName(provider)}.`,
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
  ipcMain.handle('public-tunnel:stop', async () => {
    await processManager.stop('tunnel');
    return { ok: true, status: await readStatus(processManager) };
  });
  ipcMain.handle('public-tunnel:get-api-key', async () => ({ apiKey: (await loadPublicTunnelSettings())?.apiKey ?? null }));
}

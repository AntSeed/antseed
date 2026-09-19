import type { PublicTunnelSettings, TunnelProvider } from './settings.js';

export type PublicTunnelStatus = {
  configured: boolean;
  configuredProviders: TunnelProvider[];
  activeProvider: TunnelProvider | null;
  running: boolean;
  baseUrl: string | null;
};

type TunnelStartOptions = {
  provider: TunnelProvider;
  buyerPort: number;
  tunnelToken: string;
  publicUrl: string;
  apiKey: string;
};

type PublicTunnelLifecycleDependencies = {
  loadSettings: () => Promise<PublicTunnelSettings | null>;
  saveSettings: (settings: PublicTunnelSettings) => Promise<void>;
  isRunning: () => boolean;
  startProcess: (options: TunnelStartOptions) => Promise<void>;
  stopProcess: () => Promise<void>;
  resolveBuyerPort: () => Promise<number>;
  waitForReady: () => Promise<PublicTunnelStatus>;
};

type TunnelResult = {
  ok: boolean;
  status?: PublicTunnelStatus;
  error?: string;
};

function providerName(provider: TunnelProvider): string {
  return provider === 'ngrok' ? 'ngrok' : 'Cloudflare';
}

function providerTokenName(provider: TunnelProvider): string {
  return provider === 'ngrok' ? 'ngrok authtoken' : 'Cloudflare tunnel token';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPublicTunnelLifecycle(deps: PublicTunnelLifecycleDependencies) {
  const start = async (requestedProvider?: TunnelProvider): Promise<TunnelResult> => {
    const settings = await deps.loadSettings();
    const provider = requestedProvider ?? settings?.activeProvider ?? 'cloudflare';
    const providerSettings = settings?.providers[provider];
    if (!settings || !providerSettings) {
      return { ok: false, error: `Configure ${providerName(provider)} first.` };
    }

    try {
      if (deps.isRunning()) await deps.stopProcess();
      await deps.startProcess({
        provider,
        buyerPort: await deps.resolveBuyerPort(),
        tunnelToken: providerSettings.tunnelToken,
        publicUrl: providerSettings.publicUrl,
        apiKey: settings.apiKey,
      });
      const status = await deps.waitForReady();
      if (!status.baseUrl) {
        return {
          ok: false,
          status,
          error: `Tunnel exited before becoming ready. Check the runtime logs and ${providerTokenName(provider)}.`,
        };
      }
      await deps.saveSettings({ ...settings, activeProvider: provider, enabled: true });
      return { ok: true, status };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };

  const stop = async (): Promise<void> => {
    const settings = await deps.loadSettings();
    if (settings?.enabled) await deps.saveSettings({ ...settings, enabled: false });
    await deps.stopProcess();
  };

  const restore = async (): Promise<TunnelResult | null> => {
    const settings = await deps.loadSettings();
    if (!settings?.enabled) return null;
    return start(settings.activeProvider);
  };

  return { start, stop, restore };
}

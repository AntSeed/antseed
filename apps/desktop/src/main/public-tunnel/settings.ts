export type TunnelProvider = 'cloudflare' | 'ngrok';
export type TunnelProviderSettings = { tunnelToken: string; publicUrl: string };
export type PublicTunnelSettings = {
  activeProvider: TunnelProvider;
  providers: Partial<Record<TunnelProvider, TunnelProviderSettings>>;
  apiKey: string;
  enabled: boolean;
};

function resolveActiveProvider(
  preferred: TunnelProvider,
  providers: PublicTunnelSettings['providers'],
): TunnelProvider {
  if (providers[preferred]) return preferred;
  if (providers.cloudflare) return 'cloudflare';
  return 'ngrok';
}

export function parsePublicTunnelSettings(parsed: unknown): PublicTunnelSettings | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.apiKey !== 'string') return null;
  const enabled = raw.enabled === true;
  if (typeof raw.tunnelToken === 'string' && typeof raw.publicUrl === 'string') {
    return {
      activeProvider: 'cloudflare',
      providers: { cloudflare: { tunnelToken: raw.tunnelToken, publicUrl: raw.publicUrl } },
      apiKey: raw.apiKey,
      enabled,
    };
  }
  const activeProvider: TunnelProvider = raw.activeProvider === 'ngrok' ? 'ngrok' : 'cloudflare';
  const rawProviders = raw.providers && typeof raw.providers === 'object'
    ? raw.providers as Record<string, unknown>
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
  return {
    activeProvider: resolveActiveProvider(activeProvider, providers),
    providers,
    apiKey: raw.apiKey,
    enabled,
  };
}

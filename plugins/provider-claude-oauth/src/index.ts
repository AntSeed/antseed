import type { AntseedProviderPlugin, ConfigField } from '@antseed/node';
import { BaseProvider, OAuthTokenProvider, StaticTokenProvider } from '@antseed/provider-core';

const configSchema: ConfigField[] = [
  { key: 'CLAUDE_ACCESS_TOKEN', label: 'Access Token', type: 'secret', required: true, description: 'Claude OAuth access token' },
  { key: 'CLAUDE_REFRESH_TOKEN', label: 'Refresh Token', type: 'secret', required: false, description: 'OAuth refresh token for auto-renewal' },
  { key: 'CLAUDE_TOKEN_EXPIRES_AT', label: 'Token Expiry', type: 'number', required: false, description: 'Epoch ms when access token expires' },
  { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 10 },
  { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 10 },
  { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 5 },
  { key: 'ANTSEED_ALLOWED_MODELS', label: 'Allowed Models', type: 'string[]', required: false },
];

const plugin: AntseedProviderPlugin = {
  name: 'claude-oauth',
  displayName: 'Claude (OAuth)',
  version: '0.1.0',
  type: 'provider',
  description: 'Claude OAuth provider (testing and development only)',
  configSchema,
  configKeys: configSchema,
  createProvider(config: Record<string, string>) {
    const accessToken = config['CLAUDE_ACCESS_TOKEN'];
    if (!accessToken) throw new Error('CLAUDE_ACCESS_TOKEN is required');

    const refreshToken = config['CLAUDE_REFRESH_TOKEN'];
    const expiresAt = config['CLAUDE_TOKEN_EXPIRES_AT']
      ? parseInt(config['CLAUDE_TOKEN_EXPIRES_AT'], 10)
      : undefined;

    const tokenProvider = refreshToken
      ? new OAuthTokenProvider({
          accessToken,
          refreshToken,
          expiresAt: expiresAt ?? Date.now() + 3600_000,
          tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
        })
      : new StaticTokenProvider(accessToken);

    const inputPrice = parseFloat(config['ANTSEED_INPUT_USD_PER_MILLION'] ?? '10');
    const outputPrice = parseFloat(config['ANTSEED_OUTPUT_USD_PER_MILLION'] ?? '10');
    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '5', 10);
    const allowedModels = (config['ANTSEED_ALLOWED_MODELS'] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);

    return new BaseProvider({
      name: 'claude-oauth',
      models: allowedModels,
      pricing: {
        defaults: {
          inputUsdPerMillion: inputPrice,
          outputUsdPerMillion: outputPrice,
        },
      },
      relay: {
        baseUrl: 'https://api.anthropic.com',
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${accessToken}`,
        tokenProvider,
        extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
        maxConcurrency,
        allowedModels,
      },
    });
  },
};

export default plugin;

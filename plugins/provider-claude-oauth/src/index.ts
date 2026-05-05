import type { AntseedProviderPlugin, ConfigField, ServiceApiProtocol } from '@antseed/node';
import { BaseProvider, OAuthTokenProvider, StaticTokenProvider, parseServiceAliasMap, parseNonNegativeNumber, parseServicePricingJson } from '@antseed/provider-core';

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const CLAUDE_CODE_VERSION = '2.1.75';
const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_CODE_OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CODE_IDENTITY_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

const configSchema: ConfigField[] = [
  { key: 'CLAUDE_ACCESS_TOKEN', label: 'Access Token', type: 'secret', required: true, description: 'Claude OAuth access token' },
  { key: 'CLAUDE_REFRESH_TOKEN', label: 'Refresh Token', type: 'secret', required: false, description: 'OAuth refresh token for auto-renewal' },
  { key: 'CLAUDE_TOKEN_EXPIRES_AT', label: 'Token Expiry', type: 'number', required: false, description: 'Epoch ms when access token expires' },
  { key: 'CLAUDE_OAUTH_CLIENT_ID', label: 'OAuth Client ID', type: 'string', required: false, default: CLAUDE_CODE_OAUTH_CLIENT_ID, description: 'OAuth application client ID used when refreshing tokens (defaults to Claude Code client ID)' },
  { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 10 },
  { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 10 },
  { key: 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', label: 'Cached Input Price', type: 'number', required: false, description: 'Cached input price in USD per 1M tokens (defaults to input price)' },
  { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 5 },
  { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false },
  { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map', type: 'string', required: false, description: 'JSON map of announced service → upstream model name' },
  { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing Map', type: 'string', required: false, description: 'JSON map of announced service → per-service pricing' },
  { key: 'ANTSEED_THROTTLE_MIN_TIME_MS', label: 'Throttle Min Time', type: 'number', required: false, description: 'Minimum ms between upstream requests (e.g. 1000)' },
];

function buildServiceApiProtocols(
  services: string[],
  protocol: ServiceApiProtocol,
): Record<string, ServiceApiProtocol[]> | undefined {
  if (services.length === 0) return undefined;
  return Object.fromEntries(services.map((service) => [service, [protocol]]));
}

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

    const clientId = config['CLAUDE_OAUTH_CLIENT_ID'] || CLAUDE_CODE_OAUTH_CLIENT_ID;

    const refreshToken = config['CLAUDE_REFRESH_TOKEN'];
    const parsedExpiresAt = config['CLAUDE_TOKEN_EXPIRES_AT']
      ? parseInt(config['CLAUDE_TOKEN_EXPIRES_AT'], 10)
      : undefined;
    const expiresAt = parsedExpiresAt && parsedExpiresAt > Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)
      ? Date.now() + 3600_000
      : parsedExpiresAt;

    const tokenProvider = refreshToken
      ? new OAuthTokenProvider({
          accessToken,
          refreshToken,
          expiresAt: expiresAt ?? Date.now() + 3600_000,
          tokenEndpoint: CLAUDE_CODE_OAUTH_TOKEN_ENDPOINT,
          requestEncoding: 'json',
          clientId,
        })
      : new StaticTokenProvider(accessToken);

    const inputPrice = parseFloat(config['ANTSEED_INPUT_USD_PER_MILLION'] ?? '10');
    const outputPrice = parseFloat(config['ANTSEED_OUTPUT_USD_PER_MILLION'] ?? '10');
    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '5', 10);
    const allowedServices = (config['ANTSEED_ALLOWED_SERVICES'] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const serviceApiProtocols = buildServiceApiProtocols(allowedServices, 'anthropic-messages');
    const serviceRewriteMap = parseServiceAliasMap(config['ANTSEED_SERVICE_ALIAS_MAP_JSON']);
    const servicePricing = parseServicePricingJson(config['ANTSEED_SERVICE_PRICING_JSON']);
    const throttleMinTime = parseInt(config['ANTSEED_THROTTLE_MIN_TIME_MS'] ?? '0', 10);

    return new BaseProvider({
      name: 'claude-oauth',
      services: allowedServices,
      pricing: {
        defaults: {
          inputUsdPerMillion: inputPrice,
          outputUsdPerMillion: outputPrice,
          ...(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'] ? { cachedInputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'], 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', 0) } : {}),
        },
        ...(servicePricing ? { services: servicePricing } : {}),
      },
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      relay: {
        baseUrl: 'https://api.anthropic.com',
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${accessToken}`,
        tokenProvider,
        extraHeaders: {
          accept: 'application/json',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
          'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
          'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
          'x-app': 'cli',
        },
        maxConcurrency,
        allowedServices,
        serviceRewriteMap,
        injectJsonFields: {
          system: [
            {
              type: 'text',
              text: CLAUDE_CODE_IDENTITY_PROMPT,
            },
          ],
        },
        retryOn401: true,
        retryOn5xx: 2,
        retryBaseDelayMs: 1000,
        ...(throttleMinTime > 0 ? { throttle: { minTime: throttleMinTime, maxConcurrent: 1 } } : {}),
      },
    });
  },
};

export default plugin;

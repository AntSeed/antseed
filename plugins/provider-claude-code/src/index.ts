import type { AntseedProviderPlugin, Provider } from '@antseed/node';
import { BaseProvider } from '@antseed/provider-core';
import { ClaudeCodeTokenProvider } from './claude-code-token.js';

function parseNonNegativeNumber(raw: string | undefined, key: string, fallback: number): number {
  const parsed = raw === undefined ? fallback : Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

const plugin: AntseedProviderPlugin = {
  name: 'claude-code',
  displayName: 'Claude Code',
  version: '0.1.0',
  type: 'provider',
  description: 'Claude Code keychain provider (testing and development only)',
  configSchema: [
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 10, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 10, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 10, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_MODELS', label: 'Allowed Models', type: 'string[]', required: false, description: 'Model allow-list' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', 10),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', 10),
      },
    };

    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '10', 10);
    if (Number.isNaN(maxConcurrency)) {
      throw new Error('ANTSEED_MAX_CONCURRENCY must be a valid number');
    }

    const allowedModels = config['ANTSEED_ALLOWED_MODELS']
      ? config['ANTSEED_ALLOWED_MODELS'].split(',').map((s: string) => s.trim())
      : [];

    const tokenProvider = new ClaudeCodeTokenProvider();

    return new BaseProvider({
      name: 'claude-code',
      models: allowedModels,
      pricing,
      relay: {
        baseUrl: 'https://api.anthropic.com',
        authHeaderName: 'authorization',
        authHeaderValue: '',
        tokenProvider,
        maxConcurrency,
        allowedModels,
        extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
      },
    });
  },
};

export default plugin;

import type { AntseedProviderPlugin } from '@antseed/node';
import { createNativeVideoProvider } from '@antseed/provider-core';

const plugin: AntseedProviderPlugin = {
  name: 'wan', displayName: 'Wan', version: '0.1.0-beta.0', type: 'provider',
  description: 'Relay native Wan video requests to a seller-operated API',
  configSchema: [
    { key: 'DASHSCOPE_BASE_URL', label: 'Seller API URL', type: 'string', required: true },
    { key: 'DASHSCOPE_API_KEY', label: 'Seller API Key', type: 'secret', required: true },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Unit Pricing', type: 'string', required: true },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Capabilities', type: 'string' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Concurrency', type: 'number', default: 10 },
  ],
  createProvider(config) {
    const apiKey = config['DASHSCOPE_API_KEY']?.trim() ?? '';
    if (!apiKey) throw new Error('Seller API authentication is required');
    return createNativeVideoProvider({
      name: 'wan',
      protocol: 'wan-video',
      relay: {
        baseUrl: config['DASHSCOPE_BASE_URL'] ?? '',
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${apiKey}`,
        extraHeaders: { 'x-dashscope-async': 'enable' },
      },
    }, config);
  },
};

export default plugin;

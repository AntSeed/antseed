import type { AntseedProviderPlugin } from '@antseed/node';
import { createNativeVideoProvider } from '@antseed/provider-core';

const plugin: AntseedProviderPlugin = {
  name: 'runway', displayName: 'Runway', version: '0.1.0-beta.0', type: 'provider',
  description: 'Relay native runway requests to a seller-operated API',
  configSchema: [
    { key: 'RUNWAY_BASE_URL', label: 'Seller API URL', type: 'string', required: true },
    { key: 'RUNWAY_API_KEY', label: 'Seller API Key', type: 'secret', required: true },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Unit Pricing', type: 'string', required: true },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Capabilities', type: 'string' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Concurrency', type: 'number', default: 10 },
  ],
  createProvider: config => createNativeVideoProvider('runway', config),
};

export default plugin;

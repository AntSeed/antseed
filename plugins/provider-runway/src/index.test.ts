import { expect, it } from 'vitest';
import plugin from './index.js';

it('registers the runway seller endpoint plugin without job management', async () => {
  expect(plugin.name).toBe('runway');
  expect(plugin.type).toBe('provider');
  expect(() => plugin.createProvider({})).toThrow('RUNWAY_BASE_URL');
  const provider = await plugin.createProvider({ RUNWAY_BASE_URL: 'https://seller.example.test', RUNWAY_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'video', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"video":{"runway-video":{"version":1,"components":[]}}}' });
  expect(provider.serviceApiProtocols).toEqual({ video: ['runway-video'] });
  expect(provider).not.toHaveProperty('videoAdapter');
});

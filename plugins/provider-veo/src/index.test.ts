import { expect, it } from 'vitest';
import plugin from './index.js';

it('registers the veo seller endpoint plugin without job management', async () => {
  expect(plugin.name).toBe('veo');
  expect(plugin.type).toBe('provider');
  expect(() => plugin.createProvider({})).toThrow('GEMINI_BASE_URL');
  const provider = await plugin.createProvider({ GEMINI_BASE_URL: 'https://seller.example.test', GEMINI_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'video', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"video":{"veo-video":{"version":1,"components":[]}}}' });
  expect(provider.serviceApiProtocols).toEqual({ video: ['veo-video'] });
  expect(provider).not.toHaveProperty('videoAdapter');
});

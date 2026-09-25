import { afterEach, expect, it, vi } from 'vitest';
import plugin from './index.js';

afterEach(() => vi.unstubAllGlobals());

const config = { ARK_BASE_URL: 'https://seller.example.test', ARK_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'video', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"video":{"seedance-video":{"version":1,"components":[]}}}' };

it('registers the seedance seller endpoint plugin', async () => {
  expect(plugin.name).toBe('seedance');
  expect(() => plugin.createProvider({ ...config, ARK_BASE_URL: '' })).toThrow(/seller-operated/);
  expect(() => plugin.createProvider({ ...config, ARK_API_KEY: ' ' })).toThrow(/authentication/);
  const provider = await plugin.createProvider(config);
  expect(provider.serviceApiProtocols).toEqual({ video: ['seedance-video'] });
});

it('relays native Seedance creates byte-for-byte with seller auth', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"id": "task"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const body = Buffer.from(' { "model": "video", "duration": 5 }\n');
  const response = await provider.handleRequest({ requestId: 'seedance', method: 'POST', path: '/api/v3/contents/generations/tasks', headers: { 'content-type': 'application/json', authorization: 'buyer-key', 'x-antseed-provider': 'seedance' }, body });
  expect(response.statusCode).toBe(200);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://seller.example.test/api/v3/contents/generations/tasks');
  expect(options.headers.authorization).toBe('Bearer key');
  expect(options.headers['x-antseed-provider']).toBeUndefined();
  expect(Buffer.from(options.body)).toEqual(body);
  expect(options.redirect).toBe('error');
});

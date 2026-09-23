import { afterEach, expect, it, vi } from 'vitest';
import plugin from './index.js';

afterEach(() => vi.unstubAllGlobals());

const config = { RUNWAY_BASE_URL: 'https://seller.example.test', RUNWAY_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'video', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"video":{"runway-video":{"version":1,"components":[]}}}' };

it('registers the runway seller endpoint plugin without job management', async () => {
  expect(plugin.name).toBe('runway');
  expect(plugin.type).toBe('provider');
  expect(() => plugin.createProvider({})).toThrow('RUNWAY_BASE_URL');
  expect(() => plugin.createProvider({ ...config, RUNWAY_API_KEY: ' ' })).toThrow('RUNWAY_API_KEY');
  const provider = await plugin.createProvider(config);
  expect(provider.serviceApiProtocols).toEqual({ video: ['runway-video'] });
  expect(provider).not.toHaveProperty('videoAdapter');
});

it('supplies Runway auth and version headers while retaining native relay safeguards', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"task"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const body = Buffer.from(' { "model": "video", "service": "extension", "duration": 8 }\n');
  const response = await provider.handleRequest({ requestId: 'runway', method: 'POST', path: '/v1/text_to_video', headers: { 'content-type': 'application/json', authorization: 'buyer-key', 'x-goog-api-key': 'buyer-key', 'x-antseed-provider': 'runway' }, body });
  expect(response.statusCode).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://seller.example.test/v1/text_to_video');
  expect(options.headers.authorization).toBe('Bearer key');
  expect(options.headers['x-runway-version']).toBe('2024-11-06');
  expect(options.headers['x-goog-api-key']).toBeUndefined();
  expect(options.headers['x-antseed-provider']).toBeUndefined();
  expect(Buffer.from(options.body)).toEqual(body);
  expect(options.redirect).toBe('error');
});

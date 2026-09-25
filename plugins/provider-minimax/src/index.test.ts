import { afterEach, expect, it, vi } from 'vitest';
import plugin from './index.js';

afterEach(() => vi.unstubAllGlobals());

const config = { MINIMAX_BASE_URL: 'https://seller.example.test', MINIMAX_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'video', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"video":{"minimax-video":{"version":1,"components":[]}}}' };

it('registers the minimax seller endpoint plugin', async () => {
  expect(plugin.name).toBe('minimax');
  expect(() => plugin.createProvider({ ...config, MINIMAX_BASE_URL: '' })).toThrow(/seller-operated/);
  expect(() => plugin.createProvider({ ...config, MINIMAX_API_KEY: ' ' })).toThrow(/authentication/);
  const provider = await plugin.createProvider(config);
  expect(provider.serviceApiProtocols).toEqual({ video: ['minimax-video'] });
});

it('relays native MiniMax creates byte-for-byte with seller auth', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"task_id": "task"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const body = Buffer.from(' { "model": "video", "duration": 5 }\n');
  const response = await provider.handleRequest({ requestId: 'minimax', method: 'POST', path: '/v2/video_generation', headers: { 'content-type': 'application/json', authorization: 'buyer-key', 'x-antseed-provider': 'minimax' }, body });
  expect(response.statusCode).toBe(200);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://seller.example.test/v2/video_generation');
  expect(options.headers.authorization).toBe('Bearer key');
  expect(options.headers['x-antseed-provider']).toBeUndefined();
  expect(Buffer.from(options.body)).toEqual(body);
  expect(options.redirect).toBe('error');
});

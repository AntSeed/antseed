import { afterEach, expect, it, vi } from 'vitest';
import plugin from './index.js';

afterEach(() => vi.unstubAllGlobals());

const config = { DASHSCOPE_BASE_URL: 'https://seller.example.test', DASHSCOPE_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'video', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"video":{"wan-video":{"version":1,"components":[]}}}' };

it('registers the wan seller endpoint plugin', async () => {
  expect(plugin.name).toBe('wan');
  expect(() => plugin.createProvider({ ...config, DASHSCOPE_BASE_URL: '' })).toThrow(/seller-operated/);
  expect(() => plugin.createProvider({ ...config, DASHSCOPE_API_KEY: ' ' })).toThrow(/authentication/);
  const provider = await plugin.createProvider(config);
  expect(provider.serviceApiProtocols).toEqual({ video: ['wan-video'] });
});

it('relays native Wan creates byte-for-byte with seller auth', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"output": {"task_id": "task", "task_status": "PENDING"}}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const body = Buffer.from(' { "model": "video", "duration": 5 }\n');
  const response = await provider.handleRequest({ requestId: 'wan', method: 'POST', path: '/api/v1/services/aigc/video-generation/video-synthesis', headers: { 'content-type': 'application/json', authorization: 'buyer-key', 'x-antseed-provider': 'wan' }, body });
  expect(response.statusCode).toBe(200);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://seller.example.test/api/v1/services/aigc/video-generation/video-synthesis');
  expect(options.headers.authorization).toBe('Bearer key');
  expect(options.headers['x-dashscope-async']).toBe('enable');
  expect(options.headers['x-antseed-provider']).toBeUndefined();
  expect(Buffer.from(options.body)).toEqual(body);
  expect(options.redirect).toBe('error');
});

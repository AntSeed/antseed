import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeVideoProvider } from './native-video-provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('seller-operated native video relays', () => {
  for (const name of ['runway', 'veo'] as const) {
    const prefix = name === 'runway' ? 'RUNWAY' : 'GEMINI';
    const protocol = name === 'runway' ? 'runway-video' : 'veo-video';
    const config = {
      [`${prefix}_BASE_URL`]: 'https://seller.example.test',
      [`${prefix}_API_KEY`]: 'seller-secret',
      ANTSEED_ALLOWED_SERVICES: 'video-model',
      ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ 'video-model': { [protocol]: { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.5 }] } } }),
    };

    it(`${name} requires an explicit seller endpoint and pricing`, () => {
      expect(() => createNativeVideoProvider(name, { ...config, [`${prefix}_BASE_URL`]: '' })).toThrow(/seller-operated/);
      expect(() => createNativeVideoProvider(name, { ...config, ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{}' })).toThrow(/pricing/);
      expect(createNativeVideoProvider(name, config).serviceApiProtocols).toEqual({ 'video-model': [protocol] });
    });

    it(`${name} preserves native payloads and injects seller auth without exposing account endpoints`, async () => {
      const body = name === 'runway' ? { model: 'video-model', service: { extension: true }, promptText: '猫', duration: 8, custom: [1, null, 'value'] } : { model: 'extension-model', service: 'extension-service', instances: [{ prompt: '猫' }], parameters: { durationSeconds: 8 }, custom: { enabled: true } };
      const acceptance = name === 'runway' ? { id: 'task' } : { name: 'operations/job' };
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(acceptance), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);
      const provider = createNativeVideoProvider(name, config);
      const request = { requestId: 'request', method: 'POST', path: name === 'runway' ? '/v1/text_to_video' : '/v1beta/models/video-model:predictLongRunning', headers: { 'content-type': 'application/json', authorization: 'buyer-key', 'x-goog-api-key': 'buyer-key', 'x-antseed-buyer-peer-id': 'a'.repeat(40), 'x-antseed-provider': name }, body: new TextEncoder().encode(` \n${JSON.stringify(body, null, 2)}\n`) };
      const result = await provider.handleRequest(request);
      expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual(acceptance);
      const [url, options] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`https://seller.example.test${request.path}`);
      expect(JSON.parse(Buffer.from(options.body).toString())).toEqual(body);
      expect(Buffer.from(options.body)).toEqual(Buffer.from(request.body));
      expect(options.headers['x-antseed-buyer-peer-id']).toBe('a'.repeat(40));
      expect(options.headers['x-antseed-provider']).toBeUndefined();
      expect(options.headers[name === 'runway' ? 'authorization' : 'x-goog-api-key']).toBe(name === 'runway' ? 'Bearer seller-secret' : 'seller-secret');
      expect(options.redirect).toBe('error');
      expect((await provider.handleRequest({ ...request, path: '/v1/account' })).statusCode).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(`${name} validates the exact native model rather than extension fields`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const provider = createNativeVideoProvider(name, config);
      for (const model of ['VIDEO-MODEL', ' video-model ', 'unavailable']) {
        const request = { requestId: 'request', method: 'POST', path: name === 'runway' ? '/v1/text_to_video' : `/v1beta/models/${model}:predictLongRunning`, headers: { 'content-type': 'application/json', 'x-antseed-service': 'video-model' }, body: Buffer.from(JSON.stringify({ model, service: 'video-model' })) };
        expect((await provider.handleRequest(request)).statusCode).toBe(400);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('does not retry an uncertain upstream submission', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection reset'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createNativeVideoProvider('runway', { RUNWAY_BASE_URL: 'https://seller.example.test', RUNWAY_API_KEY: 'key', ANTSEED_ALLOWED_SERVICES: 'model', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"model":{"runway-video":{"version":1,"components":[]}}}' });
    await provider.handleRequest({ requestId: 'request', method: 'POST', path: '/v1/text_to_video', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"model":"model"}') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

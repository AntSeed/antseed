import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin, { routerPlugin } from './index.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

const config = { LEVANTO_BASE_URL: 'https://levanto.example.test', LEVANTO_API_KEY: 'test-key', ANTSEED_REQUEST_PRICE_MICRO_USDC: '1000' };
const body = { service: 'levanto-route', v: 1, cqt: 5, inputMessage: 'Help with code', promptTokens: 3, expectedCachedTokens: [], constraints: {} };
const result = { v: 1, router: 'levanto', ranked: [{ model: 'model-a', peer: 'a'.repeat(40), estimate: { costUsd: 0.01, inputTokens: 3, cachedInputTokens: 0, outputTokens: 30 }, price: { inUsdPerM: 1, outUsdPerM: 3, cachedInUsdPerM: 0 } }] };
const request = { requestId: 'request', method: 'POST', path: '/_antseed/route', headers: { 'content-type': 'application/json', authorization: 'buyer-secret', 'x-antseed-buyer-peer-id': 'buyer', 'x-antseed-fixed-fee-price': '1000' }, body: new TextEncoder().encode(JSON.stringify(body)) };

afterEach(() => vi.unstubAllGlobals());

describe('Levanto provider', () => {
  it('serves a routing response from a real local HTTP backend', async () => {
    let received: { authorization?: string; body?: unknown; path?: string } = {};
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      received = { authorization: incoming.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()), path: incoming.url };
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(result));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Backend failed to bind');
      const provider = await plugin.createProvider({ ...config, LEVANTO_BASE_URL: `http://127.0.0.1:${address.port}` });
      const response = await provider.handleRequest(request);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual(result);
      const { service: _service, ...upstreamBody } = body;
      expect(received).toEqual({ authorization: 'Bearer test-key', body: upstreamBody, path: '/_antseed/route' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it('requires an explicit backend, credentials, and representable price', () => {
    for (const key of Object.keys(config)) expect(() => plugin.createProvider({ ...config, [key]: '' })).toThrow();
    expect(() => plugin.createProvider({ ...config, ANTSEED_REQUEST_PRICE_MICRO_USDC: '16777217' })).toThrow();
    expect(() => plugin.createProvider({ ...config, ANTSEED_MAX_CONCURRENCY: '1.5' })).toThrow();
  });
  it('exports separate provider and buyer roles from the same package', async () => {
    const provider = await plugin.createProvider(config);
    expect(plugin.type).toBe('provider');
    expect(routerPlugin.type).toBe('router');
    expect(provider.fixedFeeServices).toMatchObject([{ service: 'levanto-route', priceMicroUsdc: '1000' }]);
    expect(provider.serviceUnitBillingModels).toBeUndefined();
  });
  it('relays the Levanto payload without model injection or AntSeed credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = await plugin.createProvider(config);
    expect((await provider.handleRequest(request)).statusCode).toBe(200);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://levanto.example.test/_antseed/route');
    expect(options.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(JSON.stringify(options.headers)).not.toContain('x-antseed-');
    const { service: _service, ...upstreamBody } = body;
    expect(JSON.parse(new TextDecoder().decode(options.body as Uint8Array))).toEqual(upstreamBody);
  });
  it('rejects day-pass responses and does not retry upstream errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...result, renewalDue: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = await plugin.createProvider(config);
    await expect(provider.handleRequest(request)).rejects.toThrow('per-response backend');
    fetchMock.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    expect((await provider.handleRequest(request)).statusCode).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

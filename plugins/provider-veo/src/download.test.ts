import { afterEach, expect, it, vi } from 'vitest';
import type { Provider, ProviderStreamCallbacks } from '@antseed/node';
import plugin from './index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const origin = 'https://generativelanguage.googleapis.com';
const uri = `${origin}/v1beta/files/file:download?alt=media`;
const config = { GEMINI_BASE_URL: origin, GEMINI_API_KEY: 'seller-secret', ANTSEED_ALLOWED_SERVICES: 'veo', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"veo":{"veo-video":{"version":1,"components":[]}}}' };
const request = { requestId: 'download', method: 'GET', path: '/v1beta/models/veo/operations/task/videos/0:download', headers: { 'x-antseed-video-download': 'veo-stream-v1', 'x-antseed-service': 'veo', 'x-goog-api-key': 'buyer-key' }, body: new Uint8Array() };
const operation = (url = uri) => ({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: url } }] } } });
const file = (body = 'video', headers = {}) => new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': '5', ...headers } });
const stream = (provider: Provider, callbacks: Partial<ProviderStreamCallbacks> = {}) => provider.handleRequestStream!(request, { signal: new AbortController().signal, onResponseStart() {}, onResponseChunk() {}, ...callbacks });

it('streams the file with one status lookup, one fetch and bounded chunks', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 17).fill(42);
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(operation())).mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  let received = 0;
  const result = await stream(provider, { onResponseChunk(chunk) { expect(chunk.data.length).toBeLessThanOrEqual(65536); received += chunk.data.length; } });
  expect(result.statusCode).toBe(200);
  expect(result.body.length).toBe(0);
  expect(received).toBe(bytes.length);
  expect(JSON.stringify(result)).not.toContain('seller-secret');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]![0]).toBe(`${origin}/v1beta/models/veo/operations/task`);
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({ headers: { 'x-goog-api-key': 'seller-secret' }, redirect: 'error' });
  expect(new Headers(fetchMock.mock.calls[1]![1].headers).has('range')).toBe(false);
});

it.each(['https://evil.test/video', 'http://127.0.0.1/video', `${origin}/v1beta/files/file:download?key=leak`, `${origin}/v1beta/models/private`, 'https://user:pass@generativelanguage.googleapis.com/v1beta/files/file:download'])('rejects unsafe artifact URL %s without fetching it', async url => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(operation(url)));
  vi.stubGlobal('fetch', fetchMock);
  expect((await stream(await plugin.createProvider(config))).statusCode).toBe(502);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([[{ done: false }, 409], [{ done: true, error: {} }, 409], [{ done: true, response: {} }, 404]])('handles pending, failed and missing results', async (body, status) => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal('fetch', fetchMock);
  expect((await stream(await plugin.createProvider(config))).statusCode).toBe(status);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  [() => new Response('video', { headers: { 'content-type': 'video/mp4' } }), 502],
  [() => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }), 502],
  [() => file('video', { 'content-type': 'text/html' }), 502],
  [() => file('video', { 'content-length': '999999999' }), 413],
  [() => file('video', { 'content-encoding': 'gzip' }), 502],
] as const)('rejects invalid upstream responses before streaming', async (makeResponse, status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(operation())).mockResolvedValueOnce(makeResponse()));
  const onResponseStart = vi.fn();
  expect((await stream(await plugin.createProvider(config), { onResponseStart })).statusCode).toBe(status);
  expect(onResponseStart).not.toHaveBeenCalled();
});

it.each(['4', '6'])('rejects incorrect length %s without a successful end', async length => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(operation())).mockResolvedValueOnce(file('video', { 'content-length': length })));
  const chunks: boolean[] = [];
  await expect(stream(await plugin.createProvider(config), { onResponseChunk(chunk) { chunks.push(chunk.done); } })).rejects.toThrow('interrupted');
  expect(chunks).not.toContain(true);
});

it('bounds concurrency and sanitizes upstream exceptions', async () => {
  let rejectFetch!: (error: Error) => void;
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((_resolve, reject) => { rejectFetch = reject; })));
  const provider = await plugin.createProvider(config);
  const first = stream(provider);
  const second = stream(provider);
  expect((await stream(provider)).statusCode).toBe(429);
  rejectFetch(new Error('seller-secret leaked upstream'));
  for (const result of await Promise.all([first, second])) {
    expect(result.statusCode).toBe(502);
    expect(Buffer.from(result.body).toString()).not.toContain('seller-secret');
  }
});

it('cancels upstream when the caller aborts during the status lookup', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('seller-secret')), { once: true });
  })));
  const pending = stream(await plugin.createProvider(config), { signal: controller.signal });
  controller.abort();
  const result = await pending;
  expect(result.statusCode).toBe(504);
  expect(Buffer.from(result.body).toString()).not.toContain('seller-secret');
});

it('only advertises downloads for direct Google services', async () => {
  expect((await plugin.createProvider(config)).serviceCapabilities?.veo?.videoDownload).toBe('veo-stream-v1');
  expect((await plugin.createProvider({ ...config, GEMINI_BASE_URL: 'https://seller.example' })).serviceCapabilities?.veo?.videoDownload).toBeUndefined();
});

it('cancels an unknown-length body before reading video bytes', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(operation())).mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'video/mp4' } })));
  expect((await stream(await plugin.createProvider(config))).statusCode).toBe(502);
  expect(cancel).toHaveBeenCalledOnce();
});

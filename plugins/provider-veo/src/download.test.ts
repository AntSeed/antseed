import { afterEach, expect, it, vi } from 'vitest';
import plugin from './index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const origin = 'https://generativelanguage.googleapis.com';
const uri = `${origin}/v1beta/files/file:download?alt=media`;
const config = { GEMINI_BASE_URL: origin, GEMINI_API_KEY: 'seller-secret', ANTSEED_ALLOWED_SERVICES: 'veo', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"veo":{"veo-video":{"version":1,"components":[]}}}' };
const request = { requestId: 'download', method: 'GET', path: '/v1beta/models/veo/operations/task/videos/0:download', headers: { range: 'bytes=0-65535', 'x-antseed-service': 'veo', 'x-goog-api-key': 'buyer-key' }, body: new Uint8Array() };
const operation = (url = uri) => ({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: url } }] } } });
const part = (body = 'video', headers = {}) => new Response(body, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-4/5', ...headers } });

it('resolves the owned operation and fetches a bounded range using only seller credentials', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(operation())).mockResolvedValueOnce(part());
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  const result = await provider.handleRequest(request);
  expect(result.statusCode).toBe(206);
  expect(Buffer.from(result.body).toString()).toBe('video');
  expect(result.headers['x-antseed-video-file']).toBe('file');
  expect(JSON.stringify(result)).not.toContain('seller-secret');
  expect(fetchMock.mock.calls[0]![0]).toBe(`${origin}/v1beta/models/veo/operations/task`);
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({ headers: { 'x-goog-api-key': 'seller-secret', range: 'bytes=0-65535' }, redirect: 'error' });
});

it.each(['https://evil.test/video', 'http://127.0.0.1/video', `${origin}/v1beta/files/file:download?key=leak`, `${origin}/v1beta/models/private`, 'https://user:pass@generativelanguage.googleapis.com/v1beta/files/file:download'])('rejects unsafe artifact URL %s without fetching it', async url => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(operation(url)));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  expect((await provider.handleRequest(request)).statusCode).toBe(502);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  [{ done: false }, 409],
  [{ done: true, error: { message: 'failed' } }, 409],
  [{ done: true, response: {} }, 404],
])('handles pending, failed and missing results without downloading', async (body, status) => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  expect((await provider.handleRequest(request)).statusCode).toBe(status);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['bytes=0-', 'bytes=0-65536', 'bytes=-1-4', 'bytes=4-3', 'bytes=0-1,3-4'])('rejects unbounded or malformed range %s', async range => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  expect((await provider.handleRequest({ ...request, headers: { ...request.headers, range } })).statusCode).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  () => new Response('video', { status: 200 }),
  () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
  () => part('video', { 'content-range': 'bytes 0-4/999999999' }),
  () => part('bad'),
  () => part('video', { 'content-type': 'text/html' }),
  () => part('video', { 'content-length': '999999999' }),
])('rejects ignored ranges, redirects, oversized and malformed responses', async makeResponse => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(operation())).mockResolvedValueOnce(makeResponse());
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  expect((await provider.handleRequest(request)).statusCode).toBe(502);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('bounds concurrency and sanitizes upstream exceptions', async () => {
  let rejectFetch!: (error: Error) => void;
  const pending = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
  const provider = await plugin.createProvider(config);
  const first = provider.handleRequest(request);
  const second = provider.handleRequest(request);
  expect((await provider.handleRequest(request)).statusCode).toBe(429);
  rejectFetch(new Error('seller-secret leaked upstream'));
  for (const result of await Promise.all([first, second])) {
    expect(result.statusCode).toBe(502);
    expect(Buffer.from(result.body).toString()).not.toContain('seller-secret');
  }
});

it('returns a timeout without leaking credentials', async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('seller-secret')), { once: true });
  })));
  const provider = await plugin.createProvider(config);
  const pending = provider.handleRequest(request);
  controller.abort();
  const result = await pending;
  expect(result.statusCode).toBe(504);
  expect(Buffer.from(result.body).toString()).not.toContain('seller-secret');
});

it('cancels oversized bodies even without a Content-Length header', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel,
  });
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(operation())).mockResolvedValueOnce(new Response(body, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-65535/100000' } }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = await plugin.createProvider(config);
  expect((await provider.handleRequest(request)).statusCode).toBe(502);
  expect(cancel).toHaveBeenCalledOnce();
});

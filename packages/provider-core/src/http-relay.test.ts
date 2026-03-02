import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpRelay, type RelayConfig, type RelayCallbacks } from './http-relay.js';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '@antseed/node';

function makeRequest(overrides?: Partial<SerializedHttpRequest>): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [] })),
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<RelayConfig>): RelayConfig {
  return {
    baseUrl: 'https://api.example.com',
    authHeaderName: 'x-api-key',
    authHeaderValue: 'sk-test-key',
    maxConcurrency: 2,
    allowedModels: ['claude-sonnet-4-20250514'],
    ...overrides,
  };
}

describe('HttpRelay', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('relays a successful non-streaming response', async () => {
    const responseBody = JSON.stringify({ id: 'msg_1', content: [{ text: 'Hello' }] });
    fetchMock.mockResolvedValueOnce(new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'upstream-1' },
    }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    await relay.handleRequest(makeRequest());

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(200);
    expect(responses[0]!.requestId).toBe('req-1');
    expect(responses[0]!.headers['content-type']).toBe('application/json');

    // Verify fetch was called with the right URL and auth
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/messages');
    expect((opts.headers as Record<string, string>)['x-api-key']).toBe('sk-test-key');
  });

  it('rejects disallowed model', async () => {
    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-4', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(403);
    const body = JSON.parse(new TextDecoder().decode(responses[0]!.body)) as { error: string };
    expect(body.error).toContain('not in the allowed list');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows any model when allowedModels is empty', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig({ allowedModels: [] }), callbacks);
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'any-model', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(200);
  });

  it('rewrites announced model names to upstream model IDs before relay', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(
      makeConfig({
        allowedModels: ['kimi2.5'],
        modelRewriteMap: {
          'kimi2.5': 'together/kimi2.5',
        },
      }),
      callbacks,
    );

    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'kimi2.5', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = opts.body as Uint8Array | undefined;
    const parsed = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array(0))) as { model?: string };
    expect(parsed.model).toBe('together/kimi2.5');
  });

  it('enforces concurrency limit', async () => {
    // Create a fetch that blocks until we resolve it
    let resolveFirst!: (value: Response) => void;
    const firstFetch = new Promise<Response>((resolve) => { resolveFirst = resolve; });

    fetchMock.mockReturnValueOnce(firstFetch);

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig({ maxConcurrency: 1 }), callbacks);

    // Start first request (fills concurrency) — do NOT await
    const p1 = relay.handleRequest(makeRequest({ requestId: 'req-1' }));

    // Yield to allow the first handleRequest to progress to its await
    await new Promise((r) => setTimeout(r, 0));

    // Active count should be 1 now
    expect(relay.getActiveCount()).toBe(1);

    // Second request should be rejected (concurrency full)
    await relay.handleRequest(makeRequest({ requestId: 'req-2' }));
    expect(responses).toHaveLength(1);
    expect(responses[0]!.requestId).toBe('req-2');
    expect(responses[0]!.statusCode).toBe(429);

    // Complete first request
    resolveFirst(new Response('{}', { status: 200 }));
    await p1;
    expect(responses).toHaveLength(2);
    expect(responses[1]!.requestId).toBe('req-1');
    expect(responses[1]!.statusCode).toBe(200);

    // Now concurrency is free, third request should work
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await relay.handleRequest(makeRequest({ requestId: 'req-3' }));
    expect(responses).toHaveLength(3);
    expect(responses[2]!.requestId).toBe('req-3');
    expect(responses[2]!.statusCode).toBe(200);
  });

  it('strips hop-by-hop and internal headers from request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    await relay.handleRequest(makeRequest({
      headers: {
        'content-type': 'application/json',
        'connection': 'keep-alive',
        'x-antseed-provider': 'anthropic',
        'host': 'localhost:3000',
        'x-custom': 'keep-me',
      },
    }));

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = opts.headers as Record<string, string>;
    expect(sentHeaders['connection']).toBeUndefined();
    expect(sentHeaders['x-antseed-provider']).toBeUndefined();
    expect(sentHeaders['host']).toBeUndefined();
    expect(sentHeaders['x-custom']).toBe('keep-me');
  });

  it('uses tokenProvider when present', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const tokenProvider = {
      getToken: vi.fn().mockResolvedValue('fresh-token'),
      stop: vi.fn(),
    };

    const relay = new HttpRelay(
      makeConfig({
        authHeaderName: 'authorization',
        authHeaderValue: 'Bearer old-token',
        tokenProvider,
      }),
      callbacks,
    );

    await relay.handleRequest(makeRequest());

    expect(tokenProvider.getToken).toHaveBeenCalledOnce();
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = opts.headers as Record<string, string>;
    expect(sentHeaders['authorization']).toBe('Bearer fresh-token');
  });

  it('returns 502 on fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    await relay.handleRequest(makeRequest());

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(502);
    const body = JSON.parse(new TextDecoder().decode(responses[0]!.body)) as { error: string };
    expect(body.error).toContain('Connection refused');
  });

  it('forwards SSE as response-start plus chunks', async () => {
    const sseChunks = [
      'event: message\ndata: {"text":"Hello"}\n\n',
      'event: message\ndata: {"text":"World"}\n\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const responses: SerializedHttpResponse[] = [];
    const responseChunks: SerializedHttpResponseChunk[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    await relay.handleRequest(makeRequest());

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(200);
    expect(responses[0]!.headers['x-antseed-streaming']).toBe('1');
    expect(responses[0]!.body.length).toBe(0);

    expect(responseChunks).toHaveLength(3);
    expect(responseChunks[0]!.done).toBe(false);
    expect(responseChunks[1]!.done).toBe(false);
    expect(responseChunks[2]!.done).toBe(true);

    const bodyText = new TextDecoder().decode(Buffer.concat(
      responseChunks
        .filter((chunk) => chunk.data.length > 0)
        .map((chunk) => Buffer.from(chunk.data))
    ));
    expect(bodyText).toContain('Hello');
    expect(bodyText).toContain('World');
  });

  it('allows GET requests through model validation', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig({ allowedModels: ['claude-sonnet-4-20250514'] }), callbacks);
    await relay.handleRequest(makeRequest({
      method: 'GET',
      path: '/v1/models',
      body: new Uint8Array(0),
    }));

    expect(responses[0]!.statusCode).toBe(200);
  });

  it('accepts upstream (full) model names via modelRewriteMap', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(
      makeConfig({
        allowedModels: ['kimi-k2.5'],
        modelRewriteMap: { 'kimi-k2.5': 'moonshotai/kimi-k2.5' },
      }),
      callbacks,
    );

    // Buyer sends the full upstream name — should still be accepted
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'moonshotai/kimi-k2.5', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses[0]!.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Body should pass through unchanged (no rewrite entry for the full name)
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(new TextDecoder().decode(opts.body as Uint8Array)) as { model?: string };
    expect(parsed.model).toBe('moonshotai/kimi-k2.5');
  });

  it('tracks active count correctly', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const callbacks: RelayCallbacks = {
      onResponse: () => {},
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    expect(relay.getActiveCount()).toBe(0);

    await relay.handleRequest(makeRequest());
    expect(relay.getActiveCount()).toBe(0); // decremented after completion
  });
});

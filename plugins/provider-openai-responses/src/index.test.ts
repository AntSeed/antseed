import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import plugin, {
  decodeJwtPayload,
  getJwtExpiration,
  isAuthExpiringSoon,
  readAuthContext,
  refreshAuthContext,
} from './index.js';

const originalFetch = globalThis.fetch;

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

function writeAuthFile(contents: Record<string, unknown>): string {
  const dir = join(tmpdir(), `antseed-openai-responses-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
}

function readAuthFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('provider-openai-responses plugin', () => {
  it('has correct metadata', () => {
    expect(plugin.name).toBe('openai-responses');
    expect(plugin.displayName).toBe('OpenAI Responses');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('advertises openai-responses protocol', () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-jwt',
          },
        }),
      },
    });
    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });
    expect(provider.serviceApiProtocols?.['gpt-5-codex']).toEqual(['openai-responses']);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('reads account id from JWT claim when available', () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-jwt',
          },
        }),
      },
    });

    expect(readAuthContext(authFile)).toEqual({
      accessToken: expect.any(String),
      accountId: 'acct-jwt',
    });
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('falls back to account_id from auth file', () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({ sub: 'user-1' }),
        account_id: 'acct-file',
      },
    });

    expect(readAuthContext(authFile).accountId).toBe('acct-file');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('decodes JWT payloads', () => {
    const token = makeJwt({ sub: 'abc', exp: 123 });
    expect(decodeJwtPayload(token)).toEqual({ sub: 'abc', exp: 123 });
    expect(getJwtExpiration(token)).toBe(123000);
  });

  it('detects expiring auth contexts', () => {
    expect(isAuthExpiringSoon({
      accessToken: 'token',
      accountId: 'acct',
      expiresAt: Date.now() + 1000,
    })).toBe(true);
  });

  it('returns 404 for unsupported paths like /v1/models', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex,o4-mini',
    });

    const response = await provider.handleRequest({
      requestId: 'req-models',
      method: 'GET',
      path: '/v1/models',
      headers: {},
      body: new Uint8Array(0),
    });

    expect(response.statusCode).toBe(404);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('relays /v1/responses to Codex backend with required headers', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-jwt',
          },
        }),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect((init.headers as Record<string, string>)['authorization']).toMatch(/^Bearer /);
    expect((init.headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-jwt');
    expect((init.headers as Record<string, string>)['openai-beta']).toBe('responses=experimental');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('rewrites announced service names via alias map', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'codex',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"codex":"gpt-5-codex"}',
    });

    await provider.handleRequest({
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'codex',
        input: 'hello',
        stream: false,
      })),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0))) as { model: string };
    expect(body.model).toBe('gpt-5-codex');
    expect(body.store).toBe(false);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('preserves an explicit store value from the caller', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    await provider.handleRequest({
      requestId: 'req-store',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        store: true,
        stream: false,
      })),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0))) as { store: boolean };
    expect(body.store).toBe(true);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('retries transient upstream failures', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('refreshes tokens and persists auth.json when expired', async () => {
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const refreshed = await refreshAuthContext(authFile);

    expect(refreshed.accountId).toBe('acct-new');
    expect(refreshed.refreshToken).toBe('refresh-2');
    const saved = readAuthFile(authFile);
    expect((saved.tokens as Record<string, unknown>).access_token).toBe(freshToken);
    expect((saved.tokens as Record<string, unknown>).refresh_token).toBe('refresh-2');
    expect(saved.last_refresh).toEqual(expect.any(String));
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('preserves existing non-token fields when refreshing auth.json', async () => {
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      OPENAI_API_KEY: 'legacy',
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await refreshAuthContext(authFile);

    const saved = readAuthFile(authFile);
    expect(saved.OPENAI_API_KEY).toBe('legacy');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('times out token refresh requests', async () => {
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort('timeout'));
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      throw new Error('expected aborted signal');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(refreshAuthContext(authFile)).rejects.toThrow('timed out');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('refreshes before request when access token is expired', async () => {
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-expired',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://auth.openai.com/oauth/token');
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>).toMatchObject({
      'chatgpt-account-id': 'acct-new',
    });
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('refreshes and retries once on 401', async () => {
    const currentToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 7200_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: currentToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-401',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://auth.openai.com/oauth/token');
    expect(((fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-new');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('retries transient failures that happen after a 401 refresh', async () => {
    const currentToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 7200_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: currentToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('temporary failure', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-401-transient',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('caches auth context between non-refreshing requests', async () => {
    const initialToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-initial',
      },
    });
    const changedToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-changed',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: initialToken,
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    await provider.handleRequest({
      requestId: 'req-cache-1',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    writeFileSync(authFile, JSON.stringify({
      tokens: {
        access_token: changedToken,
      },
    }), 'utf8');

    await provider.handleRequest({
      requestId: 'req-cache-2',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello again',
        stream: false,
      })),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-initial');
    expect(((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-initial');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('streams SSE responses through callbacks and reconstructs the full body', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"id":"resp_1"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const starts: Array<{ statusCode: number }> = [];
    const chunks: SerializedChunk[] = [];
    const response = await provider.handleRequestStream(
      {
        requestId: 'req-stream',
        method: 'POST',
        path: '/v1/responses',
        headers: {
          'content-type': 'application/json',
        },
        body: new TextEncoder().encode(JSON.stringify({
          model: 'gpt-5-codex',
          input: 'hello',
          stream: true,
        })),
      },
      {
        onResponseStart: (start) => starts.push({ statusCode: start.statusCode }),
        onResponseChunk: (chunk) => chunks.push({
          done: chunk.done,
          text: new TextDecoder().decode(chunk.data),
        }),
      },
    );

    expect(starts).toEqual([{ statusCode: 200 }]);
    expect(chunks.some((chunk) => chunk.text.includes('response.created'))).toBe(true);
    expect(chunks.at(-1)?.done).toBe(true);
    expect(new TextDecoder().decode(response.body)).toContain('[DONE]');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('does not emit SSE callbacks for retryable attempts', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const retryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"id":"resp_retry"}\n\n'));
        controller.close();
      },
    });
    const successStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"id":"resp_final"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(retryStream, {
        status: 503,
        headers: { 'content-type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(successStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const starts: Array<{ statusCode: number }> = [];
    const chunks: SerializedChunk[] = [];
    const response = await provider.handleRequestStream(
      {
        requestId: 'req-stream-retry',
        method: 'POST',
        path: '/v1/responses',
        headers: {
          'content-type': 'application/json',
        },
        body: new TextEncoder().encode(JSON.stringify({
          model: 'gpt-5-codex',
          input: 'hello',
          stream: true,
        })),
      },
      {
        onResponseStart: (start) => starts.push({ statusCode: start.statusCode }),
        onResponseChunk: (chunk) => chunks.push({
          done: chunk.done,
          text: new TextDecoder().decode(chunk.data),
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(starts).toEqual([{ statusCode: 200 }]);
    expect(chunks.some((chunk) => chunk.text.includes('resp_retry'))).toBe(false);
    expect(chunks.some((chunk) => chunk.text.includes('resp_final'))).toBe(true);
    expect(new TextDecoder().decode(response.body)).toContain('resp_final');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('returns a 502 after upstream timeout retries are exhausted', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort('timeout'));
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('missing signal'));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        const onAbort = () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const pendingResponse = provider.handleRequest({
      requestId: 'req-timeout',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });
    const response = await pendingResponse;

    expect(response.statusCode).toBe(502);
    expect(new TextDecoder().decode(response.body)).toContain('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });
});

interface SerializedChunk {
  done: boolean;
  text: string;
}

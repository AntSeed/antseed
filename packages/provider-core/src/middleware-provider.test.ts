import { describe, it, expect } from 'vitest';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from '@antseed/node';
import { MiddlewareProvider } from './middleware-provider.js';
import type { ProviderMiddleware } from './middleware.js';

// ---------------------------------------------------------------------------
// Minimal mock provider that records the last request body it received
// ---------------------------------------------------------------------------

function makeBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function parseBody(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

function mockProvider(): Provider & { lastBody: () => Record<string, unknown> } {
  let _lastBody: Record<string, unknown> = {};
  const p: Provider & { lastBody: () => Record<string, unknown> } = {
    name: 'mock',
    models: ['model-a', 'model-b'],
    pricing: undefined,
    maxConcurrency: 1,
    modelCategories: undefined,
    modelApiProtocols: undefined,
    getCapacity: () => ({ available: 1, total: 1 }),
    handleRequest: async (req: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
      _lastBody = parseBody(req.body);
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
    lastBody: () => _lastBody,
  };
  return p;
}

function makeReq(body: Record<string, unknown>, path = '/v1/messages'): SerializedHttpRequest {
  return { method: 'POST', path, headers: {}, body: makeBody(body) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mw(
  content: string,
  position: ProviderMiddleware['position'],
  models?: string[],
): ProviderMiddleware {
  return models ? { content, position, models } : { content, position };
}

// ---------------------------------------------------------------------------
// Per-model filtering
// ---------------------------------------------------------------------------

describe('MiddlewareProvider — per-model filtering', () => {
  it('applies middleware when request model matches models list', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('injected', 'system-prepend', ['model-a']),
    ]);
    await provider.handleRequest(makeReq({ model: 'model-a', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('injected\n\nbase');
  });

  it('skips middleware when request model is not in models list', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('injected', 'system-prepend', ['model-a']),
    ]);
    await provider.handleRequest(makeReq({ model: 'model-b', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('base');
  });

  it('applies middleware without models filter to all models', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('global', 'system-prepend'),
    ]);

    await provider.handleRequest(makeReq({ model: 'model-a', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('global\n\nbase');

    await provider.handleRequest(makeReq({ model: 'model-b', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('global\n\nbase');
  });

  it('applies model-scoped and global middleware independently', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('global', 'system-prepend'),
      mw('specific', 'system-append', ['model-a']),
    ]);

    await provider.handleRequest(makeReq({ model: 'model-a', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('global\n\nbase\n\nspecific');

    await provider.handleRequest(makeReq({ model: 'model-b', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('global\n\nbase');
  });

  it('skips model-scoped middleware when request has no model field', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('injected', 'system-prepend', ['model-a']),
    ]);
    // No model field in body — cannot confirm a match, so scoped middleware is skipped
    await provider.handleRequest(makeReq({ system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('base');
  });

  it('still applies global middleware when request has no model field', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('global', 'system-prepend'),
      mw('scoped', 'system-append', ['model-a']),
    ]);
    await provider.handleRequest(makeReq({ system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('global\n\nbase');
  });

  it('returns original request unchanged when all middleware is filtered out', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('injected', 'system-prepend', ['model-a']),
    ]);
    await provider.handleRequest(makeReq({ model: 'model-b', system: 'base', messages: [] }));
    // Body passed through unmodified — system stays as-is
    expect(inner.lastBody().system).toBe('base');
  });

  it('never applies middleware with an empty models list (should be rejected at config load)', async () => {
    // models: [] means no model can ever match — the entry is effectively dead.
    // The CLI layer rejects this at load time; at the MiddlewareProvider level it
    // behaves as a no-op so nothing blows up if the object is constructed directly.
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      { content: 'injected', position: 'system-prepend', models: [] },
    ]);
    await provider.handleRequest(makeReq({ model: 'model-a', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('base');
  });
});

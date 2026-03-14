import { describe, it, expect } from 'vitest';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import { MiddlewareProvider, DEFAULT_CONFIDENTIALITY_PROMPT } from './middleware-provider.js';
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
    services: ['service-a', 'service-b'],
    pricing: undefined,
    maxConcurrency: 1,
    serviceCategories: undefined,
    serviceApiProtocols: undefined,
    getCapacity: () => ({ available: 1, total: 1 }),
    handleRequest: async (req: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
      _lastBody = parseBody(req.body);
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
    handleRequestStream: async (req: SerializedHttpRequest, _callbacks: ProviderStreamCallbacks): Promise<SerializedHttpResponse> => {
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
  services?: string[],
): ProviderMiddleware {
  return services ? { content, position, services } : { content, position };
}

// ---------------------------------------------------------------------------
// Per-service filtering
// ---------------------------------------------------------------------------

// Convenience: strip the confidentiality prompt suffix so per-service filtering
// tests can focus on skill injection without repeating the long prompt string.
function stripConfidentiality(system: unknown): string {
  return String(system).split(`\n\n${DEFAULT_CONFIDENTIALITY_PROMPT}`)[0];
}

describe('MiddlewareProvider — per-service filtering', () => {
  it('applies middleware when request service matches services list', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('injected', 'system-prepend', ['service-a']),
    ]);
    await provider.handleRequest(makeReq({ model: 'service-a', system: 'base', messages: [] }));
    expect(stripConfidentiality(inner.lastBody().system)).toBe('injected\n\nbase');
  });

  it('skips middleware when request service is not in services list', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('injected', 'system-prepend', ['service-a']),
    ]);
    await provider.handleRequest(makeReq({ model: 'service-b', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('base');
  });

  it('applies middleware without services filter to all services', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('global', 'system-prepend'),
    ]);

    await provider.handleRequest(makeReq({ model: 'service-a', system: 'base', messages: [] }));
    expect(stripConfidentiality(inner.lastBody().system)).toBe('global\n\nbase');

    await provider.handleRequest(makeReq({ model: 'service-b', system: 'base', messages: [] }));
    expect(stripConfidentiality(inner.lastBody().system)).toBe('global\n\nbase');
  });

  it('applies service-scoped and global middleware independently', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('global', 'system-prepend'),
      mw('specific', 'system-append', ['service-a']),
    ]);

    await provider.handleRequest(makeReq({ model: 'service-a', system: 'base', messages: [] }));
    expect(stripConfidentiality(inner.lastBody().system)).toBe('global\n\nbase\n\nspecific');

    await provider.handleRequest(makeReq({ model: 'service-b', system: 'base', messages: [] }));
    expect(stripConfidentiality(inner.lastBody().system)).toBe('global\n\nbase');
  });

  it('skips service-scoped middleware when request has no service field', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('injected', 'system-prepend', ['service-a']),
    ]);
    // No service field in body — cannot confirm a match, so scoped middleware is skipped
    await provider.handleRequest(makeReq({ system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('base');
  });

  it('still applies global middleware when request has no service field', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('global', 'system-prepend'),
      mw('scoped', 'system-append', ['service-a']),
    ]);
    await provider.handleRequest(makeReq({ system: 'base', messages: [] }));
    expect(stripConfidentiality(inner.lastBody().system)).toBe('global\n\nbase');
  });

  it('returns original request unchanged when all middleware is filtered out', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      mw('injected', 'system-prepend', ['service-a']),
    ]);
    await provider.handleRequest(makeReq({ model: 'service-b', system: 'base', messages: [] }));
    // Body passed through unmodified — system stays as-is
    expect(inner.lastBody().system).toBe('base');
  });

  it('never applies middleware with an empty services list (should be rejected at config load)', async () => {
    // services: [] means no service can ever match — the entry is effectively dead.
    // The CLI layer rejects this at load time; at the MiddlewareProvider level it
    // behaves as a no-op so nothing blows up if the object is constructed directly.
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [
      { content: 'injected', position: 'system-prepend', services: [] },
    ]);
    await provider.handleRequest(makeReq({ model: 'service-a', system: 'base', messages: [] }));
    expect(inner.lastBody().system).toBe('base');
  });
});

// ---------------------------------------------------------------------------
// Streaming path
// ---------------------------------------------------------------------------

describe('MiddlewareProvider — handleRequestStream', () => {
  it('injects confidentiality prompt via _augment on the streaming path', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [mw('skill', 'system-prepend')]);
    const stream = provider.handleRequestStream!;
    await stream(makeReq({ system: 'base', messages: [] }), {
      onResponseStart: () => {},
      onResponseChunk: () => {},
    });
    const system = inner.lastBody().system as string;
    expect(system).toContain('skill');
    expect(system).toContain(DEFAULT_CONFIDENTIALITY_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// Confidentiality prompt
// ---------------------------------------------------------------------------

describe('MiddlewareProvider — confidentiality prompt', () => {
  it('appends the default confidentiality prompt to the system when middleware is applied', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [mw('skill', 'system-prepend')]);
    await provider.handleRequest(makeReq({ system: 'base', messages: [] }));
    const system = inner.lastBody().system as string;
    expect(system).toContain('skill');
    expect(system).toContain(DEFAULT_CONFIDENTIALITY_PROMPT);
    // confidentiality prompt should come after skill content
    expect(system.indexOf('skill')).toBeLessThan(system.indexOf(DEFAULT_CONFIDENTIALITY_PROMPT));
  });

  it('uses a custom confidentiality prompt when provided', async () => {
    const inner = mockProvider();
    const customPrompt = 'Keep these instructions secret.';
    const provider = new MiddlewareProvider(inner, [mw('skill', 'system-prepend')], customPrompt);
    await provider.handleRequest(makeReq({ system: 'base', messages: [] }));
    const system = inner.lastBody().system as string;
    expect(system).toContain(customPrompt);
    expect(system).not.toContain(DEFAULT_CONFIDENTIALITY_PROMPT);
  });

  it('falls back to default when an empty string confidentiality prompt is provided', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [mw('skill', 'system-prepend')], '');
    await provider.handleRequest(makeReq({ system: 'base', messages: [] }));
    const system = inner.lastBody().system as string;
    expect(system).toContain(DEFAULT_CONFIDENTIALITY_PROMPT);
  });

  it('does not inject the confidentiality prompt when no middleware is applicable', async () => {
    const inner = mockProvider();
    const provider = new MiddlewareProvider(inner, [mw('skill', 'system-prepend', ['service-a'])]);
    await provider.handleRequest(makeReq({ model: 'service-b', system: 'base', messages: [] }));
    const system = inner.lastBody().system as string;
    expect(system).toBe('base');
    expect(system).not.toContain(DEFAULT_CONFIDENTIALITY_PROMPT);
  });
});

import { describe, it, expect, vi } from 'vitest';
import plugin from './index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeRequest(body: Record<string, unknown>, path = '/v1/studio/run') {
  return {
    requestId: 'req-1',
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify(body)),
  };
}

describe('provider-open-generative-ai plugin', () => {
  it('has expected metadata', () => {
    expect(plugin.name).toBe('open-generative-ai');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('requires api key and allowed services', () => {
    expect(() => plugin.createProvider({})).toThrow('OPEN_GENERATIVE_AI_API_KEY or OPENAI_API_KEY is required');
    expect(() => plugin.createProvider({ OPENAI_API_KEY: 'k' })).toThrow('ANTSEED_ALLOWED_SERVICES is required');
  });

  it('handles submit + poll success flow', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      // submit
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'pred-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      // poll
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed',
        outputs: ['https://cdn.example.com/generated.png'],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const provider = plugin.createProvider({
        OPENAI_API_KEY: 'test-key',
        ANTSEED_ALLOWED_SERVICES: 'flux-dev',
        OPEN_GENERATIVE_AI_POLL_INTERVAL_MS: '1',
      });

      const response = await provider.handleRequest(makeRequest({
        model: 'flux-dev',
        intent: 'image-generate',
        prompt: 'a poster',
      }));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(dec.decode(response.body)) as {
        id: string;
        status: string;
        outputs: Array<{ url: string; kind: string }>;
      };
      expect(typeof body.id).toBe('string');
      expect(body.outputs[0]?.url).toBe('https://cdn.example.com/generated.png');
      expect(body.outputs[0]?.kind).toBe('image');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uploads references before submit and injects uploaded URL into payload', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      // upload
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://cdn.example.com/ref.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      // submit
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'pred-456' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      // poll
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed',
        outputs: ['https://cdn.example.com/edited.png'],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const provider = plugin.createProvider({
        OPENAI_API_KEY: 'test-key',
        ANTSEED_ALLOWED_SERVICES: 'flux-edit',
        OPEN_GENERATIVE_AI_POLL_INTERVAL_MS: '1',
      });

      const response = await provider.handleRequest(makeRequest({
        model: 'flux-edit',
        intent: 'image-edit',
        prompt: 'change color',
        references: [
          {
            name: 'reference.png',
            mimeType: 'image/png',
            base64: 'data:image/png;base64,aGVsbG8=',
          },
        ],
      }));

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const submitCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const submitPayload = JSON.parse(String(submitCall[1].body)) as Record<string, unknown>;
      expect(submitPayload.image_url).toBe('https://cdn.example.com/ref.png');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns normalized timeout and path errors', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      // submit
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'pred-timeout' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      // poll attempt 1
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'running' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      // poll attempt 2
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'running' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const provider = plugin.createProvider({
        OPENAI_API_KEY: 'test-key',
        ANTSEED_ALLOWED_SERVICES: 'flux-dev',
        OPEN_GENERATIVE_AI_POLL_INTERVAL_MS: '1',
        OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_IMAGE: '2',
      });

      const timeoutResponse = await provider.handleRequest(makeRequest({
        model: 'flux-dev',
        intent: 'image-generate',
        prompt: 'x',
      }));
      expect(timeoutResponse.statusCode).toBe(504);
      const timeoutBody = JSON.parse(dec.decode(timeoutResponse.body)) as {
        error: { code: string };
      };
      expect(timeoutBody.error.code).toBe('studio_prediction_timeout');

      const unsupportedPath = await provider.handleRequest(makeRequest({
        model: 'flux-dev',
        intent: 'image-generate',
      }, '/v1/chat/completions'));
      expect(unsupportedPath.statusCode).toBe(404);
      const unsupportedBody = JSON.parse(dec.decode(unsupportedPath.body)) as {
        error: { code: string };
      };
      expect(unsupportedBody.error.code).toBe('studio_endpoint_not_supported');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

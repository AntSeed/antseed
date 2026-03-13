import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

describe('provider-unified plugin', () => {
  it('has expected metadata', () => {
    expect(plugin.name).toBe('unified');
    expect(plugin.displayName).toBe('Unified Provider');
    expect(plugin.type).toBe('provider');
  });

  it('requires upstream config', () => {
    expect(() => plugin.createProvider({})).toThrow('ANTSEED_UPSTREAMS_JSON is required');
  });

  it('builds one provider with multiple upstream routes', () => {
    const provider = plugin.createProvider({
      ANTSEED_UPSTREAMS_JSON: JSON.stringify([
        {
          name: 'openai',
          type: 'openai',
          apiKey: 'sk-openai',
          allowedServices: ['gpt-4o-mini'],
          pricing: {
            defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          },
        },
        {
          name: 'anthropic',
          type: 'anthropic',
          apiKey: 'sk-anthropic',
          allowedServices: ['claude-sonnet-4-5'],
          pricing: {
            defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 4 },
          },
        },
      ]),
      ANTSEED_DEFAULT_UPSTREAM: 'openai',
    });

    expect(provider.name).toBe('unified');
    expect(provider.services).toEqual(['gpt-4o-mini', 'claude-sonnet-4-5']);
    expect(provider.pricing.defaults).toEqual({ inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
    expect(provider.pricing.services?.['claude-sonnet-4-5']).toEqual({ inputUsdPerMillion: 3, outputUsdPerMillion: 4 });
    expect(provider.maxConcurrency).toBe(20);
  });

  it('routes by service to the matching upstream', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const provider = plugin.createProvider({
        ANTSEED_UPSTREAMS_JSON: JSON.stringify([
          {
            name: 'openai',
            type: 'openai',
            apiKey: 'sk-openai',
            allowedServices: ['gpt-4o-mini'],
          },
          {
            name: 'anthropic',
            type: 'anthropic',
            apiKey: 'sk-anthropic',
            allowedServices: ['claude-sonnet-4-5'],
          },
        ]),
      });

      await provider.handleRequest({
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('supports service rewrites for OpenAI-compatible upstreams', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const provider = plugin.createProvider({
        ANTSEED_UPSTREAMS_JSON: JSON.stringify([
          {
            name: 'openai',
            type: 'openai',
            apiKey: 'sk-openai',
            allowedServices: ['kimi-k2'],
            upstreamServicePrefix: 'openrouter',
          },
        ]),
      });

      await provider.handleRequest({
        requestId: 'req-2',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'kimi-k2', messages: [] })),
      });

      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(new TextDecoder().decode(requestInit.body as Uint8Array)) as { model: string };
      expect(body.model).toBe('openrouter/kimi-k2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

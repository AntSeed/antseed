import { describe, it, expect, vi } from 'vitest';
import plugin from './index.js';

describe('provider-openai plugin', () => {
  it('has correct name and metadata', () => {
    expect(plugin.name).toBe('openai');
    expect(plugin.displayName).toBe('OpenAI-Compatible');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('has configSchema with expected fields', () => {
    const keys = plugin.configSchema!.map((f) => f.key);
    expect(keys).toContain('OPENAI_API_KEY');
    expect(keys).toContain('OPENAI_BASE_URL');
    expect(keys).toContain('OPENAI_PROVIDER_FLAVOR');
    expect(keys).toContain('OPENAI_UPSTREAM_PROVIDER');
    expect(keys).toContain('OPENAI_UPSTREAM_MODEL_PREFIX');
    expect(keys).toContain('OPENAI_MODEL_ALIAS_MAP_JSON');
    expect(keys).toContain('ANTSEED_INPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_OUTPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_MAX_CONCURRENCY');
    expect(keys).toContain('ANTSEED_ALLOWED_MODELS');
  });

  it('creates provider with valid config', () => {
    const provider = plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
    });
    expect(provider.name).toBe('openai');
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(10);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(10);
    expect(provider.maxConcurrency).toBe(10);
  });

  it('supports openrouter flavor-specific behavior', () => {
    const provider = plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_PROVIDER_FLAVOR: 'openrouter',
      OPENAI_UPSTREAM_PROVIDER: 'together',
    });

    expect(provider.name).toBe('openai');
  });

  it('requires API key', () => {
    expect(() => plugin.createProvider({})).toThrow('OPENAI_API_KEY is required');
  });

  it('applies custom pricing and concurrency', () => {
    const provider = plugin.createProvider({
      OPENAI_API_KEY: 'sk-test-key',
      ANTSEED_INPUT_USD_PER_MILLION: '3',
      ANTSEED_OUTPUT_USD_PER_MILLION: '7',
      ANTSEED_MAX_CONCURRENCY: '5',
    });
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(3);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(7);
    expect(provider.maxConcurrency).toBe(5);
  });

  it('rewrites announced model names to upstream prefixed models', async () => {
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
        OPENAI_API_KEY: 'sk-test-key',
        ANTSEED_ALLOWED_MODELS: 'kimi2.5',
        OPENAI_UPSTREAM_MODEL_PREFIX: 'together',
      });

      const response = await provider.handleRequest({
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
        },
        body: new TextEncoder().encode(JSON.stringify({ model: 'kimi2.5', messages: [] })),
      });

      expect(response.statusCode).toBe(200);
      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsedBody = JSON.parse(
        new TextDecoder().decode((requestInit.body as Uint8Array) ?? new Uint8Array(0)),
      ) as { model?: string };
      expect(parsedBody.model).toBe('together/kimi2.5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

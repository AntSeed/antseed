import { describe, it, expect } from 'vitest';
import plugin from './index.js';

describe('provider-claude-oauth plugin manifest', () => {
  it('has correct plugin metadata', () => {
    expect(plugin.name).toBe('claude-oauth');
    expect(plugin.displayName).toBe('Claude (OAuth)');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.type).toBe('provider');
    expect(plugin.description).toBe('Claude OAuth provider (testing and development only)');
  });

  it('exposes configSchema with required fields', () => {
    expect(plugin.configSchema).toBeDefined();
    const keys = plugin.configSchema!.map(f => f.key);
    expect(keys).toContain('CLAUDE_ACCESS_TOKEN');
    expect(keys).toContain('CLAUDE_REFRESH_TOKEN');
    expect(keys).toContain('CLAUDE_TOKEN_EXPIRES_AT');
    expect(keys).toContain('CLAUDE_OAUTH_CLIENT_ID');
    expect(keys).toContain('ANTSEED_INPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_OUTPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_MAX_CONCURRENCY');
    expect(keys).toContain('ANTSEED_ALLOWED_SERVICES');
    const accessField = plugin.configSchema!.find(f => f.key === 'CLAUDE_ACCESS_TOKEN');
    expect(accessField!.required).toBe(true);
    expect(accessField!.type).toBe('secret');
    const clientIdField = plugin.configSchema!.find(f => f.key === 'CLAUDE_OAUTH_CLIENT_ID');
    expect(clientIdField!.required).toBe(true);
  });
});

describe('createProvider', () => {
  it('creates provider with access token only (static)', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
    });
    expect(provider).toBeDefined();
    expect(provider.name).toBe('claude-oauth');
    expect(provider.maxConcurrency).toBe(5);
  });

  it('creates provider with access + refresh token (OAuth)', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_REFRESH_TOKEN: 'test-refresh-token',
      CLAUDE_TOKEN_EXPIRES_AT: String(Date.now() + 3600_000),
      CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
    });
    expect(provider).toBeDefined();
    expect(provider.name).toBe('claude-oauth');
  });

  it('rejects missing access token', () => {
    expect(() => plugin.createProvider({})).toThrow('CLAUDE_ACCESS_TOKEN is required');
  });

  it('rejects missing client ID', () => {
    expect(() => plugin.createProvider({ CLAUDE_ACCESS_TOKEN: 'tok' })).toThrow('CLAUDE_OAUTH_CLIENT_ID is required');
  });

  it('provider has correct name and pricing', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
      ANTSEED_INPUT_USD_PER_MILLION: '15',
      ANTSEED_OUTPUT_USD_PER_MILLION: '30',
      ANTSEED_MAX_CONCURRENCY: '3',
    });
    expect(provider.name).toBe('claude-oauth');
    expect(provider.pricing).toEqual({
      defaults: {
        inputUsdPerMillion: 15,
        outputUsdPerMillion: 30,
      },
    });
    expect(provider.maxConcurrency).toBe(3);
  });

  it('injects anthropic headers at provider relay layer', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
    }) as any;

    const extraHeaders = provider?._relay?._config?.extraHeaders as Record<string, string> | undefined;
    expect(extraHeaders).toBeDefined();
    expect(extraHeaders?.['anthropic-version']).toBe('2023-06-01');
    expect(extraHeaders?.['anthropic-beta']).toBe('oauth-2025-04-20');
  });
});

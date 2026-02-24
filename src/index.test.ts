import { describe, it, expect } from 'vitest';
import plugin from './index.js';

describe('provider-anthropic plugin', () => {
  it('has correct name and metadata', () => {
    expect(plugin.name).toBe('anthropic');
    expect(plugin.displayName).toBe('Anthropic');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('has configSchema with expected fields', () => {
    const keys = plugin.configSchema!.map((f) => f.key);
    expect(keys).toContain('ANTHROPIC_API_KEY');
    expect(keys).toContain('ANTSEED_INPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_OUTPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_MAX_CONCURRENCY');
    expect(keys).toContain('ANTSEED_ALLOWED_MODELS');
    expect(keys).not.toContain('ANTSEED_AUTH_TYPE');
  });

  it('requires API key', () => {
    expect(() => plugin.createProvider({})).toThrow('ANTHROPIC_API_KEY is required');
  });

  it('creates provider with API key', () => {
    const provider = plugin.createProvider({
      ANTHROPIC_API_KEY: 'sk-test-key',
    });
    expect(provider.name).toBe('anthropic');
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(10);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(10);
    expect(provider.maxConcurrency).toBe(10);
  });

  it('applies custom pricing', () => {
    const provider = plugin.createProvider({
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTSEED_INPUT_USD_PER_MILLION: '5',
      ANTSEED_OUTPUT_USD_PER_MILLION: '15',
    });
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(5);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(15);
  });

  it('applies custom concurrency', () => {
    const provider = plugin.createProvider({
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTSEED_MAX_CONCURRENCY: '5',
    });
    expect(provider.maxConcurrency).toBe(5);
  });
});

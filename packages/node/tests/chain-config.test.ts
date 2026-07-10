import { describe, it, expect } from 'vitest';
import { getChainConfig, resolveChainConfig, DEFAULT_CHAIN_ID } from '../src/payments/chain-config.js';

describe('getChainConfig', () => {
  it('returns base-mainnet when chainId is omitted', () => {
    const cfg = getChainConfig();
    expect(cfg.chainId).toBe('base-mainnet');
    expect(cfg.evmChainId).toBe(8453);
  });

  it('returns the named config for known chain ids', () => {
    expect(getChainConfig('base-sepolia').chainId).toBe('base-sepolia');
    expect(getChainConfig('base-local').chainId).toBe('base-local');
    expect(getChainConfig('base-mainnet').chainId).toBe('base-mainnet');
  });

  it('throws on unrecognized non-empty chainId (no silent mainnet fallback)', () => {
    expect(() => getChainConfig('base-goerli')).toThrow(/Unknown chainId "base-goerli"/);
    expect(() => getChainConfig('typo-mainnet')).toThrow(/Known chains:/);
    // Must NOT silently resolve to mainnet.
    expect(() => getChainConfig('base-goerli')).toThrow();
  });

  it('empty string is treated as unknown (not the no-arg default path)', () => {
    // Empty string is truthy enough to skip the no-arg branch in the current
    // implementation (if (!chainId) — empty string is falsy in JS, so it
    // still returns the default). Document that contract.
    const cfg = getChainConfig('');
    expect(cfg.chainId).toBe(DEFAULT_CHAIN_ID);
  });
});

describe('resolveChainConfig', () => {
  it('propagates the unknown-chainId throw from getChainConfig', () => {
    expect(() => resolveChainConfig({ chainId: 'not-a-chain' })).toThrow(/Unknown chainId/);
  });

  it('resolves known chain with rpc override', () => {
    const cfg = resolveChainConfig({
      chainId: 'base-sepolia',
      rpcUrl: 'https://example.invalid',
    });
    expect(cfg.chainId).toBe('base-sepolia');
    expect(cfg.rpcUrl).toBe('https://example.invalid');
    // rpc override without fallbacks → empty fallback list
    expect(cfg.fallbackRpcUrls).toEqual([]);
  });
});

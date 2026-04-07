import { describe, it, expect } from 'vitest';
import { estimateTokensFromBytes, estimateTokensFromText, computeCostUsdc, estimateCostFromBytes } from '../src/payments/pricing.js';

describe('pricing utilities', () => {
  // ── estimateTokensFromBytes ──

  it('estimateTokensFromBytes uses tokenx for accurate estimation', () => {
    const text = 'Hello world, this is a test of the tokenizer.';
    const bytes = new TextEncoder().encode(text);
    const tokens = estimateTokensFromBytes(bytes);
    // tokenx should give a reasonable estimate — roughly 10-12 tokens for this text
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
  });

  it('estimateTokensFromBytes with empty Uint8Array returns 0', () => {
    expect(estimateTokensFromBytes(new Uint8Array(0))).toBe(0);
  });

  it('estimateTokensFromBytes with code content gives reasonable estimate', () => {
    const code = 'function hello() { return "world"; }\nconst x = 42;';
    const bytes = new TextEncoder().encode(code);
    const tokens = estimateTokensFromBytes(bytes);
    // Code typically has more tokens per byte than prose
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(30);
  });

  // ── estimateTokensFromText ──

  it('estimateTokensFromText returns reasonable count for English text', () => {
    const tokens = estimateTokensFromText('The quick brown fox jumps over the lazy dog');
    expect(tokens).toBeGreaterThan(7);
    expect(tokens).toBeLessThan(15);
  });

  // ── computeCostUsdc ──

  it('computeCostUsdc computes USDC base units from tokens and pricing', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    // 100 input tokens * $3/M + 500 output tokens * $15/M
    // = 300/1M + 7500/1M = 7800/1M USD = $0.0078 = 7800 base units
    expect(computeCostUsdc(100, 500, pricing)).toBe(7800n);
  });

  it('computeCostUsdc returns 0 for zero tokens', () => {
    expect(computeCostUsdc(0, 0, { inputUsdPerMillion: 3, outputUsdPerMillion: 15 })).toBe(0n);
  });

  it('computeCostUsdc returns 0 for zero pricing', () => {
    expect(computeCostUsdc(1000, 1000, { inputUsdPerMillion: 0, outputUsdPerMillion: 0 })).toBe(0n);
  });

  it('computeCostUsdc applies cachedInputUsdPerMillion to cached tokens', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 };
    // 200 fresh input * $3/M + 800 cached input * $0.3/M + 100 output * $15/M
    // = 600/1M + 240/1M + 1500/1M = 2340/1M USD = $0.00234 = 2340 base units
    expect(computeCostUsdc(200, 100, pricing, 800)).toBe(2340n);
  });

  it('computeCostUsdc defaults cachedInputUsdPerMillion to inputUsdPerMillion when not set', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    // 200 fresh * $3/M + 800 cached * $3/M (no discount) + 100 output * $15/M
    // = 600/1M + 2400/1M + 1500/1M = 4500/1M = $0.0045 = 4500 base units
    expect(computeCostUsdc(200, 100, pricing, 800)).toBe(4500n);
  });

  it('computeCostUsdc with zero cached tokens matches original behavior', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 };
    // All fresh, no cached — cachedInputUsdPerMillion is irrelevant
    expect(computeCostUsdc(100, 500, pricing, 0)).toBe(7800n);
    expect(computeCostUsdc(100, 500, pricing)).toBe(7800n);
  });

  // ── estimateCostFromBytes ──

  it('estimateCostFromBytes uses tokenx for accurate cost', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    const input = new TextEncoder().encode('What is the capital of France?');
    const output = new TextEncoder().encode('The capital of France is Paris.');
    const result = estimateCostFromBytes(input, output, pricing);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.cost).toBeGreaterThan(0n);
  });
});

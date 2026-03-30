import { describe, it, expect } from 'vitest';
import { estimateTokensFromBytes, estimateTokensFromText, computeCostUsdc, estimateCostFromBytes } from '../src/payments/pricing.js';

describe('pricing utilities', () => {
  // ── estimateTokensFromBytes with number fallback (bytes/4) ──

  it('estimateTokensFromBytes with number fallback divides by 4 and rounds up', () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(1)).toBe(1);
    expect(estimateTokensFromBytes(4)).toBe(1);
    expect(estimateTokensFromBytes(5)).toBe(2);
    expect(estimateTokensFromBytes(100)).toBe(25);
    expect(estimateTokensFromBytes(401)).toBe(101);
  });

  // ── estimateTokensFromBytes with Uint8Array (tokenx) ──

  it('estimateTokensFromBytes with Uint8Array uses tokenx for accurate estimation', () => {
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

  // ── estimateCostFromBytes ──

  it('estimateCostFromBytes with number uses bytes/4 fallback', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    const result = estimateCostFromBytes(400, 2000, pricing);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(500);
    expect(result.cost).toBe(7800n);
  });

  it('estimateCostFromBytes with Uint8Array uses tokenx for more accurate cost', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    const input = new TextEncoder().encode('What is the capital of France?');
    const output = new TextEncoder().encode('The capital of France is Paris.');
    const result = estimateCostFromBytes(input, output, pricing);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.cost).toBeGreaterThan(0n);
  });

  it('estimateCostFromBytes accepts mixed types (Uint8Array input, number output)', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    const input = new TextEncoder().encode('Hello world');
    const result = estimateCostFromBytes(input, 400, pricing);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBe(100); // bytes/4 fallback for number
    expect(result.cost).toBeGreaterThan(0n);
  });
});

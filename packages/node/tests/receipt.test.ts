import { describe, it, expect } from 'vitest';
import {
  ReceiptGenerator,
  buildSignaturePayload,
  calculateCost,
  type Signer,
} from '../src/metering/receipt-generator.js';
import { ReceiptVerifier, type SignatureVerifier } from '../src/metering/receipt-verifier.js';
import type { TokenCount, UsageReceipt } from '../src/types/metering.js';

function makeTokenCount(total: number): TokenCount {
  return {
    inputTokens: Math.floor(total * 0.6),
    outputTokens: Math.ceil(total * 0.4),
    totalTokens: total,
    method: 'content-length',
    confidence: 'high',
  };
}

function makeSigner(peerId: string): Signer {
  return {
    peerId,
    sign(message: string): string {
      // Deterministic fake signature for testing
      return 'f'.repeat(128);
    },
  };
}

function makeVerifier(alwaysValid: boolean): SignatureVerifier {
  return {
    verify(_message: string, _signature: string, _publicKeyHex: string): boolean {
      return alwaysValid;
    },
  };
}

describe('calculateCost', () => {
  it('should calculate cost for 1000 tokens at 10 cents/1K', () => {
    expect(calculateCost(1000, 10)).toBe(10);
  });

  it('should round to nearest cent', () => {
    // 1500 tokens at 10 cents/1K = 15 cents
    expect(calculateCost(1500, 10)).toBe(15);
  });

  it('should return minimum of 1 cent for non-zero cost', () => {
    // 1 token at 0.001 cents/1K = 0.000001 cents -> rounds to 0, but min is 1
    expect(calculateCost(1, 1)).toBe(1);
  });

  it('should return 0 for zero tokens', () => {
    expect(calculateCost(0, 10)).toBe(0);
  });

  it('should return 0 for zero price', () => {
    expect(calculateCost(1000, 0)).toBe(0);
  });
});

describe('buildSignaturePayload', () => {
  it('should produce a pipe-delimited string', () => {
    const payload = buildSignaturePayload({
      receiptId: 'r1',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: 1000,
      provider: 'openai',
      sellerPeerId: 'seller',
      buyerPeerId: 'buyer',
      tokens: makeTokenCount(500),
      unitPriceCentsPerThousandTokens: 10,
      costCents: 5,
    });

    expect(payload).toBe('r1|s1|e1|1000|openai|seller|buyer|500|5');
  });

  it('should be deterministic', () => {
    const data = {
      receiptId: 'r1',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: 1000,
      provider: 'openai' as const,
      sellerPeerId: 'seller',
      buyerPeerId: 'buyer',
      tokens: makeTokenCount(500),
      unitPriceCentsPerThousandTokens: 10,
      costCents: 5,
    };
    expect(buildSignaturePayload(data)).toBe(buildSignaturePayload(data));
  });
});

describe('ReceiptGenerator', () => {
  it('should generate a complete receipt', () => {
    const signer = makeSigner('seller-peer-id');
    const generator = new ReceiptGenerator(signer);

    const receipt = generator.generate(
      'session-1',
      'event-1',
      'anthropic',
      'buyer-peer-id',
      makeTokenCount(2000),
      10
    );

    expect(receipt.receiptId).toBeTruthy();
    expect(receipt.sessionId).toBe('session-1');
    expect(receipt.eventId).toBe('event-1');
    expect(receipt.provider).toBe('anthropic');
    expect(receipt.sellerPeerId).toBe('seller-peer-id');
    expect(receipt.buyerPeerId).toBe('buyer-peer-id');
    expect(receipt.tokens.totalTokens).toBe(2000);
    expect(receipt.unitPriceCentsPerThousandTokens).toBe(10);
    expect(receipt.costCents).toBe(20); // 2000/1000 * 10
    expect(receipt.signature).toBeTruthy();
    expect(receipt.timestamp).toBeGreaterThan(0);
  });

  it('should produce unique receipt IDs', () => {
    const signer = makeSigner('seller');
    const generator = new ReceiptGenerator(signer);
    const tokens = makeTokenCount(100);

    const r1 = generator.generate('s', 'e1', 'openai', 'buyer', tokens, 1);
    const r2 = generator.generate('s', 'e2', 'openai', 'buyer', tokens, 1);
    expect(r1.receiptId).not.toBe(r2.receiptId);
  });
});

describe('ReceiptVerifier', () => {
  it('should pass verification for valid signature within threshold', () => {
    const verifier = new ReceiptVerifier(makeVerifier(true));

    const receipt: UsageReceipt = {
      receiptId: 'r1',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: Date.now(),
      provider: 'openai',
      sellerPeerId: 'seller',
      buyerPeerId: 'buyer',
      tokens: makeTokenCount(1000),
      unitPriceCentsPerThousandTokens: 10,
      costCents: 10,
      signature: 'f'.repeat(128),
    };

    const buyerEstimate = makeTokenCount(1050); // 5% difference
    const result = verifier.verify(receipt, buyerEstimate);

    expect(result.signatureValid).toBe(true);
    expect(result.disputed).toBe(false);
    expect(result.percentageDifference).toBeCloseTo(4.76, 1); // |1000-1050|/1050*100
  });

  it('should flag as disputed when signature is invalid', () => {
    const verifier = new ReceiptVerifier(makeVerifier(false));
    const receipt: UsageReceipt = {
      receiptId: 'r1',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: Date.now(),
      provider: 'openai',
      sellerPeerId: 'seller',
      buyerPeerId: 'buyer',
      tokens: makeTokenCount(1000),
      unitPriceCentsPerThousandTokens: 10,
      costCents: 10,
      signature: 'bad',
    };

    const result = verifier.verify(receipt, makeTokenCount(1000));
    expect(result.signatureValid).toBe(false);
    expect(result.disputed).toBe(true);
  });

  it('should flag as disputed when token difference exceeds threshold', () => {
    const verifier = new ReceiptVerifier(makeVerifier(true), { disputeThresholdPercent: 10 });

    const receipt: UsageReceipt = {
      receiptId: 'r1',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: Date.now(),
      provider: 'openai',
      sellerPeerId: 'seller',
      buyerPeerId: 'buyer',
      tokens: makeTokenCount(1000),
      unitPriceCentsPerThousandTokens: 10,
      costCents: 10,
      signature: 'f'.repeat(128),
    };

    const buyerEstimate = makeTokenCount(800); // 20% difference
    const result = verifier.verify(receipt, buyerEstimate);

    expect(result.signatureValid).toBe(true);
    expect(result.disputed).toBe(true);
    expect(result.percentageDifference).toBeGreaterThan(10);
  });

  it('should calculate percentage difference correctly', () => {
    expect(ReceiptVerifier.calculatePercentageDifference(100, 100)).toBe(0);
    expect(ReceiptVerifier.calculatePercentageDifference(100, 200)).toBe(50);
    expect(ReceiptVerifier.calculatePercentageDifference(200, 100)).toBe(50);
    expect(ReceiptVerifier.calculatePercentageDifference(0, 0)).toBe(0);
    expect(ReceiptVerifier.calculatePercentageDifference(0, 100)).toBe(100);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TokenCount, UsageReceipt, MeteringEvent, SessionMetrics } from '@antseed/node';
import { MeteringStorage } from '@antseed/node';
import {
  ReceiptGenerator,
  ReceiptVerifier,
  buildSignaturePayload,
  calculateCost,
  SessionTracker,
  UsageAggregator,
  type Signer,
  type SignatureVerifier,
} from '@antseed/node/metering';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Deterministic mock signer for testing. Signs by appending a fixed suffix. */
function createMockSigner(peerId: string): Signer {
  return {
    peerId,
    sign(message: string): string {
      // Simple deterministic "signature" for testing: hex-encode a hash-like string
      return Buffer.from(`signed:${message}`).toString('hex');
    },
  };
}

/** Mock verifier that understands the mock signer's format. */
function createMockVerifier(): SignatureVerifier {
  return {
    verify(message: string, signature: string, _publicKeyHex: string): boolean {
      const expected = Buffer.from(`signed:${message}`).toString('hex');
      return signature === expected;
    },
  };
}

function makeTokenCount(input: number, output: number): TokenCount {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    method: 'content-length',
    confidence: 'high',
  };
}

function makeMeteringEvent(overrides?: Partial<MeteringEvent>): MeteringEvent {
  return {
    eventId: randomUUID(),
    sessionId: 'session-1',
    timestamp: Date.now(),
    provider: 'anthropic',
    sellerPeerId: 'seller-aabbcc',
    buyerPeerId: 'buyer-ddeeff',
    tokens: makeTokenCount(100, 50),
    latencyMs: 200,
    statusCode: 200,
    wasStreaming: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Receipt generation and verification
// ---------------------------------------------------------------------------
describe('Metering: receipt generation and verification', () => {
  const sellerPeerId = 'seller-' + '0'.repeat(58);
  const buyerPeerId = 'buyer-' + '0'.repeat(59);
  let signer: Signer;
  let generator: ReceiptGenerator;
  let verifier: ReceiptVerifier;

  beforeEach(() => {
    signer = createMockSigner(sellerPeerId);
    generator = new ReceiptGenerator(signer);
    verifier = new ReceiptVerifier(createMockVerifier());
  });

  it('generates a usage receipt for a completed request', () => {
    const tokens = makeTokenCount(500, 200);
    const receipt = generator.generate(
      'session-1',
      'event-1',
      'anthropic',
      buyerPeerId,
      tokens,
      10, // unitPriceCentsPerThousandTokens = 10 cents
    );

    expect(receipt.receiptId).toBeTruthy();
    expect(receipt.sessionId).toBe('session-1');
    expect(receipt.eventId).toBe('event-1');
    expect(receipt.provider).toBe('anthropic');
    expect(receipt.sellerPeerId).toBe(sellerPeerId);
    expect(receipt.buyerPeerId).toBe(buyerPeerId);
    expect(receipt.tokens.totalTokens).toBe(700);
    expect(receipt.unitPriceCentsPerThousandTokens).toBe(10);
    expect(receipt.costCents).toBe(calculateCost(700, 10));
    expect(receipt.signature).toBeTruthy();
    expect(receipt.timestamp).toBeGreaterThan(0);
  });

  it('verifies the receipt signature successfully', () => {
    const tokens = makeTokenCount(500, 200);
    const receipt = generator.generate(
      'session-1',
      'event-1',
      'anthropic',
      buyerPeerId,
      tokens,
      10,
    );

    const buyerEstimate = makeTokenCount(500, 200); // same as seller
    const result = verifier.verify(receipt, buyerEstimate);

    expect(result.receiptId).toBe(receipt.receiptId);
    expect(result.signatureValid).toBe(true);
    expect(result.disputed).toBe(false);
    expect(result.tokenDifference).toBe(0);
    expect(result.percentageDifference).toBe(0);
  });

  it('flags a receipt as disputed when token estimates diverge', () => {
    const sellerTokens = makeTokenCount(500, 500);
    const receipt = generator.generate(
      'session-1',
      'event-1',
      'anthropic',
      buyerPeerId,
      sellerTokens,
      10,
    );

    // Buyer estimate is significantly different (> 15% threshold)
    const buyerEstimate = makeTokenCount(300, 200); // total 500 vs seller 1000 = 50% diff
    const result = verifier.verify(receipt, buyerEstimate);

    expect(result.signatureValid).toBe(true);
    expect(result.disputed).toBe(true);
    expect(result.percentageDifference).toBeGreaterThan(15);
  });

  it('flags a receipt as disputed when signature is invalid', () => {
    const tokens = makeTokenCount(100, 50);
    const receipt = generator.generate(
      'session-1',
      'event-1',
      'anthropic',
      buyerPeerId,
      tokens,
      10,
    );

    // Tamper with the signature
    const tampered: UsageReceipt = { ...receipt, signature: 'badbadbadbad' };
    const result = verifier.verify(tampered, tokens);

    expect(result.signatureValid).toBe(false);
    expect(result.disputed).toBe(true);
  });

  it('buildSignaturePayload is deterministic', () => {
    const receiptData: Omit<UsageReceipt, 'signature'> = {
      receiptId: 'r1',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: 1000,
      provider: 'anthropic',
      sellerPeerId: 'seller',
      buyerPeerId: 'buyer',
      tokens: makeTokenCount(100, 50),
      unitPriceCentsPerThousandTokens: 10,
      costCents: 2,
    };

    const payload1 = buildSignaturePayload(receiptData);
    const payload2 = buildSignaturePayload(receiptData);
    expect(payload1).toBe(payload2);
    expect(payload1).toContain('r1');
    expect(payload1).toContain('|');
  });

  it('calculateCost computes correctly', () => {
    // 1000 tokens at 10 cents per 1K = 10 cents
    expect(calculateCost(1000, 10)).toBe(10);
    // 500 tokens at 10 cents per 1K = 5 cents
    expect(calculateCost(500, 10)).toBe(5);
    // 0 tokens = 0 cost
    expect(calculateCost(0, 10)).toBe(0);
    // Small amounts round to minimum 1 cent
    expect(calculateCost(1, 10)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MeteringStorage persistence
// ---------------------------------------------------------------------------
describe('Metering: MeteringStorage persistence', () => {
  let dataDir: string;
  let storage: MeteringStorage;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'antseed-metering-test-'));
    storage = new MeteringStorage(join(dataDir, 'metering.db'));
  });

  afterEach(async () => {
    try { storage.close(); } catch {}
    try { await rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('persists and retrieves a usage receipt', () => {
    const receipt: UsageReceipt = {
      receiptId: randomUUID(),
      sessionId: 'session-1',
      eventId: 'event-1',
      timestamp: Date.now(),
      provider: 'anthropic',
      sellerPeerId: 'seller-abc',
      buyerPeerId: 'buyer-def',
      tokens: makeTokenCount(200, 100),
      unitPriceCentsPerThousandTokens: 10,
      costCents: 3,
      signature: 'sig-hex',
    };

    storage.insertReceipt(receipt);
    const retrieved = storage.getReceiptsBySession('session-1');

    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]!.receiptId).toBe(receipt.receiptId);
    expect(retrieved[0]!.tokens.totalTokens).toBe(300);
    expect(retrieved[0]!.costCents).toBe(3);
    expect(retrieved[0]!.signature).toBe('sig-hex');
  });

  it('persists and retrieves metering events', () => {
    const event = makeMeteringEvent({ sessionId: 'session-A' });
    storage.insertEvent(event);

    const events = storage.getEventsBySession('session-A');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe(event.eventId);
    expect(events[0]!.tokens.totalTokens).toBe(event.tokens.totalTokens);
    expect(events[0]!.wasStreaming).toBe(false);
  });

  it('aggregates total cost over multiple receipts', () => {
    const now = Date.now();
    const receipts: UsageReceipt[] = [
      {
        receiptId: randomUUID(),
        sessionId: 'session-1',
        eventId: 'e1',
        timestamp: now,
        provider: 'anthropic',
        sellerPeerId: 'seller',
        buyerPeerId: 'buyer',
        tokens: makeTokenCount(100, 50),
        unitPriceCentsPerThousandTokens: 10,
        costCents: 2,
        signature: 'sig1',
      },
      {
        receiptId: randomUUID(),
        sessionId: 'session-1',
        eventId: 'e2',
        timestamp: now + 1000,
        provider: 'anthropic',
        sellerPeerId: 'seller',
        buyerPeerId: 'buyer',
        tokens: makeTokenCount(200, 100),
        unitPriceCentsPerThousandTokens: 10,
        costCents: 3,
        signature: 'sig2',
      },
      {
        receiptId: randomUUID(),
        sessionId: 'session-1',
        eventId: 'e3',
        timestamp: now + 2000,
        provider: 'anthropic',
        sellerPeerId: 'seller',
        buyerPeerId: 'buyer',
        tokens: makeTokenCount(300, 200),
        unitPriceCentsPerThousandTokens: 10,
        costCents: 5,
        signature: 'sig3',
      },
    ];

    for (const r of receipts) {
      storage.insertReceipt(r);
    }

    const totalCost = storage.getTotalCost(now - 1, now + 10000);
    expect(totalCost).toBe(10); // 2 + 3 + 5

    const allReceipts = storage.getReceiptsBySession('session-1');
    expect(allReceipts).toHaveLength(3);
  });

  it('retrieves events by time range', () => {
    const now = Date.now();
    storage.insertEvent(makeMeteringEvent({ timestamp: now - 5000, sessionId: 's1' }));
    storage.insertEvent(makeMeteringEvent({ timestamp: now, sessionId: 's2' }));
    storage.insertEvent(makeMeteringEvent({ timestamp: now + 5000, sessionId: 's3' }));

    const inRange = storage.getEventsByTimeRange(now - 1, now + 1);
    expect(inRange).toHaveLength(1);
    expect(inRange[0]!.sessionId).toBe('s2');
  });

  it('upserts and retrieves session metrics', () => {
    const metrics: SessionMetrics = {
      sessionId: 'sess-1',
      sellerPeerId: 'seller',
      buyerPeerId: 'buyer',
      provider: 'anthropic',
      startedAt: Date.now(),
      endedAt: null,
      totalRequests: 5,
      totalTokens: 1000,
      totalCostCents: 10,
      avgLatencyMs: 150,
      peerSwitches: 0,
      disputedReceipts: 0,
    };

    storage.upsertSession(metrics);
    const retrieved = storage.getSession('sess-1');

    expect(retrieved).toBeDefined();
    expect(retrieved!.totalRequests).toBe(5);
    expect(retrieved!.totalTokens).toBe(1000);
    expect(retrieved!.totalCostCents).toBe(10);
  });

  it('prunes data older than a threshold', () => {
    const now = Date.now();
    const oldTimestamp = now - 100_000;

    // Insert old and new data
    storage.insertEvent(makeMeteringEvent({ timestamp: oldTimestamp, sessionId: 's-old' }));
    storage.insertEvent(makeMeteringEvent({ timestamp: now, sessionId: 's-new' }));

    const pruned = storage.pruneOlderThan(now - 50_000);
    expect(pruned.eventsDeleted).toBe(1);

    // Only the new event remains
    const remaining = storage.getEventsByTimeRange(0, now + 1000);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sessionId).toBe('s-new');
  });
});

// ---------------------------------------------------------------------------
// UsageAggregator
// ---------------------------------------------------------------------------
describe('Metering: UsageAggregator', () => {
  const aggregator = new UsageAggregator();

  it('aggregates multiple sessions into daily buckets', () => {
    const baseTime = new Date('2025-06-15T10:00:00Z').getTime();

    const sessions: SessionMetrics[] = [
      {
        sessionId: 's1',
        sellerPeerId: 'seller-1',
        buyerPeerId: 'buyer-1',
        provider: 'anthropic',
        startedAt: baseTime,
        endedAt: baseTime + 60_000,
        totalRequests: 10,
        totalTokens: 5000,
        totalCostCents: 50,
        avgLatencyMs: 100,
        peerSwitches: 0,
        disputedReceipts: 0,
      },
      {
        sessionId: 's2',
        sellerPeerId: 'seller-2',
        buyerPeerId: 'buyer-1',
        provider: 'anthropic',
        startedAt: baseTime + 3600_000, // same day
        endedAt: baseTime + 3660_000,
        totalRequests: 5,
        totalTokens: 2000,
        totalCostCents: 20,
        avgLatencyMs: 150,
        peerSwitches: 0,
        disputedReceipts: 1,
      },
    ];

    const result = aggregator.aggregate(sessions, 'daily');
    expect(result).toHaveLength(1);
    expect(result[0]!.totalSessions).toBe(2);
    expect(result[0]!.totalRequests).toBe(15);
    expect(result[0]!.totalTokens).toBe(7000);
    expect(result[0]!.totalCostCents).toBe(70);
    expect(result[0]!.topPeers.length).toBeGreaterThan(0);
  });

  it('returns empty array for no sessions', () => {
    const result = aggregator.aggregate([], 'daily');
    expect(result).toHaveLength(0);
  });

  it('aggregateAll summarizes all sessions', () => {
    const sessions: SessionMetrics[] = [
      {
        sessionId: 's1',
        sellerPeerId: 'seller-1',
        buyerPeerId: 'buyer-1',
        provider: 'anthropic',
        startedAt: Date.now(),
        endedAt: Date.now() + 1000,
        totalRequests: 3,
        totalTokens: 1500,
        totalCostCents: 15,
        avgLatencyMs: 200,
        peerSwitches: 0,
        disputedReceipts: 0,
      },
    ];

    const summary = aggregator.aggregateAll(sessions);
    expect(summary.totalSessions).toBe(1);
    expect(summary.totalRequests).toBe(3);
    expect(summary.totalTokens).toBe(1500);
    expect(summary.totalCostCents).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// SessionTracker
// ---------------------------------------------------------------------------
describe('Metering: SessionTracker across P2P boundary', () => {
  it('tracks events and receipts for a session', () => {
    const tracker = new SessionTracker('session-1', 'seller-abc', 'buyer-def', 'anthropic');

    const event = makeMeteringEvent({ sessionId: 'session-1' });
    tracker.recordEvent(event);

    const metrics = tracker.getMetrics();
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.totalTokens).toBe(event.tokens.totalTokens);
    expect(metrics.sessionId).toBe('session-1');
  });

  it('tracks receipt cost and detects disputes', () => {
    const tracker = new SessionTracker('session-1', 'seller-abc', 'buyer-def', 'anthropic');

    const signer = createMockSigner('seller-abc');
    const generator = new ReceiptGenerator(signer);

    const tokens = makeTokenCount(500, 500);
    const receipt = generator.generate('session-1', 'event-1', 'anthropic', 'buyer-def', tokens, 10);

    // Good verification - no dispute
    const goodVerification = {
      receiptId: receipt.receiptId,
      signatureValid: true,
      buyerTokenEstimate: tokens,
      sellerTokenEstimate: tokens,
      tokenDifference: 0,
      percentageDifference: 0,
      disputed: false,
      verifiedAt: Date.now(),
    };

    tracker.recordReceipt(receipt, goodVerification);
    expect(tracker.getMetrics().totalCostCents).toBe(receipt.costCents);
    expect(tracker.getMetrics().disputedReceipts).toBe(0);

    // Bad verification - dispute
    const receipt2 = generator.generate('session-1', 'event-2', 'anthropic', 'buyer-def', tokens, 10);
    const badVerification = {
      receiptId: receipt2.receiptId,
      signatureValid: true,
      buyerTokenEstimate: makeTokenCount(100, 50),
      sellerTokenEstimate: tokens,
      tokenDifference: 850,
      percentageDifference: 85,
      disputed: true,
      verifiedAt: Date.now(),
    };

    tracker.recordReceipt(receipt2, badVerification);
    expect(tracker.getMetrics().disputedReceipts).toBe(1);
  });

  it('endSession returns final metrics with endedAt set', () => {
    const tracker = new SessionTracker('session-1', 'seller', 'buyer', 'anthropic');
    tracker.recordEvent(makeMeteringEvent({ sessionId: 'session-1' }));

    const final = tracker.endSession();
    expect(final.endedAt).toBeTruthy();
    expect(final.totalRequests).toBe(1);
  });

  it('records peer switches', () => {
    const tracker = new SessionTracker('session-1', 'seller-a', 'buyer-1', 'anthropic');

    tracker.recordPeerSwitch('seller-b');
    tracker.recordPeerSwitch('seller-b'); // same peer, should not count
    tracker.recordPeerSwitch('seller-c');

    const metrics = tracker.getMetrics();
    expect(metrics.peerSwitches).toBe(2);
  });
});

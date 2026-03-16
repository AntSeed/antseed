import { describe, it, expect } from 'vitest';
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LocalRouter } from './router.js';

function makePeer(overrides?: Partial<PeerInfo>): PeerInfo {
  return {
    peerId: 'a'.repeat(64) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    services: [
      {
        name: 'claude-3-opus',
        pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 },
      },
    ],
    reputationScore: 80,
    trustScore: 80,
    maxConcurrency: 10,
    currentLoad: 1,
    ...overrides,
  };
}

function makeRequest(service?: string): SerializedHttpRequest {
  const payload = service ? { model: service } : { messages: [{ role: 'user', content: 'hi' }] };
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  };
}

describe('LocalRouter', () => {
  it('selects cheapest peer regardless of service name', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 1_000, outputUsdPerMillion: 1_000 },
      },
    });

    const expensive = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } },
      ],
    });
    const cheap = makePeer({
      peerId: '2'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'gpt-4o', pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
      ],
    });

    const selected = router.selectPeer(makeRequest('claude-sonnet-4-5-20250929'), [expensive, cheap]);
    expect(selected?.peerId).toBe(cheap.peerId);
  });

  it('rejects peers when output price exceeds buyer max even if input is within max', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 50, outputUsdPerMillion: 10 },
      },
    });

    const overpricedOutputPeer = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 20 } },
      ],
    });

    expect(router.selectPeer(makeRequest('claude-sonnet-4-5-20250929'), [overpricedOutputPeer])).toBeNull();
  });

  it('uses service-specific pricing when request service matches', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 1_000, outputUsdPerMillion: 1_000 },
      },
    });

    const peerA = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'service-a', pricing: { inputUsdPerMillion: 90, outputUsdPerMillion: 90 } },
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
      ],
    });
    const peerB = makePeer({
      peerId: '2'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'service-a', pricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 } },
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 20, outputUsdPerMillion: 20 } },
      ],
    });

    const selected = router.selectPeer(makeRequest('service-a'), [peerA, peerB]);
    expect(selected?.peerId).toBe(peerB.peerId);
  });

  it('falls back to first service pricing when request service is absent', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 1_000, outputUsdPerMillion: 1_000 },
      },
    });

    const expensiveDefault = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 40, outputUsdPerMillion: 40 } },
      ],
    });
    const cheapDefault = makePeer({
      peerId: '2'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 } },
      ],
    });

    const selected = router.selectPeer(makeRequest(undefined), [expensiveDefault, cheapDefault]);
    expect(selected?.peerId).toBe(cheapDefault.peerId);
  });

  it('puts peers on cooldown after failure threshold and re-allows them later', () => {
    let now = 1_000_000;
    const router = new LocalRouter({
      maxFailures: 2,
      failureCooldownMs: 500,
      now: () => now,
    });

    const flaky = makePeer({ peerId: '1'.repeat(64) as PeerInfo['peerId'], lastSeen: now });
    const fallback = makePeer({ peerId: 'f'.repeat(64) as PeerInfo['peerId'], lastSeen: now });

    router.onResult(flaky, { success: false, latencyMs: 300, tokens: 0 });
    router.onResult(flaky, { success: false, latencyMs: 300, tokens: 0 });

    // Flaky is cooling down; fallback should be selected.
    expect(router.selectPeer(makeRequest(), [flaky, fallback])?.peerId).toBe(fallback.peerId);

    now += 501;
    // Cooldown expired; flaky is allowed again, but still penalized by reliability history.
    expect(router.selectPeer(makeRequest(), [flaky, fallback])?.peerId).toBe(fallback.peerId);
    // It should still be selectable when no alternatives exist.
    expect(router.selectPeer(makeRequest(), [flaky])?.peerId).toBe(flaky.peerId);
  });

  it('filters out peers below minimum reputation', () => {
    const router = new LocalRouter({
      minReputation: 70,
    });

    const lowRep = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      reputationScore: 40,
      trustScore: 40,
    });
    const highRep = makePeer({
      peerId: '2'.repeat(64) as PeerInfo['peerId'],
      reputationScore: 90,
      trustScore: 90,
    });

    const selected = router.selectPeer(makeRequest(), [lowRep, highRep]);
    expect(selected?.peerId).toBe(highRep.peerId);
  });

  it('keeps peers eligible when reputation fields are missing', () => {
    const router = new LocalRouter();
    const unrated = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      reputationScore: undefined,
      trustScore: undefined,
      onChainReputation: undefined,
    });

    const selected = router.selectPeer(makeRequest(), [unrated]);
    expect(selected?.peerId).toBe(unrated.peerId);
  });

  it('treats on-chain zero reputation with zero sessions as unrated', () => {
    const router = new LocalRouter();
    const newSeller = makePeer({
      peerId: '3'.repeat(64) as PeerInfo['peerId'],
      trustScore: 0,
      reputationScore: undefined,
      onChainReputation: 0,
      onChainSessionCount: 0,
      onChainDisputeCount: 0,
    });

    const selected = router.selectPeer(makeRequest(), [newSeller]);
    expect(selected?.peerId).toBe(newSeller.peerId);
  });

  it('ignores empty service entries when selecting a peer service', () => {
    const router = new LocalRouter();
    const malformedServices = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: '', pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
      ],
    });

    const selected = router.selectPeer(makeRequest(), [malformedServices]);
    expect(selected?.peerId).toBe(malformedServices.peerId);
  });

  it('selects correct service for pricing on multi-service peer', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 50, outputUsdPerMillion: 50 },
      },
    });

    // Peer has two services: claude (expensive) and gpt-4o (cheap)
    const multiPeer = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'claude-sonnet-4-5-20250929', pricing: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } },
        { name: 'gpt-4o', pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
      ],
    });

    // Requesting gpt-4o should use gpt-4o pricing (10), within max 50
    const selected = router.selectPeer(makeRequest('gpt-4o'), [multiPeer]);
    expect(selected?.peerId).toBe(multiPeer.peerId);
  });

  it('returns null when no peers are available', () => {
    const router = new LocalRouter();
    expect(router.selectPeer(makeRequest(), [])).toBeNull();
  });
});

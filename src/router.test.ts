import { describe, it, expect } from 'vitest';
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LocalChatRouter } from './router.js';

function makePeer(overrides?: Partial<PeerInfo>): PeerInfo {
  return {
    peerId: 'a'.repeat(64) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['anthropic'],
    reputationScore: 80,
    trustScore: 80,
    defaultInputUsdPerMillion: 10,
    defaultOutputUsdPerMillion: 10,
    providerPricing: {
      anthropic: {
        defaults: {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 10,
        },
      },
    },
    maxConcurrency: 10,
    currentLoad: 1,
    ...overrides,
  };
}

function makeRequest(model?: string): SerializedHttpRequest {
  const payload = model ? { model } : { messages: [{ role: 'user', content: 'hi' }] };
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  };
}

describe('LocalChatRouter', () => {
  it('prefers lower-latency peer due to latency-prioritized weights', () => {
    let now = 1_000_000;
    const router = new LocalChatRouter({ now: () => now });

    const fastPeer = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      lastSeen: now,
    });
    const slowPeer = makePeer({
      peerId: '2'.repeat(64) as PeerInfo['peerId'],
      lastSeen: now,
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 },
        },
      },
      defaultInputUsdPerMillion: 5,
      defaultOutputUsdPerMillion: 5,
    });

    // Record latency history
    router.onResult(fastPeer, { success: true, latencyMs: 50, tokens: 100 });
    router.onResult(slowPeer, { success: true, latencyMs: 500, tokens: 100 });

    const selected = router.selectPeer(makeRequest(), [slowPeer, fastPeer]);
    expect(selected?.peerId).toBe(fastPeer.peerId);
  });

  it('filters out peers below minimum reputation', () => {
    const router = new LocalChatRouter({ minReputation: 70 });

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

  it('returns null when no peers are available', () => {
    const router = new LocalChatRouter();
    expect(router.selectPeer(makeRequest(), [])).toBeNull();
  });

  it('puts peers on cooldown after failure threshold', () => {
    let now = 1_000_000;
    const router = new LocalChatRouter({
      maxFailures: 2,
      failureCooldownMs: 500,
      now: () => now,
    });

    const flaky = makePeer({ peerId: '1'.repeat(64) as PeerInfo['peerId'], lastSeen: now });
    const fallback = makePeer({ peerId: 'f'.repeat(64) as PeerInfo['peerId'], lastSeen: now });

    router.onResult(flaky, { success: false, latencyMs: 300, tokens: 0 });
    router.onResult(flaky, { success: false, latencyMs: 300, tokens: 0 });

    expect(router.selectPeer(makeRequest(), [flaky, fallback])?.peerId).toBe(fallback.peerId);

    now += 501;
    // Selectable when no alternatives exist after cooldown expires.
    expect(router.selectPeer(makeRequest(), [flaky])?.peerId).toBe(flaky.peerId);
  });
});

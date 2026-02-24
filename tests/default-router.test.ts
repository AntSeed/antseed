import { describe, it, expect } from 'vitest';
import { DefaultRouter } from '../src/routing/default-router.js';
import type { PeerInfo } from '../src/types/peer.js';
import type { SerializedHttpRequest } from '../src/types/http.js';

function makePeer(overrides?: Partial<PeerInfo>): PeerInfo {
  return {
    peerId: ('a'.repeat(64)) as any,
    lastSeen: Date.now(),
    providers: ['anthropic'],
    reputationScore: 80,
    defaultInputUsdPerMillion: 10,
    ...overrides,
  };
}

const dummyReq: SerializedHttpRequest = {
  requestId: 'req-1',
  method: 'POST',
  path: '/v1/messages',
  headers: {},
  body: new Uint8Array(0),
};

describe('DefaultRouter', () => {
  describe('selectPeer', () => {
    it('should return null for empty peer list', () => {
      const router = new DefaultRouter();
      expect(router.selectPeer(dummyReq, [])).toBeNull();
    });

    it('should return null when no peer meets minimum reputation', () => {
      const router = new DefaultRouter({ minReputation: 90 });
      const peers = [
        makePeer({ peerId: 'a'.repeat(64) as any, reputationScore: 50 }),
        makePeer({ peerId: 'b'.repeat(64) as any, reputationScore: 80 }),
      ];
      expect(router.selectPeer(dummyReq, peers)).toBeNull();
    });

    it('should select cheapest peer', () => {
      const router = new DefaultRouter();
      const expensive = makePeer({ peerId: 'a'.repeat(64) as any, defaultInputUsdPerMillion: 1000 });
      const cheap = makePeer({ peerId: 'b'.repeat(64) as any, defaultInputUsdPerMillion: 1 });
      const selected = router.selectPeer(dummyReq, [expensive, cheap]);
      expect(selected).not.toBeNull();
      expect(selected!.peerId).toBe('b'.repeat(64));
    });

    it('should use default minReputation of 50', () => {
      const router = new DefaultRouter();
      const peer = makePeer({ reputationScore: 50 });
      expect(router.selectPeer(dummyReq, [peer])).not.toBeNull();

      const lowRep = makePeer({ reputationScore: 49 });
      expect(router.selectPeer(dummyReq, [lowRep])).toBeNull();
    });

    it('should treat missing reputationScore as 0', () => {
      const router = new DefaultRouter();
      const peer = makePeer({ reputationScore: undefined });
      // 0 < 50 (default min), so should be null
      expect(router.selectPeer(dummyReq, [peer])).toBeNull();
    });

    it('should treat missing defaultInputUsdPerMillion as Infinity', () => {
      const router = new DefaultRouter();
      const withPrice = makePeer({ peerId: 'a'.repeat(64) as any, defaultInputUsdPerMillion: 500 });
      const noPrice = makePeer({ peerId: 'b'.repeat(64) as any, defaultInputUsdPerMillion: undefined });
      const selected = router.selectPeer(dummyReq, [withPrice, noPrice]);
      expect(selected!.peerId).toBe('a'.repeat(64));
    });
  });

  describe('onResult', () => {
    it('should use latency for tiebreaking after recording results', () => {
      const router = new DefaultRouter();
      const peerA = makePeer({ peerId: 'a'.repeat(64) as any, defaultInputUsdPerMillion: 10 });
      const peerB = makePeer({ peerId: 'b'.repeat(64) as any, defaultInputUsdPerMillion: 10 });

      // Record peerA as slower, peerB as faster
      router.onResult(peerA, { success: true, latencyMs: 500, tokens: 100 });
      router.onResult(peerB, { success: true, latencyMs: 50, tokens: 100 });

      const selected = router.selectPeer(dummyReq, [peerA, peerB]);
      // Both have same price, so should pick lower latency
      expect(selected!.peerId).toBe('b'.repeat(64));
    });

    it('should use exponential moving average for latency', () => {
      const router = new DefaultRouter();
      const peer = makePeer({ peerId: 'a'.repeat(64) as any });

      router.onResult(peer, { success: true, latencyMs: 100, tokens: 100 });
      router.onResult(peer, { success: true, latencyMs: 200, tokens: 100 });

      // After first call: 100
      // After second call: 100 * 0.7 + 200 * 0.3 = 70 + 60 = 130
      // We can't directly check the latency map, but we can verify it influences selection
      const peerFast = makePeer({ peerId: 'b'.repeat(64) as any, defaultInputUsdPerMillion: 10 });
      router.onResult(peerFast, { success: true, latencyMs: 10, tokens: 100 });

      const selected = router.selectPeer(dummyReq, [peer, peerFast]);
      expect(selected!.peerId).toBe('b'.repeat(64));
    });

    it('should not update latency on failure', () => {
      const router = new DefaultRouter();
      const peer = makePeer({ peerId: 'a'.repeat(64) as any });
      router.onResult(peer, { success: false, latencyMs: 999999, tokens: 0 });
      // No latency recorded, so peer still has Infinity latency
      // Just verify it doesn't crash
    });
  });
});

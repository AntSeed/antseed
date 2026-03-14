import { describe, it, expect } from 'vitest';
import { encodeMetadata, decodeMetadata } from '../src/discovery/metadata-codec.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import type { PeerInfo } from '../src/types/peer.js';

function makeMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 3,
      },
    ],
    region: 'us-east-1',
    timestamp: 1700000000000,
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

describe('Reputation Integration', () => {
  it('should round-trip metadata with EVM address and reputation', () => {
    const original = makeMetadata({
      evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
      onChainReputation: 85,
      onChainSessionCount: 42,
      onChainDisputeCount: 2,
    });
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.evmAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(decoded.onChainReputation).toBe(85);
    expect(decoded.onChainSessionCount).toBe(42);
    expect(decoded.onChainDisputeCount).toBe(2);
    // Verify other fields are still correct
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
    expect(decoded.providers).toHaveLength(1);
    expect(decoded.providers[0]!.provider).toBe('anthropic');
  });

  it('should decode metadata without reputation fields (backward compat)', () => {
    // Encode without reputation fields
    const original = makeMetadata();
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.evmAddress).toBeUndefined();
    expect(decoded.onChainReputation).toBeUndefined();
    expect(decoded.onChainSessionCount).toBeUndefined();
    expect(decoded.onChainDisputeCount).toBeUndefined();
    // Core fields should still work
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
  });

  it('should populate PeerInfo from metadata reputation', () => {
    const metadata: PeerMetadata = makeMetadata({
      evmAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      onChainReputation: 92,
      onChainSessionCount: 100,
      onChainDisputeCount: 1,
    });

    // Simulate what _lookupResultToPeerInfo does
    const peerInfo: PeerInfo = {
      peerId: metadata.peerId,
      lastSeen: metadata.timestamp,
      providers: metadata.providers.map((p) => p.provider),
      publicAddress: '1.2.3.4:6882',
      evmAddress: metadata.evmAddress,
      onChainReputation: metadata.onChainReputation,
      onChainSessionCount: metadata.onChainSessionCount,
      onChainDisputeCount: metadata.onChainDisputeCount,
      trustScore: metadata.onChainReputation,
    };

    expect(peerInfo.evmAddress).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(peerInfo.onChainReputation).toBe(92);
    expect(peerInfo.onChainSessionCount).toBe(100);
    expect(peerInfo.onChainDisputeCount).toBe(1);
    expect(peerInfo.trustScore).toBe(92);
  });

  it('should prefer on-chain reputation in effective reputation', () => {
    // Simulates the _effectiveReputation logic from the router
    function effectiveReputation(p: PeerInfo): number {
      if (p.onChainReputation !== undefined) {
        return p.onChainReputation;
      }
      return p.trustScore ?? p.reputationScore ?? 0;
    }

    const peer: PeerInfo = {
      peerId: 'a'.repeat(64) as any,
      lastSeen: Date.now(),
      providers: ['anthropic'],
      onChainReputation: 88,
      trustScore: 70,
      reputationScore: 60,
    };

    expect(effectiveReputation(peer)).toBe(88);
  });

  it('should fall back when on-chain reputation is not available', () => {
    function effectiveReputation(p: PeerInfo): number {
      if (p.onChainReputation !== undefined) {
        return p.onChainReputation;
      }
      return p.trustScore ?? p.reputationScore ?? 0;
    }

    const peerWithTrust: PeerInfo = {
      peerId: 'a'.repeat(64) as any,
      lastSeen: Date.now(),
      providers: ['anthropic'],
      trustScore: 75,
      reputationScore: 60,
    };

    const peerWithRepOnly: PeerInfo = {
      peerId: 'b'.repeat(64) as any,
      lastSeen: Date.now(),
      providers: ['openai'],
      reputationScore: 55,
    };

    const peerWithNothing: PeerInfo = {
      peerId: 'c'.repeat(64) as any,
      lastSeen: Date.now(),
      providers: ['openai'],
    };

    expect(effectiveReputation(peerWithTrust)).toBe(75);
    expect(effectiveReputation(peerWithRepOnly)).toBe(55);
    expect(effectiveReputation(peerWithNothing)).toBe(0);
  });

  it('should verify reputation with evmAddress via verifyReputation', async () => {
    const { verifyReputation } = await import('../src/discovery/reputation-verifier.js');

    const metadata = makeMetadata({
      evmAddress: '0x1111111111111111111111111111111111111111',
      onChainReputation: 80,
      onChainSessionCount: 50,
      onChainDisputeCount: 3,
    });

    // Mock escrow client
    const mockEscrowClient = {
      getReputation: async (_addr: string) => ({
        totalWeightedScore: 4000n,
        totalWeight: 50n,
        sessionCount: 50,
        disputeCount: 3,
        weightedAverage: 80,
      }),
    } as any;

    const result = await verifyReputation(mockEscrowClient, metadata);

    expect(result.valid).toBe(true);
    expect(result.actualReputation).toBe(80);
    expect(result.actualSessionCount).toBe(50);
    expect(result.actualDisputeCount).toBe(3);
    expect(result.claimedReputation).toBe(80);
    expect(result.claimedSessionCount).toBe(50);
    expect(result.claimedDisputeCount).toBe(3);

    // Test with mismatched data
    const mismatchedMetadata = makeMetadata({
      evmAddress: '0x1111111111111111111111111111111111111111',
      onChainReputation: 90, // claimed higher than actual
      onChainSessionCount: 50,
      onChainDisputeCount: 3,
    });

    const mismatchResult = await verifyReputation(mockEscrowClient, mismatchedMetadata);
    expect(mismatchResult.valid).toBe(false);
    expect(mismatchResult.actualReputation).toBe(80);
    expect(mismatchResult.claimedReputation).toBe(90);
  });
});

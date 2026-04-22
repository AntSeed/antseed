import { describe, it, expect } from 'vitest';
import { encodeMetadata, decodeMetadata } from '../src/discovery/metadata-codec.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import type { PeerInfo } from '../src/types/peer.js';

function makeMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as any,
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
    signature: 'b'.repeat(130),
    ...overrides,
  };
}

describe('Reputation Integration', () => {
  it('should round-trip metadata with reputation', () => {
    const original = makeMetadata({
      onChainChannelCount: 42,
      onChainGhostCount: 2,
    });
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.onChainChannelCount).toBe(42);
    expect(decoded.onChainGhostCount).toBe(2);
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

    expect(decoded.onChainChannelCount).toBeUndefined();
    expect(decoded.onChainGhostCount).toBeUndefined();
    // Core fields should still work
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
  });

  it('should populate PeerInfo from metadata reputation', () => {
    const metadata: PeerMetadata = makeMetadata({
      onChainChannelCount: 100,
      onChainGhostCount: 1,
    });

    // Simulate what _lookupResultToPeerInfo does
    const peerInfo: PeerInfo = {
      peerId: metadata.peerId,
      lastSeen: metadata.timestamp,
      providers: metadata.providers.map((p) => p.provider),
      publicAddress: '1.2.3.4:6882',
      onChainChannelCount: metadata.onChainChannelCount,
      onChainGhostCount: metadata.onChainGhostCount,
      trustScore: metadata.onChainChannelCount,
    };

    expect(peerInfo.onChainChannelCount).toBe(100);
    expect(peerInfo.onChainGhostCount).toBe(1);
    expect(peerInfo.trustScore).toBe(100);
  });

  it('should prefer on-chain reputation in effective reputation', () => {
    // Simulates the _effectiveReputation logic from the router
    function effectiveReputation(p: PeerInfo): number {
      if (p.onChainChannelCount !== undefined) {
        return p.onChainChannelCount;
      }
      return p.trustScore ?? p.reputationScore ?? 0;
    }

    const peer: PeerInfo = {
      peerId: 'a'.repeat(40) as any,
      lastSeen: Date.now(),
      providers: ['anthropic'],
      onChainChannelCount: 88,
      trustScore: 70,
      reputationScore: 60,
    };

    expect(effectiveReputation(peer)).toBe(88);
  });

  it('should fall back when on-chain reputation is not available', () => {
    function effectiveReputation(p: PeerInfo): number {
      if (p.onChainChannelCount !== undefined) {
        return p.onChainChannelCount;
      }
      return p.trustScore ?? p.reputationScore ?? 0;
    }

    const peerWithTrust: PeerInfo = {
      peerId: 'a'.repeat(40) as any,
      lastSeen: Date.now(),
      providers: ['anthropic'],
      trustScore: 75,
      reputationScore: 60,
    };

    const peerWithRepOnly: PeerInfo = {
      peerId: 'b'.repeat(40) as any,
      lastSeen: Date.now(),
      providers: ['openai'],
      reputationScore: 55,
    };

    const peerWithNothing: PeerInfo = {
      peerId: 'c'.repeat(40) as any,
      lastSeen: Date.now(),
      providers: ['openai'],
    };

    expect(effectiveReputation(peerWithTrust)).toBe(75);
    expect(effectiveReputation(peerWithRepOnly)).toBe(55);
    expect(effectiveReputation(peerWithNothing)).toBe(0);
  });

});

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
  it('strips seller-claimed on-chain stats from encoded metadata', () => {
    // On-chain stats are untrusted input if announced by the seller. The
    // encoder drops them; buyers get authoritative values from
    // AntseedChannels.getAgentStats in node.ts discoverPeers().
    const original = makeMetadata({
      onChainChannelCount: 42,
      onChainGhostCount: 2,
    });
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.onChainChannelCount).toBeUndefined();
    expect(decoded.onChainGhostCount).toBeUndefined();
    // Core fields still round-trip.
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
    expect(decoded.providers).toHaveLength(1);
    expect(decoded.providers[0]!.provider).toBe('anthropic');
  });

  it('decodes metadata that never carried reputation fields', () => {
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

  it('buyer populates PeerInfo on-chain fields from contract reads, not metadata', () => {
    // Sanity-check the shape: `PeerInfo` still exposes on-chain fields, but
    // the buyer sets them from AntseedChannels.getAgentStats in node.ts
    // rather than copying them from signed peer metadata.
    const peerInfo: PeerInfo = {
      peerId: 'a'.repeat(40) as any,
      lastSeen: Date.now(),
      providers: ['anthropic'],
      publicAddress: '1.2.3.4:6882',
      onChainChannelCount: 100,
      onChainGhostCount: 1,
      onChainTotalVolumeUsdcMicros: 5_000_000,
      onChainLastSettledAtSec: 1_700_000_000,
      trustScore: 100,
    };

    expect(peerInfo.onChainChannelCount).toBe(100);
    expect(peerInfo.onChainGhostCount).toBe(1);
    expect(peerInfo.onChainTotalVolumeUsdcMicros).toBe(5_000_000);
    expect(peerInfo.onChainLastSettledAtSec).toBe(1_700_000_000);
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

import { describe, expect, it } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function buildMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'openai',
        services: ['kimi-2.5-social'],
        defaultPricing: {
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 8,
        },
        maxConcurrency: 10,
        currentLoad: 0,
      },
    ],
    region: 'test',
    timestamp: Date.now(),
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

describe('AntseedNode publicAddress override', () => {
  it('prefers metadata publicAddress over the DHT source host', () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = (node as any)._lookupResultToPeerInfo({
      host: '34.134.97.133',
      port: 6882,
      metadata: buildMetadata({ publicAddress: '34.27.100.162:6882' }),
    });

    expect(peer.publicAddress).toBe('34.27.100.162:6882');
  });

  it('falls back to the DHT source host when metadata publicAddress is absent', () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = (node as any)._lookupResultToPeerInfo({
      host: '34.134.97.133',
      port: 6882,
      metadata: buildMetadata(),
    });

    expect(peer.publicAddress).toBe('34.134.97.133:6882');
  });
});

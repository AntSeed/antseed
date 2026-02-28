import { describe, it, expect, vi } from 'vitest';
import { PeerLookup, type LookupConfig } from '../src/discovery/peer-lookup.js';
import type { DHTNode } from '../src/discovery/dht-node.js';
import type { MetadataResolver, PeerEndpoint } from '../src/discovery/metadata-resolver.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function buildMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(64) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        models: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 1,
      },
    ],
    region: 'test',
    timestamp: Date.now(),
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

describe('PeerLookup', () => {
  it('deduplicates repeated host:port endpoints before metadata resolution', async () => {
    const peers: PeerEndpoint[] = [
      { host: '84.228.226.179', port: 6882 },
      { host: '84.228.226.179', port: 6882 },
      { host: '84.228.226.179', port: 6882 },
      { host: '147.236.231.105', port: 6882 },
    ];
    const dht = {
      lookup: vi.fn().mockResolvedValue(peers),
    } as unknown as DHTNode;

    const resolve = vi.fn(async () => buildMetadata());
    const metadataResolver: MetadataResolver = { resolve };

    const config: LookupConfig = {
      dht,
      metadataResolver,
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 50,
    };
    const lookup = new PeerLookup(config);

    const results = await lookup.findSellers('anthropic');

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => `${r.host}:${r.port}`)).toEqual(
      expect.arrayContaining(['84.228.226.179:6882', '147.236.231.105:6882']),
    );
  });
});

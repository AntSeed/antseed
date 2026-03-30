import { describe, it, expect, vi } from 'vitest';
import { PeerLookup, type LookupConfig } from '../src/discovery/peer-lookup.js';
import { serviceSearchTopic, serviceTopic, topicToInfoHash } from '../src/discovery/dht-node.js';
import type { DHTNode } from '../src/discovery/dht-node.js';
import type { MetadataResolver, PeerEndpoint } from '../src/discovery/metadata-resolver.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function buildMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
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

    const results = await lookup.findAll();

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => `${r.host}:${r.port}`)).toEqual(
      expect.arrayContaining(['84.228.226.179:6882', '147.236.231.105:6882']),
    );
  });

  it('findByService queries canonical and compact service topics when keys differ', async () => {
    const canonicalPeers: PeerEndpoint[] = [
      { host: '84.228.226.179', port: 6882 },
    ];
    const compactPeers: PeerEndpoint[] = [
      { host: '84.228.226.179', port: 6882 },
      { host: '147.236.231.105', port: 6882 },
    ];

    const canonicalHashHex = topicToInfoHash(serviceTopic('kimi-2.5')).toString('hex');
    const compactHashHex = topicToInfoHash(serviceSearchTopic('kimi-2.5')).toString('hex');
    const lookup = vi.fn(async (hash: Buffer) => {
      const hex = hash.toString('hex');
      if (hex === canonicalHashHex) return canonicalPeers;
      if (hex === compactHashHex) return compactPeers;
      return [];
    });
    const dht = { lookup } as unknown as DHTNode;

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
    const peerLookup = new PeerLookup(config);

    const results = await peerLookup.findByService('kimi-2.5');
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });

  it('findByService queries only canonical topic when compact key matches canonical', async () => {
    const peers: PeerEndpoint[] = [{ host: '84.228.226.179', port: 6882 }];
    const lookup = vi.fn(async () => peers);
    const dht = { lookup } as unknown as DHTNode;

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
    const peerLookup = new PeerLookup(config);

    const results = await peerLookup.findByService('kimi2.5');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });

  it('preserves metadata publicAddress so callers can prefer it over the DHT source host', async () => {
    const peers: PeerEndpoint[] = [{ host: '34.134.97.133', port: 6882 }];
    const lookup = vi.fn(async () => peers);
    const dht = { lookup } as unknown as DHTNode;

    const resolve = vi.fn(async () => buildMetadata({ publicAddress: '34.27.100.162:6882' }));
    const metadataResolver: MetadataResolver = { resolve };
    const config: LookupConfig = {
      dht,
      metadataResolver,
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 50,
    };
    const peerLookup = new PeerLookup(config);

    const results = await peerLookup.findByService('kimi2.5');
    expect(results).toHaveLength(1);
    expect(results[0]?.host).toBe('34.134.97.133');
    expect(results[0]?.port).toBe(6882);
    expect(results[0]?.metadata.publicAddress).toBe('34.27.100.162:6882');
  });
});

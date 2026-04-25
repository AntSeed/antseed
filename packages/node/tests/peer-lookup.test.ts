import { describe, it, expect, vi } from 'vitest';
import { PeerLookup, type LookupConfig } from '../src/discovery/peer-lookup.js';
import { peerTopic, serviceSearchTopic, serviceTopic, topicToInfoHash } from '../src/discovery/dht-node.js';
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

  it('findByPeerId looks up the per-peer topic and filters out spoofed metadata', async () => {
    const targetId = 'a'.repeat(40);
    const otherId = 'b'.repeat(40);

    const honest: PeerEndpoint = { host: '34.10.10.10', port: 6882 };
    const liar: PeerEndpoint = { host: '5.5.5.5', port: 6882 };
    const expectedHashHex = topicToInfoHash(peerTopic(targetId)).toString('hex');

    const lookup = vi.fn(async (hash: Buffer) => {
      if (hash.toString('hex') === expectedHashHex) return [honest, liar];
      return [];
    });
    const dht = { lookup } as unknown as DHTNode;

    const resolve = vi.fn(async (peer: PeerEndpoint) => {
      // Honest peer serves metadata that matches the requested id; the
      // liar announces under the same per-peer topic but serves a
      // different identity — PeerLookup must drop it.
      if (peer.host === honest.host) return buildMetadata({ peerId: targetId as any });
      if (peer.host === liar.host) return buildMetadata({ peerId: otherId as any });
      return null;
    });
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

    const results = await peerLookup.findByPeerId(targetId);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.host).toBe(honest.host);
    expect(results[0]?.metadata.peerId).toBe(targetId);
  });

  it('findByPeerId applies maxResults after filtering matching metadata', async () => {
    const targetId = 'a'.repeat(40);
    const otherId = 'b'.repeat(40);

    const liar: PeerEndpoint = { host: '5.5.5.5', port: 6882 };
    const honest: PeerEndpoint = { host: '34.10.10.10', port: 6882 };
    const lookup = vi.fn(async () => [liar, honest]);
    const dht = { lookup } as unknown as DHTNode;

    const resolve = vi.fn(async (peer: PeerEndpoint) => {
      if (peer.host === liar.host) return buildMetadata({ peerId: otherId as any });
      if (peer.host === honest.host) return buildMetadata({ peerId: targetId as any });
      return null;
    });
    const metadataResolver: MetadataResolver = { resolve };
    const peerLookup = new PeerLookup({
      dht,
      metadataResolver,
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 1,
    });

    const results = await peerLookup.findByPeerId(targetId);
    expect(results).toHaveLength(1);
    expect(results[0]?.host).toBe(honest.host);
  });

  it('findByPeerId returns empty for invalid input without hitting the DHT', async () => {
    const lookup = vi.fn();
    const dht = { lookup } as unknown as DHTNode;
    const metadataResolver: MetadataResolver = { resolve: vi.fn() };
    const peerLookup = new PeerLookup({
      dht,
      metadataResolver,
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 50,
    });

    expect(await peerLookup.findByPeerId('')).toEqual([]);
    expect(await peerLookup.findByPeerId('   ')).toEqual([]);
    expect(await peerLookup.findByPeerId('not-a-peer')).toEqual([]);
    expect(await peerLookup.findByPeerId('a'.repeat(39))).toEqual([]);
    expect(await peerLookup.findByPeerId('g'.repeat(40))).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
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

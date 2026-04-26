import { describe, it, expect, vi } from 'vitest';
import { PeerLookup, type LookupConfig } from '../src/discovery/peer-lookup.js';
import {
  ANTSEED_WILDCARD_TOPIC,
  SUBNET_COUNT,
  peerTopic,
  serviceSearchSubnetTopic,
  serviceSearchTopic,
  serviceSubnetTopic,
  serviceTopic,
  subnetOf,
  subnetTopic,
  topicToInfoHash,
} from '../src/discovery/dht-node.js';
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
  it('findAll fans out across every subnet (and the wildcard) and unions the results', async () => {
    // Build a synthetic network where each subnet topic returns one unique
    // endpoint, plus the wildcard topic returns one legacy endpoint that
    // wasn't sharded yet. The wall-clock cost of each lookup is identical;
    // we just need to verify the union and fan-out shape.
    const subnetEndpoints: Record<string, PeerEndpoint> = {};
    for (let i = 0; i < SUBNET_COUNT; i++) {
      subnetEndpoints[topicToInfoHash(subnetTopic(i)).toString('hex')] = {
        host: `10.0.${i}.1`,
        port: 6882,
      };
    }
    const wildcardEndpoint: PeerEndpoint = { host: '10.99.99.1', port: 6882 };
    const wildcardHashHex = topicToInfoHash(ANTSEED_WILDCARD_TOPIC).toString('hex');

    const lookup = vi.fn(async (hash: Buffer) => {
      const hex = hash.toString('hex');
      if (hex === wildcardHashHex) return [wildcardEndpoint];
      const ep = subnetEndpoints[hex];
      return ep ? [ep] : [];
    });
    const dht = { lookup } as unknown as DHTNode;

    const resolve = vi.fn(async () => buildMetadata());
    const metadataResolver: MetadataResolver = { resolve };
    const peerLookup = new PeerLookup({
      dht,
      metadataResolver,
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 1000,
    });

    const results = await peerLookup.findAll();
    // SUBNET_COUNT subnet lookups + 1 wildcard fallback lookup
    expect(lookup).toHaveBeenCalledTimes(SUBNET_COUNT + 1);
    expect(results).toHaveLength(SUBNET_COUNT + 1);
    const hosts = results.map((r) => r.host).sort();
    const expectedHosts = [
      ...Array.from({ length: SUBNET_COUNT }, (_, i) => `10.0.${i}.1`),
      wildcardEndpoint.host,
    ].sort();
    expect(hosts).toEqual(expectedHosts);
  });

  it('findAll keeps surfacing peers when one subnet lookup rejects', async () => {
    // `DHTNode.lookup` currently swallows timeouts, but we don't want a single
    // future regression on one subnet to wipe the entire enumeration. Reject
    // the lookup for subnet 3; the other subnets and the wildcard must still
    // produce results.
    const failingHashHex = topicToInfoHash(subnetTopic(3)).toString('hex');
    const lookup = vi.fn(async (hash: Buffer) => {
      if (hash.toString('hex') === failingHashHex) {
        throw new Error('synthetic dht failure');
      }
      return [{ host: '10.0.42.1', port: 6882 }] as PeerEndpoint[];
    });
    const dht = { lookup } as unknown as DHTNode;

    const resolve = vi.fn(async () => buildMetadata());
    const metadataResolver: MetadataResolver = { resolve };
    const peerLookup = new PeerLookup({
      dht,
      metadataResolver,
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 1000,
    });

    const results = await peerLookup.findAll();
    expect(lookup).toHaveBeenCalledTimes(SUBNET_COUNT + 1);
    // After dedup the same endpoint collapses to one result; the important
    // assertion is that findAll did not throw and still produced peers from
    // the surviving subnets / wildcard.
    expect(results).toHaveLength(1);
    expect(results[0]?.host).toBe('10.0.42.1');
  });

  it('findAll queries the exact set of subnet + wildcard topics announcer-side advertises', async () => {
    // Symmetry guard: the announcer chooses `subnetTopic(subnetOf(peerId))`
    // and the wildcard; the buyer must query every subnet topic plus the
    // wildcard, with no extras and no missing entries. If a future change
    // diverges the two sides (e.g. announcer adopts a new SUBNET_COUNT but
    // lookup is left behind), this test fails immediately.
    const queriedHashes: string[] = [];
    const lookup = vi.fn(async (hash: Buffer) => {
      queriedHashes.push(hash.toString('hex'));
      return [];
    });
    const dht = { lookup } as unknown as DHTNode;

    const peerLookup = new PeerLookup({
      dht,
      metadataResolver: { resolve: vi.fn() },
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 1000,
    });
    await peerLookup.findAll();

    const expectedHashes = new Set<string>([
      topicToInfoHash(ANTSEED_WILDCARD_TOPIC).toString('hex'),
      ...Array.from({ length: SUBNET_COUNT }, (_, i) =>
        topicToInfoHash(subnetTopic(i)).toString('hex'),
      ),
    ]);
    // Every announcer-produced subnet hash must have been queried, and
    // nothing else should have been queried beyond the expected set.
    expect(new Set(queriedHashes)).toEqual(expectedHashes);
    expect(queriedHashes).toHaveLength(SUBNET_COUNT + 1);
  });

  it('findAll covers every subnetOf(peerId) the announcer might pick, across the full byte space', async () => {
    // Property-style: for any peerId, the subnet the announcer would publish
    // under (subnetTopic(subnetOf(peerId))) must be in the set of topics
    // findAll asks the DHT about. Combined with the symmetry test above, this
    // pins down the contract: announcer + lookup agree for every possible
    // peerId.
    const queriedHashes = new Set<string>();
    const lookup = vi.fn(async (hash: Buffer) => {
      queriedHashes.add(hash.toString('hex'));
      return [];
    });
    const dht = { lookup } as unknown as DHTNode;
    const peerLookup = new PeerLookup({
      dht,
      metadataResolver: { resolve: vi.fn() },
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 1000,
    });
    await peerLookup.findAll();

    for (let byte = 0; byte < 256; byte++) {
      const peerId = byte.toString(16).padStart(2, '0') + 'a'.repeat(38);
      const announcedHashHex = topicToInfoHash(subnetTopic(subnetOf(peerId))).toString('hex');
      expect(queriedHashes.has(announcedHashHex)).toBe(true);
    }
  });

  it('findAll deduplicates a peer that appears on multiple topics (subnet + wildcard)', async () => {
    // Sellers running this build announce on both a subnet AND the wildcard
    // during the transition. The same host:port shouldn't be metadata-resolved
    // more than once.
    const shared: PeerEndpoint = { host: '10.0.7.1', port: 6882 };
    const lookup = vi.fn(async () => [shared]);
    const dht = { lookup } as unknown as DHTNode;

    const resolve = vi.fn(async () => buildMetadata());
    const metadataResolver: MetadataResolver = { resolve };
    const peerLookup = new PeerLookup({
      dht,
      metadataResolver,
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 1000,
    });

    const results = await peerLookup.findAll();
    expect(lookup).toHaveBeenCalledTimes(SUBNET_COUNT + 1);
    // Even though every lookup returned the same endpoint, metadata is
    // resolved exactly once and the result list has a single entry.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.host).toBe(shared.host);
  });

  it('findAll uses DHTNode.lookupMany when available to avoid listener fan-out', async () => {
    const lookup = vi.fn();
    const lookupMany = vi.fn(async () => [{ host: '10.0.7.1', port: 6882 }] as PeerEndpoint[]);
    const dht = { lookup, lookupMany } as unknown as DHTNode;

    const peerLookup = new PeerLookup({
      dht,
      metadataResolver: { resolve: vi.fn(async () => buildMetadata()) },
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 1000,
    });

    const results = await peerLookup.findAll();
    expect(lookupMany).toHaveBeenCalledTimes(1);
    expect(lookupMany.mock.calls[0]?.[0]).toHaveLength(SUBNET_COUNT + 1);
    expect(lookup).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

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

  it('findByService queries sharded canonical and compact service topics plus legacy fallbacks', async () => {
    const canonicalPeers: PeerEndpoint[] = [
      { host: '84.228.226.179', port: 6882 },
    ];
    const compactPeers: PeerEndpoint[] = [
      { host: '84.228.226.179', port: 6882 },
      { host: '147.236.231.105', port: 6882 },
    ];

    const canonicalHashHex = topicToInfoHash(serviceTopic('kimi-2.5')).toString('hex');
    const compactHashHex = topicToInfoHash(serviceSearchTopic('kimi-2.5')).toString('hex');
    const subnetHashHex = topicToInfoHash(serviceSubnetTopic('kimi-2.5', 3)).toString('hex');
    const compactSubnetHashHex = topicToInfoHash(serviceSearchSubnetTopic('kimi-2.5', 4)).toString('hex');
    const lookup = vi.fn(async (hash: Buffer) => {
      const hex = hash.toString('hex');
      if (hex === canonicalHashHex) return canonicalPeers;
      if (hex === compactHashHex) return compactPeers;
      if (hex === subnetHashHex) return [{ host: '147.236.231.106', port: 6882 }];
      if (hex === compactSubnetHashHex) return [{ host: '147.236.231.107', port: 6882 }];
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
    expect(lookup).toHaveBeenCalledTimes((SUBNET_COUNT * 2) + 2);
    const queriedHashes = new Set(lookup.mock.calls.map(([hash]) => hash.toString('hex')));
    expect(queriedHashes.has(canonicalHashHex)).toBe(true);
    expect(queriedHashes.has(compactHashHex)).toBe(true);
    expect(queriedHashes.has(subnetHashHex)).toBe(true);
    expect(queriedHashes.has(compactSubnetHashHex)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(4);
  });

  it('findByService queries sharded canonical topics plus legacy fallback when compact key matches canonical', async () => {
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
    expect(lookup).toHaveBeenCalledTimes(SUBNET_COUNT + 1);
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

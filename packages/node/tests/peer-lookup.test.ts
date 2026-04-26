import { describe, it, expect, vi } from 'vitest';
import { PeerLookup, type LookupConfig } from '../src/discovery/peer-lookup.js';
import {
  ANTSEED_WILDCARD_TOPIC,
  SUBNET_COUNT,
  peerTopic,
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

    const lookupMany = vi.fn(async (hashes: Buffer[]) => {
      const merged: PeerEndpoint[] = [];
      for (const hash of hashes) {
        const hex = hash.toString('hex');
        if (hex === wildcardHashHex) merged.push(wildcardEndpoint);
        const ep = subnetEndpoints[hex];
        if (ep) merged.push(ep);
      }
      return merged;
    });
    const dht = { lookupMany } as unknown as DHTNode;

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
    expect(lookupMany).toHaveBeenCalledTimes(1);
    expect(lookupMany.mock.calls[0]?.[0]).toHaveLength(SUBNET_COUNT + 1);
    expect(results).toHaveLength(SUBNET_COUNT + 1);
    const hosts = results.map((r) => r.host).sort();
    const expectedHosts = [
      ...Array.from({ length: SUBNET_COUNT }, (_, i) => `10.0.${i}.1`),
      wildcardEndpoint.host,
    ].sort();
    expect(hosts).toEqual(expectedHosts);
  });

  it('findAll queries the exact set of subnet + wildcard topics announcer-side advertises', async () => {
    // Symmetry guard: the announcer chooses `subnetTopic(subnetOf(peerId))`
    // and the wildcard; the buyer must query every subnet topic plus the
    // wildcard, with no extras and no missing entries. If a future change
    // diverges the two sides (e.g. announcer adopts a new SUBNET_COUNT but
    // lookup is left behind), this test fails immediately.
    let capturedHashes: Buffer[] = [];
    const lookupMany = vi.fn(async (hashes: Buffer[]) => {
      capturedHashes = hashes;
      return [] as PeerEndpoint[];
    });
    const dht = { lookupMany } as unknown as DHTNode;

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
    const queriedHashes = new Set(capturedHashes.map((h) => h.toString('hex')));
    expect(queriedHashes).toEqual(expectedHashes);
    expect(capturedHashes).toHaveLength(SUBNET_COUNT + 1);
  });

  it('findAll covers every subnetOf(peerId) the announcer might pick, across the full byte space', async () => {
    // Property-style: for any peerId, the subnet the announcer would publish
    // under (subnetTopic(subnetOf(peerId))) must be in the set of topics
    // findAll asks the DHT about. Combined with the symmetry test above, this
    // pins down the contract: announcer + lookup agree for every possible
    // peerId.
    let capturedHashes: Buffer[] = [];
    const lookupMany = vi.fn(async (hashes: Buffer[]) => {
      capturedHashes = hashes;
      return [] as PeerEndpoint[];
    });
    const dht = { lookupMany } as unknown as DHTNode;
    const peerLookup = new PeerLookup({
      dht,
      metadataResolver: { resolve: vi.fn() },
      requireValidSignature: false,
      allowStaleMetadata: true,
      maxAnnouncementAgeMs: 60_000,
      maxResults: 1000,
    });
    await peerLookup.findAll();

    const queriedHashes = new Set(capturedHashes.map((h) => h.toString('hex')));
    for (let byte = 0; byte < 256; byte++) {
      const peerId = byte.toString(16).padStart(2, '0') + 'a'.repeat(38);
      const announcedHashHex = topicToInfoHash(subnetTopic(subnetOf(peerId))).toString('hex');
      expect(queriedHashes.has(announcedHashHex)).toBe(true);
    }
  });

  it('findAll deduplicates a peer that appears on multiple topics (subnet + wildcard)', async () => {
    // Sellers running this build announce on both a subnet AND the wildcard
    // during the transition. `lookupMany` returns the duplicate raw endpoint
    // pair to the resolver, which must collapse it via the host:port dedup
    // before issuing metadata fetches.
    const shared: PeerEndpoint = { host: '10.0.7.1', port: 6882 };
    const lookupMany = vi.fn(async (hashes: Buffer[]) => hashes.map(() => shared));
    const dht = { lookupMany } as unknown as DHTNode;

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
    expect(lookupMany).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.host).toBe(shared.host);
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
    const lookupMany = vi.fn(async () => peers);
    const dht = { lookupMany } as unknown as DHTNode;

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

    const results = await peerLookup.findAll();
    expect(results).toHaveLength(1);
    expect(results[0]?.host).toBe('34.134.97.133');
    expect(results[0]?.port).toBe(6882);
    expect(results[0]?.metadata.publicAddress).toBe('34.27.100.162:6882');
  });
});

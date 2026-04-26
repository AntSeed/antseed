import { verifySignature, hexToBytes } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import {
  ANTSEED_WILDCARD_TOPIC,
  serviceTopic,
  serviceSearchTopic,
  capabilityTopic,
  peerTopic,
  subnetTopic,
  SUBNET_COUNT,
  topicToInfoHash,
  normalizeServiceTopicKey,
  normalizeServiceSearchTopicKey,
} from "./dht-node.js";
import type { PeerMetadata } from "./peer-metadata.js";
import { encodeMetadataForSigning } from "./metadata-codec.js";
import type { MetadataResolver, PeerEndpoint } from "./metadata-resolver.js";

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface LookupConfig {
  dht: DHTNode;
  metadataResolver: MetadataResolver;
  requireValidSignature: boolean;
  allowStaleMetadata: boolean;
  maxAnnouncementAgeMs: number;
  maxResults: number;
}

export const DEFAULT_LOOKUP_CONFIG: Omit<LookupConfig, "dht" | "metadataResolver"> = {
  requireValidSignature: true,
  allowStaleMetadata: false,
  maxAnnouncementAgeMs: 30 * 60 * 1000,
  // Old cap was 50; with the network growing past that, browse views were
  // silently truncated. 200 keeps the parallel metadata fan-out reasonable
  // while no longer hiding peers from ‘network browse’.
  maxResults: 200,
};

export interface LookupResult {
  metadata: PeerMetadata;
  host: string;
  port: number;
}

export class PeerLookup {
  private readonly config: LookupConfig;

  constructor(config: LookupConfig) {
    this.config = config;
  }

  /**
   * Enumerate every peer on the network.
   *
   * Each subnet topic only holds ~total/SUBNET_COUNT announcers, which keeps
   * us well under the K-closest saturation limit that made the single
   * wildcard topic return inconsistent subsets. The wildcard lookup is kept
   * in parallel as a transition fallback so buyers running this build still
   * see peers on older sellers that haven't started announcing on a subnet
   * topic yet. `resolveLookupResults` deduplicates by `host:port` before
   * resolving metadata, so the union has no extra cost beyond the parallel
   * lookups themselves.
   *
   * `Promise.allSettled` (not `Promise.all`) defends against a single
   * misbehaving subnet lookup taking the whole enumeration down: today
   * `DHTNode.lookup` swallows timeouts and resolves to `[]`, but that
   * invariant is one refactor away from breaking, and 17 in-flight lookups
   * raise the probability of any rejection accordingly. A failed subnet
   * just contributes zero endpoints; the rest of the network still surfaces.
   */
  async findAll(): Promise<LookupResult[]> {
    const subnetHashes = Array.from({ length: SUBNET_COUNT }, (_, i) =>
      topicToInfoHash(subnetTopic(i)),
    );
    const wildcardHash = topicToInfoHash(ANTSEED_WILDCARD_TOPIC);

    const settled = await Promise.allSettled(
      [...subnetHashes, wildcardHash].map((hash) => this.config.dht.lookup(hash)),
    );
    const merged: PeerEndpoint[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const peer of result.value) merged.push(peer);
    }
    return this.resolveLookupResults(shuffle(merged));
  }

  async findByService(service: string): Promise<LookupResult[]> {
    const canonicalTopic = serviceTopic(service);
    const canonicalInfoHash = topicToInfoHash(canonicalTopic);

    const canonicalServiceKey = normalizeServiceTopicKey(service);
    const compactServiceKey = normalizeServiceSearchTopicKey(service);
    if (compactServiceKey === canonicalServiceKey) {
      const peers = await this.config.dht.lookup(canonicalInfoHash);
      return this.resolveLookupResults(shuffle(peers));
    }

    const compactTopic = serviceSearchTopic(service);
    const compactInfoHash = topicToInfoHash(compactTopic);
    const [canonicalPeers, compactPeers] = await Promise.all([
      this.config.dht.lookup(canonicalInfoHash),
      this.config.dht.lookup(compactInfoHash),
    ]);
    return this.resolveLookupResults(shuffle([...canonicalPeers, ...compactPeers]));
  }

  async findByCapability(capability: string, name?: string): Promise<LookupResult[]> {
    const topic = capabilityTopic(capability, name);
    const infoHash = topicToInfoHash(topic);
    const peers = await this.config.dht.lookup(infoHash);
    return this.resolveLookupResults(shuffle(peers));
  }

  /**
   * Look up a single peer by its peerId via the per-peer DHT topic
   * (`antseed:peer:<peerId>`). Returns every endpoint whose served metadata
   * actually matches the requested peerId — a remote endpoint announcing
   * the topic but serving a different peer's metadata is filtered out, so
   * a hostile peer cannot squat another peer's identity.
   *
   * The peerId is normalized to lowercase hex; passing an empty / invalid
   * id returns an empty list.
   */
  async findByPeerId(peerId: string): Promise<LookupResult[]> {
    const normalized = peerId.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(normalized)) return [];
    const infoHash = topicToInfoHash(peerTopic(normalized));
    const peers = await this.config.dht.lookup(infoHash);
    return this.resolveLookupResults(shuffle(peers), { metadataPeerId: normalized });
  }

  private async resolveLookupResults(
    peers: PeerEndpoint[],
    options?: { metadataPeerId?: string; maxResults?: number },
  ): Promise<LookupResult[]> {
    const maxResults = options?.maxResults ?? this.config.maxResults;
    const metadataPeerId = options?.metadataPeerId;

    // Deduplicate endpoints before firing parallel requests
    const seenEndpoints = new Set<string>();
    const uniquePeers: PeerEndpoint[] = [];
    for (const peer of peers) {
      const key = `${peer.host.toLowerCase()}:${peer.port}`;
      if (!seenEndpoints.has(key)) {
        seenEndpoints.add(key);
        uniquePeers.push(peer);
      }
    }

    // Resolve all peers in parallel — bad-port timeouts no longer block good peers
    const settled = await Promise.allSettled(
      uniquePeers.map((peer) => this._resolveSinglePeer(peer)),
    );

    const results: LookupResult[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value !== null) {
        if (metadataPeerId && r.value.metadata.peerId.toLowerCase() !== metadataPeerId) {
          continue;
        }
        results.push(r.value);
        if (results.length >= maxResults) break;
      }
    }
    return results;
  }

  private async _resolveSinglePeer(peer: PeerEndpoint): Promise<LookupResult | null> {
    const metadata = await this.config.metadataResolver.resolve(peer);
    if (metadata === null) {
      return null;
    }

    if (this.config.requireValidSignature) {
      const valid = await this.verifyMetadataSignature(metadata);
      if (!valid) {
        return null;
      }
    }

    if (!this.config.allowStaleMetadata && this.isStale(metadata)) {
      return null;
    }

    return { metadata, host: peer.host, port: peer.port };
  }

  async verifyMetadataSignature(metadata: PeerMetadata): Promise<boolean> {
    const dataToVerify = encodeMetadataForSigning(metadata);
    const signature = hexToBytes(metadata.signature);
    return verifySignature(metadata.peerId, signature, dataToVerify);
  }

  isStale(metadata: PeerMetadata): boolean {
    const age = Date.now() - metadata.timestamp;
    return age > this.config.maxAnnouncementAgeMs;
  }
}

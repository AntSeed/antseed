import { verifySignature, hexToBytes } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import {
  ANTSEED_WILDCARD_TOPIC,
  capabilityTopic,
  peerTopic,
  subnetTopic,
  SUBNET_COUNT,
  topicToInfoHash,
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
  // Old cap was 50, then 200; with subnet fan-out and larger live networks,
  // keep browse/discovery truncation comfortably above current scale while
  // still bounding downstream enrichment/rendering work.
  maxResults: 1000,
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
   * `DHTNode.lookupMany` shares a single temporary "peer" listener across
   * the fan-out so subnet enumeration does not trip EventEmitter's default
   * listener limit. Failures inside `lookupMany` (per-infohash callback
   * errors) are absorbed and contribute zero endpoints, so a misbehaving
   * subnet doesn't black-hole the whole enumeration.
   */
  async findAll(): Promise<LookupResult[]> {
    const hashes = [
      ...Array.from({ length: SUBNET_COUNT }, (_, i) => topicToInfoHash(subnetTopic(i))),
      topicToInfoHash(ANTSEED_WILDCARD_TOPIC),
    ];
    const merged = await this.config.dht.lookupMany(hashes);
    return this.resolveLookupResults(shuffle(merged));
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

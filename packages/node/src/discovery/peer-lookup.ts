import { verifySignature, hexToBytes } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import {
  providerTopic,
  serviceTopic,
  serviceSearchTopic,
  capabilityTopic,
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
  maxResults: 50,
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

  async findSellers(provider: string): Promise<LookupResult[]> {
    const topic = providerTopic(provider);
    const infoHash = topicToInfoHash(topic);
    const peers = await this.config.dht.lookup(infoHash);
    return this.resolveLookupResults(shuffle(peers));
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

  private async resolveLookupResults(peers: PeerEndpoint[]): Promise<LookupResult[]> {
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
        results.push(r.value);
        if (results.length >= this.config.maxResults) break;
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
    const publicKey = hexToBytes(metadata.peerId);
    const signature = hexToBytes(metadata.signature);
    return verifySignature(publicKey, signature, dataToVerify);
  }

  isStale(metadata: PeerMetadata): boolean {
    const age = Date.now() - metadata.timestamp;
    return age > this.config.maxAnnouncementAgeMs;
  }
}

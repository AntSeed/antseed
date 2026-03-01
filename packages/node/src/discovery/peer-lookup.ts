import { verifySignature, hexToBytes } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import {
  providerTopic,
  modelTopic,
  modelSearchTopic,
  capabilityTopic,
  topicToInfoHash,
  normalizeModelTopicKey,
  normalizeModelSearchTopicKey,
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

  async findByModel(model: string): Promise<LookupResult[]> {
    const canonicalTopic = modelTopic(model);
    const canonicalInfoHash = topicToInfoHash(canonicalTopic);

    const canonicalModelKey = normalizeModelTopicKey(model);
    const compactModelKey = normalizeModelSearchTopicKey(model);
    if (compactModelKey === canonicalModelKey) {
      const peers = await this.config.dht.lookup(canonicalInfoHash);
      return this.resolveLookupResults(shuffle(peers));
    }

    const compactTopic = modelSearchTopic(model);
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
    const results: LookupResult[] = [];
    const seenEndpoints = new Set<string>();

    for (const peer of peers) {
      if (results.length >= this.config.maxResults) {
        break;
      }

      const endpointKey = `${peer.host.toLowerCase()}:${peer.port}`;
      if (seenEndpoints.has(endpointKey)) {
        continue;
      }
      seenEndpoints.add(endpointKey);

      const metadata = await this.config.metadataResolver.resolve(peer);
      if (metadata === null) {
        continue;
      }

      if (this.config.requireValidSignature) {
        const valid = await this.verifyMetadataSignature(metadata);
        if (!valid) {
          continue;
        }
      }

      if (!this.config.allowStaleMetadata && this.isStale(metadata)) {
        continue;
      }

      results.push({
        metadata,
        host: peer.host,
        port: peer.port,
      });
    }

    return results;
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

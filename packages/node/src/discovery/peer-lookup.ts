import { verifySignature, hexToBytes } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import { providerTopic, capabilityTopic, topicToInfoHash } from "./dht-node.js";
import type { PeerMetadata } from "./peer-metadata.js";
import { encodeMetadataForSigning } from "./metadata-codec.js";
import type { MetadataResolver } from "./metadata-resolver.js";

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

    const results: LookupResult[] = [];
    for (const peer of peers) {
      if (results.length >= this.config.maxResults) {
        break;
      }

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

  async findByCapability(capability: string, name?: string): Promise<LookupResult[]> {
    const topic = capabilityTopic(capability, name);
    const infoHash = topicToInfoHash(topic);
    const peers = await this.config.dht.lookup(infoHash);

    const results: LookupResult[] = [];
    for (const peer of peers) {
      if (results.length >= this.config.maxResults) {
        break;
      }

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

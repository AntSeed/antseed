import type { Identity } from "../p2p/identity.js";
import { signData } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import { providerTopic, capabilityTopic, topicToInfoHash } from "./dht-node.js";
import type { PeerOffering } from "../types/capability.js";
import type { PeerMetadata, ProviderAnnouncement } from "./peer-metadata.js";
import { METADATA_VERSION } from "./peer-metadata.js";
import { encodeMetadataForSigning } from "./metadata-codec.js";
import { debugWarn } from "../utils/debug.js";
import { bytesToHex } from "../utils/hex.js";
import type { BaseEscrowClient } from "../payments/evm/escrow-client.js";
import { identityToEvmAddress } from "../payments/evm/keypair.js";

export interface AnnouncerConfig {
  identity: Identity;
  dht: DHTNode;
  providers: Array<{
    provider: string;
    models: string[];
    maxConcurrency: number;
  }>;
  region: string;
  pricing: Map<
    string,
    {
      defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number };
      models?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
    }
  >;
  offerings?: PeerOffering[];
  stakeAmountUSDC?: number;
  trustScore?: number;
  escrowClient?: BaseEscrowClient;
  reannounceIntervalMs: number;
  signalingPort: number;
}

export class PeerAnnouncer {
  private readonly config: AnnouncerConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly loadMap: Map<string, number> = new Map();
  private _latestMetadata: PeerMetadata | null = null;

  constructor(config: AnnouncerConfig) {
    this.config = config;
  }

  async announce(): Promise<void> {
    const metadata = await this._buildSignedMetadata(true);
    this._latestMetadata = metadata;

    await this._announceTopics(metadata.providers);
  }

  /**
   * Refresh signed metadata snapshot without announcing to DHT.
   * Useful for high-frequency fields like current provider load.
   */
  async refreshMetadata(): Promise<void> {
    this._latestMetadata = await this._buildSignedMetadata(false);
  }

  startPeriodicAnnounce(): void {
    if (this.intervalHandle) {
      return;
    }
    // Announce immediately, then on interval
    void this.announce().catch((err) => {
      debugWarn(`[Announcer] Initial announce failed: ${err instanceof Error ? err.message : err}`);
    });
    this.intervalHandle = setInterval(() => {
      void this.announce().catch((err) => {
        debugWarn(`[Announcer] Periodic announce failed: ${err instanceof Error ? err.message : err}`);
      });
    }, this.config.reannounceIntervalMs);
  }

  stopPeriodicAnnounce(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  updateLoad(providerName: string, currentLoad: number): void {
    this.loadMap.set(providerName, currentLoad);
  }

  getLatestMetadata(): PeerMetadata | null {
    return this._latestMetadata;
  }

  private async _buildSignedMetadata(includeOnChainReputation = true): Promise<PeerMetadata> {
    const providers: ProviderAnnouncement[] = this.config.providers.map((p) => {
      const pricing = this.config.pricing.get(p.provider) ?? {
        defaults: {
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
        },
      };
      const providerAnnouncement: ProviderAnnouncement = {
        provider: p.provider,
        models: p.models,
        defaultPricing: pricing.defaults,
        maxConcurrency: p.maxConcurrency,
        currentLoad: this.loadMap.get(p.provider) ?? 0,
      };
      if (pricing.models) {
        providerAnnouncement.modelPricing = pricing.models;
      }
      return providerAnnouncement;
    });

    const metadata: PeerMetadata = {
      peerId: this.config.identity.peerId,
      version: METADATA_VERSION,
      providers,
      region: this.config.region,
      timestamp: Date.now(),
      signature: "",
    };
    if (this.config.offerings && this.config.offerings.length > 0) {
      metadata.offerings = this.config.offerings;
    }
    if (this.config.stakeAmountUSDC != null) {
      metadata.stakeAmountUSDC = this.config.stakeAmountUSDC;
    }
    if (this.config.trustScore != null) {
      metadata.trustScore = this.config.trustScore;
    }

    if (this.config.escrowClient) {
      const evmAddress = identityToEvmAddress(this.config.identity);
      metadata.evmAddress = evmAddress;

      if (includeOnChainReputation) {
        try {
          const reputation = await this.config.escrowClient.getReputation(evmAddress);
          metadata.onChainReputation = reputation.weightedAverage;
          metadata.onChainSessionCount = reputation.sessionCount;
          metadata.onChainDisputeCount = reputation.disputeCount;
        } catch {
          // Silently continue without reputation data
        }
      } else if (this._latestMetadata) {
        metadata.onChainReputation = this._latestMetadata.onChainReputation;
        metadata.onChainSessionCount = this._latestMetadata.onChainSessionCount;
        metadata.onChainDisputeCount = this._latestMetadata.onChainDisputeCount;
      }
    }

    const dataToSign = encodeMetadataForSigning(metadata);
    const signature = await signData(this.config.identity.privateKey, dataToSign);
    metadata.signature = bytesToHex(signature);
    return metadata;
  }

  private async _announceTopics(providers: ProviderAnnouncement[]): Promise<void> {
    for (const p of providers) {
      await this._tryAnnounceTopic(providerTopic(p.provider));
    }

    await this._tryAnnounceTopic(providerTopic("*"));

    if (this.config.offerings) {
      for (const offering of this.config.offerings) {
        await this._tryAnnounceTopic(capabilityTopic(offering.capability, offering.name));
      }
    }
  }

  private async _tryAnnounceTopic(topic: string): Promise<void> {
    try {
      const infoHash = topicToInfoHash(topic);
      await this.config.dht.announce(infoHash, this.config.signalingPort);
    } catch {
      // DHT may not have peers yet — will retry on next cycle
    }
  }
}

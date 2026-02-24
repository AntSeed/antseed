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
    const providers: ProviderAnnouncement[] = this.config.providers.map((p) => {
      const pricing = this.config.pricing.get(p.provider) ?? {
        defaults: {
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
        },
      };
      return {
        provider: p.provider,
        models: p.models,
        defaultPricing: pricing.defaults,
        ...(pricing.models ? { modelPricing: pricing.models } : {}),
        maxConcurrency: p.maxConcurrency,
        currentLoad: this.loadMap.get(p.provider) ?? 0,
      };
    });

    const metadata: PeerMetadata = {
      peerId: this.config.identity.peerId,
      version: METADATA_VERSION,
      providers,
      ...(this.config.offerings && this.config.offerings.length > 0
        ? { offerings: this.config.offerings }
        : {}),
      ...(this.config.stakeAmountUSDC != null
        ? { stakeAmountUSDC: this.config.stakeAmountUSDC }
        : {}),
      ...(this.config.trustScore != null
        ? { trustScore: this.config.trustScore }
        : {}),
      region: this.config.region,
      timestamp: Date.now(),
      signature: "",
    };

    // Populate EVM address and on-chain reputation if escrow client is available
    if (this.config.escrowClient) {
      try {
        const evmAddress = identityToEvmAddress(this.config.identity);
        metadata.evmAddress = evmAddress;
        const reputation = await this.config.escrowClient.getReputation(evmAddress);
        metadata.onChainReputation = reputation.weightedAverage;
        metadata.onChainSessionCount = reputation.sessionCount;
        metadata.onChainDisputeCount = reputation.disputeCount;
      } catch {
        // Silently continue without reputation data
      }
    }

    // Sign metadata
    const dataToSign = encodeMetadataForSigning(metadata);
    const signature = await signData(
      this.config.identity.privateKey,
      dataToSign
    );
    metadata.signature = bytesToHex(signature);
    this._latestMetadata = metadata;

    // Announce under each provider topic (continue on failure)
    for (const p of providers) {
      try {
        const topic = providerTopic(p.provider);
        const infoHash = topicToInfoHash(topic);
        await this.config.dht.announce(infoHash, this.config.signalingPort);
      } catch {
        // DHT may not have peers yet — will retry on next cycle
      }
    }

    // Also announce under the wildcard topic for generic discovery
    try {
      const wildcardInfoHash = topicToInfoHash(providerTopic("*"));
      await this.config.dht.announce(wildcardInfoHash, this.config.signalingPort);
    } catch {
      // DHT may not have peers yet — will retry on next cycle
    }

    // Announce under each capability topic
    if (this.config.offerings) {
      for (const offering of this.config.offerings) {
        try {
          const topic = capabilityTopic(offering.capability, offering.name);
          const infoHash = topicToInfoHash(topic);
          await this.config.dht.announce(infoHash, this.config.signalingPort);
        } catch {
          // DHT may not have peers yet — will retry on next cycle
        }
      }
    }
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
}

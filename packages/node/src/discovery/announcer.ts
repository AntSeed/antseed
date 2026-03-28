import type { Identity } from "../p2p/identity.js";
import { signData } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import {
  ANTSEED_WILDCARD_TOPIC,
  serviceTopic,
  serviceSearchTopic,
  capabilityTopic,
  topicToInfoHash,
  normalizeServiceTopicKey,
  normalizeServiceSearchTopicKey,
} from "./dht-node.js";
import type { PeerOffering } from "../types/capability.js";
import type { PeerMetadata, ProviderAnnouncement } from "./peer-metadata.js";
import { METADATA_VERSION } from "./peer-metadata.js";
import type { ServiceApiProtocol } from "../types/service-api.js";
import { isKnownServiceApiProtocol } from "../types/service-api.js";
import { encodeMetadataForSigning } from "./metadata-codec.js";
import { debugWarn } from "../utils/debug.js";
import { bytesToHex } from "../utils/hex.js";
// Announcer uses StatsClient + StakingClient for on-chain stats lookup
import type { StatsClient } from "../payments/evm/stats-client.js";
import type { StakingClient } from "../payments/evm/staking-client.js";

export interface AnnouncerConfig {
  identity: Identity;
  dht: DHTNode;
  providers: Array<{
    provider: string;
    services: string[];
    serviceCategories?: Record<string, string[]>;
    serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
    maxConcurrency: number;
  }>;
  displayName?: string;
  publicAddress?: string;
  region: string;
  pricing: Map<
    string,
    {
      defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number };
      services?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
    }
  >;
  offerings?: PeerOffering[];
  stakeAmountUSDC?: number;
  trustScore?: number;
  /** @deprecated Use statsClient for payments-enabled checks */
  paymentsEnabled?: boolean;
  statsClient?: StatsClient;
  stakingClient?: StakingClient;
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
        services: p.services,
        defaultPricing: pricing.defaults,
        maxConcurrency: p.maxConcurrency,
        currentLoad: this.loadMap.get(p.provider) ?? 0,
      };
      if (pricing.services) {
        providerAnnouncement.servicePricing = pricing.services;
      }
      const normalizedServiceCategories = this._normalizeServiceCategories(p.serviceCategories, p.services);
      if (normalizedServiceCategories) {
        providerAnnouncement.serviceCategories = normalizedServiceCategories;
      }
      const normalizedServiceApiProtocols = this._normalizeServiceApiProtocols(p.serviceApiProtocols, p.services);
      if (normalizedServiceApiProtocols) {
        providerAnnouncement.serviceApiProtocols = normalizedServiceApiProtocols;
      }
      return providerAnnouncement;
    });

    const metadata: PeerMetadata = {
      peerId: this.config.identity.peerId,
      version: METADATA_VERSION,
      ...(this.config.displayName ? { displayName: this.config.displayName } : {}),
      ...(this.config.publicAddress ? { publicAddress: this.config.publicAddress } : {}),
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

    if (this.config.paymentsEnabled) {
      if (includeOnChainReputation && this.config.statsClient && this.config.stakingClient) {
        try {
          const evmAddress = this.config.identity.wallet.address;
          const agentId = await this.config.stakingClient.getAgentId(evmAddress);
          const stats = await this.config.statsClient.getStats(agentId);
          metadata.onChainReputation = stats.sessionCount;
          metadata.onChainSessionCount = stats.sessionCount;
          metadata.onChainDisputeCount = stats.ghostCount;
        } catch {
          // Stats/staking contract lookup failed — skip on-chain stats for this cycle
        }
      } else if (this._latestMetadata) {
        metadata.onChainReputation = this._latestMetadata.onChainReputation;
        metadata.onChainSessionCount = this._latestMetadata.onChainSessionCount;
        metadata.onChainDisputeCount = this._latestMetadata.onChainDisputeCount;
      }
    }

    const dataToSign = encodeMetadataForSigning(metadata);
    const signature = signData(this.config.identity.wallet, dataToSign);
    metadata.signature = bytesToHex(signature);
    return metadata;
  }

  private async _announceTopics(providers: ProviderAnnouncement[]): Promise<void> {
    const announcedServiceTopics = new Set<string>();

    for (const p of providers) {
      for (const service of p.services) {
        const canonicalServiceKey = normalizeServiceTopicKey(service);
        if (!canonicalServiceKey) {
          continue;
        }
        const canonicalTopic = serviceTopic(canonicalServiceKey);
        if (!announcedServiceTopics.has(canonicalTopic)) {
          announcedServiceTopics.add(canonicalTopic);
          await this._tryAnnounceTopic(canonicalTopic);
        }

        const compactServiceKey = normalizeServiceSearchTopicKey(service);
        if (compactServiceKey !== canonicalServiceKey) {
          const compactTopic = serviceSearchTopic(compactServiceKey);
          if (!announcedServiceTopics.has(compactTopic)) {
            announcedServiceTopics.add(compactTopic);
            await this._tryAnnounceTopic(compactTopic);
          }
        }
      }
    }

    await this._tryAnnounceTopic(ANTSEED_WILDCARD_TOPIC);

    if (this.config.offerings) {
      const announcedCapabilities = new Set<string>();
      for (const offering of this.config.offerings) {
        await this._tryAnnounceTopic(capabilityTopic(offering.capability, offering.name));
        const normalizedCapability = offering.capability.trim().toLowerCase();
        if (!normalizedCapability) {
          continue;
        }
        if (!announcedCapabilities.has(normalizedCapability)) {
          announcedCapabilities.add(normalizedCapability);
          await this._tryAnnounceTopic(capabilityTopic(normalizedCapability));
        }
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

  private _normalizeServiceCategories(
    serviceCategories: Record<string, string[]> | undefined,
    supportedServices: string[],
  ): Record<string, string[]> | undefined {
    if (!serviceCategories) {
      return undefined;
    }

    const hasWildcardServices = supportedServices.length === 0;
    const supportedServiceSet = new Set(supportedServices);
    const normalized: Record<string, string[]> = {};
    for (const [service, categories] of Object.entries(serviceCategories)) {
      if (!hasWildcardServices && !supportedServiceSet.has(service)) {
        continue;
      }
      const deduped = Array.from(
        new Set(
          categories
            .map((category) => category.trim().toLowerCase())
            .filter((category) => category.length > 0),
        ),
      );
      if (deduped.length === 0) {
        continue;
      }
      normalized[service] = deduped;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private _normalizeServiceApiProtocols(
    serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
    supportedServices: string[],
  ): Record<string, ServiceApiProtocol[]> | undefined {
    if (!serviceApiProtocols) {
      return undefined;
    }

    const hasWildcardServices = supportedServices.length === 0;
    const supportedServiceSet = new Set(supportedServices);
    const normalized: Record<string, ServiceApiProtocol[]> = {};
    for (const [service, protocols] of Object.entries(serviceApiProtocols)) {
      if (!hasWildcardServices && !supportedServiceSet.has(service)) {
        continue;
      }
      const deduped = Array.from(
        new Set(
          protocols
            .map((protocol) => protocol.trim().toLowerCase())
            .filter((protocol): protocol is ServiceApiProtocol => isKnownServiceApiProtocol(protocol)),
        ),
      );
      if (deduped.length === 0) {
        continue;
      }
      normalized[service] = deduped;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }
}

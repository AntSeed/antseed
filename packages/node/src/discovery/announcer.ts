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
import type { StakingClient } from "../payments/evm/staking-client.js";
import type { ChannelsClient } from "../payments/evm/channels-client.js";
import type { DHTHealthMonitor } from "./dht-health.js";

export interface AnnouncerConfig {
  identity: Identity;
  dht: DHTNode;
  providers: Array<{
    provider: string;
    services: string[];
    serviceCategories?: Record<string, string[]>;
    serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
    maxConcurrency: number;
    /** Per-instance pricing. Takes precedence over the shared pricing Map. */
    pricing?: {
      defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number };
      services?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
    };
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
  paymentsEnabled?: boolean;
  channelsClient?: ChannelsClient;
  stakingClient?: StakingClient;
  reannounceIntervalMs: number;
  signalingPort: number;
  /** Optional health monitor — if supplied, announce outcomes are recorded. */
  healthMonitor?: DHTHealthMonitor;
}

/**
 * Retry schedule when one or more canonical service topics fail to announce.
 * Silent 15-min waits used to be the failure mode; these short backoffs let
 * a seller recover from transient DHT hiccups before buyers decide the peer
 * has disappeared (buyer staleness cutoff is 30 min).
 */
const ANNOUNCE_RETRY_BACKOFFS_MS = [60_000, 120_000, 300_000, 600_000];

export class PeerAnnouncer {
  private readonly config: AnnouncerConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private retryHandle: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private readonly loadMap: Map<string, number> = new Map();
  private _latestMetadata: PeerMetadata | null = null;

  constructor(config: AnnouncerConfig) {
    this.config = config;
  }

  async announce(): Promise<void> {
    const metadata = await this._buildSignedMetadata(true);
    this._latestMetadata = metadata;

    const failures = await this._announceTopics(metadata.providers);
    if (failures > 0) {
      this._scheduleRetryAfterFailure(failures);
    } else if (this.retryAttempt > 0 || this.retryHandle) {
      // Recovered — cancel any pending retry and reset backoff.
      this._cancelRetry();
    }
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
    this._cancelRetry();
  }

  private _cancelRetry(): void {
    if (this.retryHandle) {
      clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
    this.retryAttempt = 0;
  }

  private _scheduleRetryAfterFailure(failures: number): void {
    if (this.retryHandle) {
      // A retry is already scheduled for this cycle; don't stack.
      return;
    }
    const idx = Math.min(this.retryAttempt, ANNOUNCE_RETRY_BACKOFFS_MS.length - 1);
    const delayMs = Math.min(
      ANNOUNCE_RETRY_BACKOFFS_MS[idx] ?? ANNOUNCE_RETRY_BACKOFFS_MS[ANNOUNCE_RETRY_BACKOFFS_MS.length - 1]!,
      // Never wait longer than the next periodic cycle — the interval will retry anyway.
      this.config.reannounceIntervalMs,
    );
    this.retryAttempt += 1;
    debugWarn(
      `[Announcer] ${failures} topic announce(s) failed; retry #${this.retryAttempt} in ${Math.round(delayMs / 1000)}s`,
    );
    this.retryHandle = setTimeout(() => {
      this.retryHandle = null;
      void this.announce().catch((err) => {
        debugWarn(`[Announcer] Retry announce failed: ${err instanceof Error ? err.message : err}`);
      });
    }, delayMs);
  }

  updateLoad(providerName: string, currentLoad: number): void {
    this.loadMap.set(providerName, currentLoad);
  }

  getLatestMetadata(): PeerMetadata | null {
    return this._latestMetadata;
  }

  private async _buildSignedMetadata(includeOnChainReputation = true): Promise<PeerMetadata> {
    const providers: ProviderAnnouncement[] = this.config.providers.map((p) => {
      const pricing = p.pricing ?? this.config.pricing.get(p.provider) ?? {
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
      if (includeOnChainReputation && this.config.channelsClient && this.config.stakingClient) {
        try {
          const evmAddress = this.config.identity.wallet.address;
          const agentId = await this.config.stakingClient.getAgentId(evmAddress);
          const stats = await this.config.channelsClient.getAgentStats(agentId);
          metadata.onChainChannelCount = stats.channelCount;
          metadata.onChainGhostCount = stats.ghostCount;
        } catch {
          // Channels/staking contract lookup failed — skip on-chain stats for this cycle
        }
      } else if (this._latestMetadata) {
        metadata.onChainChannelCount = this._latestMetadata.onChainChannelCount;
        metadata.onChainGhostCount = this._latestMetadata.onChainGhostCount;
      }
    }

    const dataToSign = encodeMetadataForSigning(metadata);
    const signature = signData(this.config.identity.wallet, dataToSign);
    metadata.signature = bytesToHex(signature);
    return metadata;
  }

  private async _announceTopics(providers: ProviderAnnouncement[]): Promise<number> {
    const announcedServiceTopics = new Set<string>();
    let failures = 0;

    for (const p of providers) {
      for (const service of p.services) {
        const canonicalServiceKey = normalizeServiceTopicKey(service);
        if (!canonicalServiceKey) {
          continue;
        }
        const canonicalTopic = serviceTopic(canonicalServiceKey);
        if (!announcedServiceTopics.has(canonicalTopic)) {
          announcedServiceTopics.add(canonicalTopic);
          if (!(await this._tryAnnounceTopic(canonicalTopic))) failures += 1;
        }

        const compactServiceKey = normalizeServiceSearchTopicKey(service);
        if (compactServiceKey !== canonicalServiceKey) {
          const compactTopic = serviceSearchTopic(compactServiceKey);
          if (!announcedServiceTopics.has(compactTopic)) {
            announcedServiceTopics.add(compactTopic);
            if (!(await this._tryAnnounceTopic(compactTopic))) failures += 1;
          }
        }
      }
    }

    if (!(await this._tryAnnounceTopic(ANTSEED_WILDCARD_TOPIC))) failures += 1;

    if (this.config.offerings) {
      const announcedCapabilities = new Set<string>();
      for (const offering of this.config.offerings) {
        if (!(await this._tryAnnounceTopic(capabilityTopic(offering.capability, offering.name)))) {
          failures += 1;
        }
        const normalizedCapability = offering.capability.trim().toLowerCase();
        if (!normalizedCapability) {
          continue;
        }
        if (!announcedCapabilities.has(normalizedCapability)) {
          announcedCapabilities.add(normalizedCapability);
          if (!(await this._tryAnnounceTopic(capabilityTopic(normalizedCapability)))) {
            failures += 1;
          }
        }
      }
    }

    return failures;
  }

  private async _tryAnnounceTopic(topic: string): Promise<boolean> {
    try {
      const infoHash = topicToInfoHash(topic);
      await this.config.dht.announce(infoHash, this.config.signalingPort);
      this.config.healthMonitor?.recordAnnounce(true);
      return true;
    } catch (err) {
      this.config.healthMonitor?.recordAnnounce(false);
      debugWarn(`[Announcer] Announce failed for ${topic}: ${err instanceof Error ? err.message : err}`);
      return false;
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

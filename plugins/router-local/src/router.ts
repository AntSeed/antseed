import type { Router, PeerInfo, SerializedHttpRequest } from '@antseed/node';
import {
  scoreCandidates,
  PeerMetricsTracker,
  type TokenPricingUsdPerMillion,
  type ScoringWeights,
} from '@antseed/router-core';

export interface BuyerMaxPricingConfig {
  defaults: TokenPricingUsdPerMillion;
  providers?: Record<string, {
    defaults?: TokenPricingUsdPerMillion;
    models?: Record<string, TokenPricingUsdPerMillion>;
  }>;
}

export interface LocalRouterConfig {
  preferredProviders?: string[];
  minReputation?: number;
  maxPricing?: BuyerMaxPricingConfig;
  maxFailures?: number;
  failureCooldownMs?: number;
  maxPeerStalenessMs?: number;
  weights?: Partial<ScoringWeights>;
  now?: () => number;
}

export class LocalRouter implements Router {
  private readonly _preferredProviders: string[];
  private readonly _minReputation: number;
  private readonly _maxPricing: BuyerMaxPricingConfig;
  private readonly _maxFailures: number;
  private readonly _maxPeerStalenessMs: number;
  private readonly _now: () => number;
  private readonly _weights: Partial<ScoringWeights> | undefined;
  private readonly _metrics: PeerMetricsTracker;

  constructor(config?: LocalRouterConfig) {
    this._preferredProviders = (config?.preferredProviders ?? [])
      .map((provider) => provider.trim())
      .filter((provider) => provider.length > 0);
    this._minReputation = config?.minReputation ?? 50;
    this._maxPricing = {
      defaults: {
        inputUsdPerMillion: config?.maxPricing?.defaults.inputUsdPerMillion ?? Number.POSITIVE_INFINITY,
        outputUsdPerMillion: config?.maxPricing?.defaults.outputUsdPerMillion ?? Number.POSITIVE_INFINITY,
      },
      ...(config?.maxPricing?.providers ? { providers: config.maxPricing.providers } : {}),
    };
    this._maxFailures = Math.max(1, config?.maxFailures ?? 3);
    this._maxPeerStalenessMs = Math.max(1, config?.maxPeerStalenessMs ?? 300_000);
    this._now = config?.now ?? (() => Date.now());
    this._weights = config?.weights;
    this._metrics = new PeerMetricsTracker({
      maxFailures: this._maxFailures,
      failureCooldownMs: Math.max(1, config?.failureCooldownMs ?? 30_000),
      now: this._now,
    });
  }

  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    const now = this._now();
    const requestedModel = this._extractRequestedModel(req);

    const candidates: {
      peer: PeerInfo;
      provider: string;
      providerRank: number;
      offer: TokenPricingUsdPerMillion;
    }[] = [];

    for (const peer of peers) {
      // Reputation filter
      if (this._hasReputation(peer)) {
        const reputation = this._effectiveReputation(peer);
        if (reputation < this._minReputation) {
          continue;
        }
      }

      // Cooldown filter
      if (this._metrics.isCoolingDown(peer.peerId)) {
        continue;
      }

      // Provider availability filter
      const selectedProvider = this._selectProviderForPeer(peer);
      if (!selectedProvider) {
        continue;
      }

      // Pricing filter
      const offer = this._resolvePeerOfferPrice(peer, selectedProvider.provider, requestedModel);
      if (!offer) {
        continue;
      }

      const max = this._resolveBuyerMaxPrice(selectedProvider.provider, requestedModel);
      if (offer.inputUsdPerMillion > max.inputUsdPerMillion || offer.outputUsdPerMillion > max.outputUsdPerMillion) {
        continue;
      }

      candidates.push({
        peer,
        provider: selectedProvider.provider,
        providerRank: selectedProvider.rank,
        offer,
      });
    }

    if (candidates.length === 0) return null;

    // Provider preference filtering
    let providerFiltered = candidates;
    if (this._preferredProviders.length > 0) {
      const bestRank = Math.min(...candidates.map((c) => c.providerRank));
      providerFiltered = candidates.filter((c) => c.providerRank === bestRank);
    }

    if (providerFiltered.length === 1) {
      return providerFiltered[0]!.peer;
    }

    // Delegate scoring to router-core
    const scoringInput = providerFiltered.map((c) => ({
      peer: c.peer,
      provider: c.provider,
      providerRank: c.providerRank,
      offer: c.offer,
      metrics: this._metrics.getMetrics(c.peer.peerId),
    }));

    const scored = scoreCandidates(scoringInput, {
      now,
      medianLatency: this._metrics.getMedianLatency(),
      maxPeerStalenessMs: this._maxPeerStalenessMs,
      maxFailures: this._maxFailures,
      weights: this._weights,
    });

    return scored[0]?.peer ?? null;
  }

  onResult(
    peer: PeerInfo,
    result: { success: boolean; latencyMs: number; tokens: number },
  ): void {
    this._metrics.recordResult(peer.peerId, {
      success: result.success,
      latencyMs: result.latencyMs,
    });
  }

  private _effectiveReputation(p: PeerInfo): number {
    if (p.onChainReputation !== undefined) {
      return p.onChainReputation;
    }
    return p.trustScore ?? p.reputationScore ?? 0;
  }

  private _hasReputation(p: PeerInfo): boolean {
    if (this._isFiniteNonNegative(p.onChainReputation)) {
      const sessionCount = this._isFiniteNonNegative(p.onChainSessionCount) ? p.onChainSessionCount : undefined;
      const disputeCount = this._isFiniteNonNegative(p.onChainDisputeCount) ? p.onChainDisputeCount : undefined;
      if (sessionCount !== undefined || disputeCount !== undefined) {
        return (sessionCount ?? 0) > 0 || (disputeCount ?? 0) > 0;
      }
      return true;
    }

    return this._isFiniteNonNegative(p.trustScore) || this._isFiniteNonNegative(p.reputationScore);
  }

  private _extractRequestedModel(req: SerializedHttpRequest): string | null {
    const contentType = req.headers['content-type'] ?? req.headers['Content-Type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return null;
    }

    try {
      const parsed = JSON.parse(new TextDecoder().decode(req.body)) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      const model = (parsed as Record<string, unknown>)['model'];
      return typeof model === 'string' && model.trim().length > 0 ? model.trim() : null;
    } catch {
      return null;
    }
  }

  private _selectProviderForPeer(peer: PeerInfo): { provider: string; rank: number } | null {
    const availableProviders = peer.providers
      .map((provider) => provider.trim())
      .filter((provider) => provider.length > 0);

    if (this._preferredProviders.length === 0) {
      const provider = availableProviders[0];
      return provider ? { provider, rank: Number.MAX_SAFE_INTEGER } : null;
    }

    for (let i = 0; i < this._preferredProviders.length; i++) {
      const preferred = this._preferredProviders[i]!;
      if (availableProviders.includes(preferred)) {
        return { provider: preferred, rank: i };
      }
    }

    return null;
  }

  private _resolvePeerOfferPrice(
    peer: PeerInfo,
    provider: string,
    model: string | null,
  ): TokenPricingUsdPerMillion | null {
    const providerPricing = peer.providerPricing?.[provider];

    if (model) {
      const modelSpecific = providerPricing?.models?.[model];
      if (modelSpecific && this._isValidOffer(modelSpecific)) {
        return modelSpecific;
      }
    }

    const providerDefaults = providerPricing?.defaults;
    if (providerDefaults && this._isValidOffer(providerDefaults)) {
      return providerDefaults;
    }

    if (
      this._isFiniteNonNegative(peer.defaultInputUsdPerMillion) &&
      this._isFiniteNonNegative(peer.defaultOutputUsdPerMillion)
    ) {
      return {
        inputUsdPerMillion: peer.defaultInputUsdPerMillion,
        outputUsdPerMillion: peer.defaultOutputUsdPerMillion,
      };
    }

    return null;
  }

  private _resolveBuyerMaxPrice(provider: string, model: string | null): TokenPricingUsdPerMillion {
    const providerPricing = this._maxPricing.providers?.[provider];

    if (model) {
      const modelOverride = providerPricing?.models?.[model];
      if (modelOverride && this._isValidOffer(modelOverride)) {
        return modelOverride;
      }
    }

    const providerDefaults = providerPricing?.defaults;
    if (providerDefaults && this._isValidOffer(providerDefaults)) {
      return providerDefaults;
    }

    return this._maxPricing.defaults;
  }

  private _isFiniteNonNegative(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  private _isValidOffer(offer: TokenPricingUsdPerMillion): boolean {
    return (
      this._isFiniteNonNegative(offer.inputUsdPerMillion) &&
      this._isFiniteNonNegative(offer.outputUsdPerMillion)
    );
  }
}

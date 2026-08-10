import { computeOnChainReputationScore, type Router, type PeerInfo, type SerializedHttpRequest } from '@antseed/node';
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
    services?: Record<string, TokenPricingUsdPerMillion>;
  }>;
}

export interface LocalRouterConfig {
  minReputation?: number;
  maxPricing?: BuyerMaxPricingConfig;
  maxFailures?: number;
  failureCooldownMs?: number;
  maxPeerStalenessMs?: number;
  weights?: Partial<ScoringWeights>;
  now?: () => number;
}

export type PeerPolicyEvaluation =
  | { allowed: true; code: 'eligible'; reason: null }
  | {
    allowed: false;
    code: 'reputation_below_minimum' | 'price_above_maximum' | 'policy_rejected';
    reason: string;
  };

export class LocalRouter implements Router {
  private readonly _minReputation: number;
  private readonly _maxPricing: BuyerMaxPricingConfig;
  private readonly _maxFailures: number;
  private readonly _maxPeerStalenessMs: number;
  private readonly _now: () => number;
  private readonly _weights: Partial<ScoringWeights> | undefined;
  private readonly _metrics: PeerMetricsTracker;

  constructor(config?: LocalRouterConfig) {
    this._minReputation = config?.minReputation ?? 0;
    this._maxPricing = {
      defaults: {
        inputUsdPerMillion: config?.maxPricing?.defaults.inputUsdPerMillion ?? Number.POSITIVE_INFINITY,
        outputUsdPerMillion: config?.maxPricing?.defaults.outputUsdPerMillion ?? Number.POSITIVE_INFINITY,
        ...(config?.maxPricing?.defaults.cachedInputUsdPerMillion != null
          ? { cachedInputUsdPerMillion: config.maxPricing.defaults.cachedInputUsdPerMillion }
          : {}),
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
    const requestedService = this._extractRequestedService(req);

    const candidates: {
      peer: PeerInfo;
      provider: string;
      offer: TokenPricingUsdPerMillion;
    }[] = [];

    for (const peer of peers) {
      // Reputation filter
      if (this._effectiveReputation(peer) < this._minReputation) {
        continue;
      }

      // Cooldown filter
      if (this._metrics.isCoolingDown(peer.peerId)) {
        continue;
      }

      // Provider availability filter
      const provider = this._selectProviderForPeer(peer, requestedService);
      if (!provider) {
        continue;
      }

      // Pricing filter
      const offer = this._resolvePeerOfferPrice(peer, provider, requestedService);
      if (!offer) {
        continue;
      }

      const max = this._resolveBuyerMaxPrice(provider, requestedService);
      if (this._offerExceedsMaxPrice(offer, max)) {
        continue;
      }

      candidates.push({ peer, provider, offer });
    }

    if (candidates.length === 0) return null;

    if (candidates.length === 1) {
      return candidates[0]!.peer;
    }

    // Delegate scoring to router-core
    const scoringInput = candidates.map((c) => ({
      peer: c.peer,
      provider: c.provider,
      providerRank: 0,
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

  allowsPeerForPricing(req: SerializedHttpRequest, peer: PeerInfo): boolean {
    const evaluation = this.evaluatePeerForPolicy(req, peer, { reputation: false });
    return evaluation.allowed;
  }

  allowsPeerForPolicy(req: SerializedHttpRequest, peer: PeerInfo): boolean {
    return this.evaluatePeerForPolicy(req, peer).allowed;
  }

  evaluatePeerForPolicy(
    req: SerializedHttpRequest,
    peer: PeerInfo,
    options: { reputation?: boolean } = {},
  ): PeerPolicyEvaluation {
    const effectiveReputation = this._effectiveReputation(peer);
    if (options.reputation !== false && effectiveReputation < this._minReputation) {
      return {
        allowed: false,
        code: 'reputation_below_minimum',
        reason: `peer reputation ${effectiveReputation} is below buyer minimum ${this._minReputation}`,
      };
    }

    const requestedService = this._extractRequestedService(req);
    const provider = this._selectProviderForPeer(peer, requestedService);
    if (!provider) {
      return {
        allowed: false,
        code: 'policy_rejected',
        reason: 'buyer policy could not resolve an advertised provider for this service',
      };
    }

    const offer = this._resolvePeerOfferPrice(peer, provider, requestedService);
    if (!offer) {
      return {
        allowed: false,
        code: 'policy_rejected',
        reason: 'buyer policy could not resolve valid pricing for this service',
      };
    }

    const max = this._resolveBuyerMaxPrice(provider, requestedService);
    if (this._offerExceedsMaxPrice(offer, max)) {
      return {
        allowed: false,
        code: 'price_above_maximum',
        reason: 'peer pricing exceeds the buyer maximum for this service',
      };
    }

    return { allowed: true, code: 'eligible', reason: null };
  }

  private _effectiveReputation(p: PeerInfo): number {
    return computeOnChainReputationScore(p) ?? p.reputationScore ?? 0;
  }

  private _extractRequestedService(req: SerializedHttpRequest): string | null {
    const contentType = req.headers['content-type'] ?? req.headers['Content-Type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return null;
    }

    try {
      const parsed = JSON.parse(new TextDecoder().decode(req.body)) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      const service = (parsed as Record<string, unknown>)['model'];
      return typeof service === 'string' && service.trim().length > 0 ? service.trim() : null;
    } catch {
      return null;
    }
  }

  private _selectProviderForPeer(peer: PeerInfo, requestedService: string | null): string | null {
    const availableProviders = peer.providers
      .map((provider) => provider.trim())
      .filter((provider) => provider.length > 0);

    if (requestedService && peer.providerPricing) {
      for (const provider of availableProviders) {
        const pricing = peer.providerPricing[provider];
        if (pricing?.services?.[requestedService]) return provider;
      }
    }

    return availableProviders[0] ?? null;
  }

  private _resolvePeerOfferPrice(
    peer: PeerInfo,
    provider: string,
    service: string | null,
  ): TokenPricingUsdPerMillion | null {
    const providerPricing = peer.providerPricing?.[provider];

    if (service) {
      const serviceSpecific = providerPricing?.services?.[service];
      if (serviceSpecific) {
        return this._isValidOffer(serviceSpecific) ? serviceSpecific : null;
      }
    }

    const providerDefaults = providerPricing?.defaults;
    if (providerDefaults) {
      return this._isValidOffer(providerDefaults) ? providerDefaults : null;
    }

    if (
      this._isFiniteNonNegative(peer.defaultInputUsdPerMillion) &&
      this._isFiniteNonNegative(peer.defaultOutputUsdPerMillion)
    ) {
      return {
        inputUsdPerMillion: peer.defaultInputUsdPerMillion,
        outputUsdPerMillion: peer.defaultOutputUsdPerMillion,
        ...(this._isFiniteNonNegative(peer.defaultCachedInputUsdPerMillion)
          ? { cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion }
          : {}),
      };
    }

    return null;
  }

  private _resolveBuyerMaxPrice(provider: string, service: string | null): TokenPricingUsdPerMillion {
    const providerPricing = this._maxPricing.providers?.[provider];

    if (service) {
      const serviceOverride = providerPricing?.services?.[service];
      if (serviceOverride && this._isValidBuyerMaxPrice(serviceOverride)) {
        return serviceOverride;
      }
    }

    const providerDefaults = providerPricing?.defaults;
    if (providerDefaults && this._isValidBuyerMaxPrice(providerDefaults)) {
      return providerDefaults;
    }

    return this._maxPricing.defaults;
  }

  private _isFiniteNonNegative(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  private _isValidOffer(offer: TokenPricingUsdPerMillion): boolean {
    return (
      this._isValidBuyerMaxPrice(offer) &&
      (
        offer.cachedInputUsdPerMillion === undefined ||
        offer.cachedInputUsdPerMillion <= offer.inputUsdPerMillion
      )
    );
  }

  private _isValidBuyerMaxPrice(pricing: TokenPricingUsdPerMillion): boolean {
    return (
      this._isFiniteNonNegative(pricing.inputUsdPerMillion) &&
      this._isFiniteNonNegative(pricing.outputUsdPerMillion) &&
      (
        pricing.cachedInputUsdPerMillion === undefined ||
        this._isFiniteNonNegative(pricing.cachedInputUsdPerMillion)
      )
    );
  }

  private _offerExceedsMaxPrice(offer: TokenPricingUsdPerMillion, max: TokenPricingUsdPerMillion): boolean {
    const maxCachedInput = max.cachedInputUsdPerMillion ?? max.inputUsdPerMillion;
    return offer.inputUsdPerMillion > max.inputUsdPerMillion
      || offer.outputUsdPerMillion > max.outputUsdPerMillion
      || (offer.cachedInputUsdPerMillion != null && offer.cachedInputUsdPerMillion > maxCachedInput);
  }
}

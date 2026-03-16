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

export class LocalRouter implements Router {
  private readonly _minReputation: number;
  private readonly _maxPricing: BuyerMaxPricingConfig;
  private readonly _maxFailures: number;
  private readonly _maxPeerStalenessMs: number;
  private readonly _now: () => number;
  private readonly _weights: Partial<ScoringWeights> | undefined;
  private readonly _metrics: PeerMetricsTracker;

  constructor(config?: LocalRouterConfig) {
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
    const requestedService = this._extractRequestedService(req);

    const candidates: {
      peer: PeerInfo;
      provider: string;
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

      // Service availability filter
      const service = this._selectServiceForPeer(peer, requestedService);
      if (!service) {
        continue;
      }

      // Pricing filter
      const offer = this._resolvePeerOfferPrice(peer, requestedService);
      if (!offer) {
        continue;
      }

      const max = this._resolveBuyerMaxPrice(requestedService);
      if (offer.inputUsdPerMillion > max.inputUsdPerMillion || offer.outputUsdPerMillion > max.outputUsdPerMillion) {
        continue;
      }

      candidates.push({ peer, provider: service, offer });
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

  private _selectServiceForPeer(peer: PeerInfo, requestedService: string | null): string | null {
    const validServices = peer.services.filter((s) => s.name.trim().length > 0);
    if (validServices.length === 0) return null;

    if (requestedService) {
      const match = validServices.find((s) => s.name === requestedService);
      if (match) return match.name;
    }

    return validServices[0]?.name ?? null;
  }

  private _resolvePeerOfferPrice(
    peer: PeerInfo,
    service: string | null,
  ): TokenPricingUsdPerMillion | null {
    if (service) {
      const match = peer.services.find((s) => s.name === service);
      if (match && this._isValidOffer(match.pricing)) {
        return match.pricing;
      }
    }

    // Fall back to first service pricing
    const first = peer.services[0];
    if (first && this._isValidOffer(first.pricing)) {
      return first.pricing;
    }

    return null;
  }

  private _resolveBuyerMaxPrice(service: string | null): TokenPricingUsdPerMillion {
    if (service) {
      // Check provider-keyed config for backward compat
      if (this._maxPricing.providers) {
        for (const providerPricing of Object.values(this._maxPricing.providers)) {
          const serviceOverride = providerPricing.services?.[service];
          if (serviceOverride && this._isValidOffer(serviceOverride)) {
            return serviceOverride;
          }
        }
      }
    }

    // Check provider defaults
    if (this._maxPricing.providers) {
      for (const providerPricing of Object.values(this._maxPricing.providers)) {
        const providerDefaults = providerPricing.defaults;
        if (providerDefaults && this._isValidOffer(providerDefaults)) {
          return providerDefaults;
        }
      }
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

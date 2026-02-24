import type { Router, PeerInfo, SerializedHttpRequest } from '@antseed/node';
import {
  scoreCandidates,
  PeerMetricsTracker,
  type TokenPricingUsdPerMillion,
  type ScoringWeights,
} from '@antseed/router-core';

/** Latency-prioritized weights for desktop chat. */
const CHAT_WEIGHTS: ScoringWeights = {
  price: 0.15,
  latency: 0.35,
  capacity: 0.20,
  reputation: 0.15,
  freshness: 0.10,
  reliability: 0.05,
};

export interface LocalChatRouterConfig {
  minReputation?: number;
  maxFailures?: number;
  failureCooldownMs?: number;
  maxPeerStalenessMs?: number;
  now?: () => number;
}

export class LocalChatRouter implements Router {
  private readonly _minReputation: number;
  private readonly _maxFailures: number;
  private readonly _maxPeerStalenessMs: number;
  private readonly _now: () => number;
  private readonly _metrics: PeerMetricsTracker;

  constructor(config?: LocalChatRouterConfig) {
    this._minReputation = config?.minReputation ?? 50;
    this._maxFailures = Math.max(1, config?.maxFailures ?? 3);
    this._maxPeerStalenessMs = Math.max(1, config?.maxPeerStalenessMs ?? 300_000);
    this._now = config?.now ?? (() => Date.now());
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
      const reputation = this._effectiveReputation(peer);
      if (reputation < this._minReputation) {
        continue;
      }

      // Cooldown filter
      if (this._metrics.isCoolingDown(peer.peerId)) {
        continue;
      }

      // Use first available provider (no preference list for chat)
      const provider = peer.providers[0];
      if (!provider) {
        continue;
      }

      const offer = this._resolvePeerOfferPrice(peer, provider, requestedModel);
      if (!offer) {
        continue;
      }

      candidates.push({
        peer,
        provider,
        providerRank: Number.MAX_SAFE_INTEGER,
        offer,
      });
    }

    if (candidates.length === 0) return null;

    if (candidates.length === 1) {
      return candidates[0]!.peer;
    }

    // Delegate scoring to router-core with latency-prioritized weights
    const scoringInput = candidates.map((c) => ({
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
      weights: CHAT_WEIGHTS,
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

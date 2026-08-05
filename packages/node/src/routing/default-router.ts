import type { Router } from '../interfaces/buyer-router.js';
import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest } from '../types/http.js';
import { computeOnChainReputationScore } from '../reputation/on-chain-reputation.js';
import {
  peerHasActiveSubstitutionFlag,
  peerHasModelVerificationWarning,
} from './verification-score.js';
import { extractServiceFromBody } from '../utils/json-codec.js';

export interface DefaultRouterConfig {
  minReputation?: number;  // Default: 0 (no reputation gate)
}

export class DefaultRouter implements Router {
  private _minReputation: number;
  private _latencyMap = new Map<string, number>();

  constructor(config?: DefaultRouterConfig) {
    this._minReputation = config?.minReputation ?? 0;
  }

  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    const nowMs = Date.now();
    const requestedService = extractServiceFromBody(req.body)?.trim().toLowerCase() || null;
    const eligible = peers.filter((p) =>
      this._effectiveReputation(p) >= this._minReputation
      && !peerHasActiveSubstitutionFlag(p, requestedService, nowMs),
    );
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      const warningA = peerHasModelVerificationWarning(a, requestedService, nowMs) ? 1 : 0;
      const warningB = peerHasModelVerificationWarning(b, requestedService, nowMs) ? 1 : 0;
      if (warningA !== warningB) return warningA - warningB;
      const priceA = a.defaultInputUsdPerMillion ?? Infinity;
      const priceB = b.defaultInputUsdPerMillion ?? Infinity;
      if (priceA !== priceB) return priceA - priceB;
      // Prefer higher reputation scores (descending)
      const reputationA = this._effectiveReputation(a);
      const reputationB = this._effectiveReputation(b);
      if (reputationA !== reputationB) return reputationB - reputationA;
      const latA = this._latencyMap.get(a.peerId) ?? Infinity;
      const latB = this._latencyMap.get(b.peerId) ?? Infinity;
      return latA - latB;
    });

    return eligible[0] ?? null;
  }

  onResult(peer: PeerInfo, result: { success: boolean; latencyMs: number; tokens: number }): void {
    if (result.success) {
      const prev = this._latencyMap.get(peer.peerId) ?? result.latencyMs;
      this._latencyMap.set(peer.peerId, prev * 0.7 + result.latencyMs * 0.3);
    }
  }

  private _effectiveReputation(peer: PeerInfo): number {
    const onChainScore = computeOnChainReputationScore(peer);
    if (onChainScore != null) {
      return onChainScore;
    }
    if (this._isFiniteNonNegative(peer.reputationScore)) {
      return peer.reputationScore;
    }
    return 0;
  }

  private _isFiniteNonNegative(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }
}

import type { Router } from '../interfaces/buyer-router.js';
import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest } from '../types/http.js';

export interface DefaultRouterConfig {
  minReputation?: number;  // Default: 50
}

export class DefaultRouter implements Router {
  private _minReputation: number;
  private _latencyMap = new Map<string, number>();

  constructor(config?: DefaultRouterConfig) {
    this._minReputation = config?.minReputation ?? 50;
  }

  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    const eligible = peers.filter(
      (p) => !this._hasReputation(p) || this._effectiveReputation(p) >= this._minReputation
    );
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      const priceA = a.defaultInputUsdPerMillion ?? Infinity;
      const priceB = b.defaultInputUsdPerMillion ?? Infinity;
      if (priceA !== priceB) return priceA - priceB;
      // Prefer higher trust scores (descending)
      const trustA = this._effectiveReputation(a);
      const trustB = this._effectiveReputation(b);
      if (trustA !== trustB) return trustB - trustA;
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
    if (this._isFiniteNonNegative(peer.onChainChannelCount)) {
      return peer.onChainChannelCount;
    }
    if (this._isFiniteNonNegative(peer.trustScore)) {
      return peer.trustScore;
    }
    if (this._isFiniteNonNegative(peer.reputationScore)) {
      return peer.reputationScore;
    }
    return 0;
  }

  private _hasReputation(peer: PeerInfo): boolean {
    if (this._isFiniteNonNegative(peer.onChainChannelCount)) {
      return (peer.onChainChannelCount ?? 0) > 0 || (peer.onChainGhostCount ?? 0) > 0;
    }

    return this._isFiniteNonNegative(peer.trustScore) || this._isFiniteNonNegative(peer.reputationScore);
  }

  private _isFiniteNonNegative(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }
}

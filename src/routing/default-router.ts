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
      (p) => (p.trustScore ?? p.reputationScore ?? 0) >= this._minReputation
    );
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      const priceA = a.defaultInputUsdPerMillion ?? Infinity;
      const priceB = b.defaultInputUsdPerMillion ?? Infinity;
      if (priceA !== priceB) return priceA - priceB;
      // Prefer higher trust scores (descending)
      const trustA = a.trustScore ?? a.reputationScore ?? 0;
      const trustB = b.trustScore ?? b.reputationScore ?? 0;
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
}

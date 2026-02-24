import type { Router } from '@antseed/node';
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node/types';

/**
 * LowestLatencyRouter — selects the peer with the lowest observed latency.
 *
 * Use this as a starting point. Replace selectPeer() with your own logic
 * to consider price, reputation, capacity, or any custom criteria.
 */
export class LowestLatencyRouter implements Router {
  private _latencyMap = new Map<string, number>();

  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    if (peers.length === 0) return null;

    // Sort by observed latency (unknown peers go last)
    const sorted = [...peers].sort((a, b) => {
      const latA = this._latencyMap.get(a.peerId) ?? Infinity;
      const latB = this._latencyMap.get(b.peerId) ?? Infinity;
      return latA - latB;
    });

    return sorted[0] ?? null;
  }

  onResult(peer: PeerInfo, result: { success: boolean; latencyMs: number; tokens: number }): void {
    if (result.success) {
      // Exponential moving average (weight recent results more)
      const prev = this._latencyMap.get(peer.peerId) ?? result.latencyMs;
      this._latencyMap.set(peer.peerId, prev * 0.7 + result.latencyMs * 0.3);
    }
  }
}

import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest } from '../types/http.js';

export type RouteCandidate = {
  inference?: import('@antseed/protocol').RoutingInference;
  reasoningEfforts?: import('@antseed/protocol').ReasoningEffort[];
  peer: PeerInfo;
  peerId: string;
  serviceId: string;
  request: SerializedHttpRequest;
  reputation: number;
  hasCachedInputPricing: boolean;
  inputUsdPerMillion: number | null;
  cachedInputUsdPerMillion?: number | null;
  outputUsdPerMillion: number | null;
  minImageUsdPerImage: number | null;
};

export type RouteRecommendation = import('@antseed/protocol').RoutingRecommendation;

/**
 * Interface that buyer nodes implement for peer selection.
 *
 * The SDK discovers available sellers via DHT. Your router decides
 * which seller to send each request to based on price, latency,
 * reputation, capacity, or any custom logic.
 *
 * If you don't provide a router, the SDK uses a default that selects
 * the cheapest peer with reputation above a minimum threshold.
 */
export interface Router {
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null;
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
    freshInputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number | null;
    requestId?: string;
  }): void;
}

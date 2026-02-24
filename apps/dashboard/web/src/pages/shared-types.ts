/**
 * Shared data types for the dashboard frontend.
 * These mirror the server-side types used in API responses.
 */

/** Information about a connected peer */
export interface PeerInfo {
  peerId: string;
  providers: string[];
  capacityMsgPerHour: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  reputation: number;
  location: string | null;
  source?: 'daemon' | 'dht';
}

/** Aggregated metrics for a single session */
export interface SessionMetrics {
  sessionId: string;
  provider: string;
  totalTokens: number;
  totalRequests: number;
  durationMs: number;
  avgLatencyMs: number;
  peerSwitches: number;
}

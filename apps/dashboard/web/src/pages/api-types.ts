/**
 * Shared API response types for the dashboard frontend.
 * These mirror the server-side types in src/dashboard/api/routes.ts.
 */

/** Response type for GET /api/status */
export interface StatusResponse {
  state: string;
  peerCount: number;
  earningsToday: string;
  tokensToday: number;
  activeSessions: number;
  uptime: string;
  walletAddress: string | null;
  proxyPort: number | null;
  capacityUsedPercent: number;
  daemonPid: number | null;
  daemonAlive: boolean;
}

/** Response type for GET /api/peers */
export interface PeersResponse {
  peers: import('./shared-types').PeerInfo[];
  total: number;
}

/** Response type for GET /api/sessions */
export interface SessionsResponse {
  sessions: import('./shared-types').SessionMetrics[];
  total: number;
}

/** Response type for GET /api/earnings */
export interface EarningsResponse {
  today?: string;
  thisWeek?: string;
  thisMonth?: string;
  daily?: Array<{ date: string; amount: string }>;
  byProvider?: Array<{ provider: string; amount: string }>;
}

/** A peer discovered via the DHT network */
export interface NetworkPeer {
  peerId: string;
  host: string;
  port: number;
  providers: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  lastSeen: number;
  source: 'daemon' | 'dht';
}

/** Network stats from the DHT query service */
export interface NetworkStats {
  totalPeers: number;
  dhtNodeCount: number;
  dhtHealthy: boolean;
  lastScanAt: number | null;
}

/** Response type for GET /api/network */
export interface NetworkResponse {
  peers: NetworkPeer[];
  stats: NetworkStats;
}

/** Response type for GET /api/config */
export interface ConfigResponse {
  config: {
    identity: {
      displayName: string;
      walletAddress?: string;
    };
    providers: Array<{
      type: string;
      endpoint: string;
      authHeaderName: string;
    }>;
    seller: {
      reserveFloor: number;
      maxConcurrentBuyers: number;
      enabledProviders: string[];
      pricing: {
        defaults: {
          inputUsdPerMillion: number;
          outputUsdPerMillion: number;
        };
        providers?: Record<string, {
          defaults?: {
            inputUsdPerMillion: number;
            outputUsdPerMillion: number;
          };
          services?: Record<string, {
            inputUsdPerMillion: number;
            outputUsdPerMillion: number;
          }>;
        }>;
      };
    };
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: number;
          outputUsdPerMillion: number;
        };
        providers?: Record<string, {
          defaults?: {
            inputUsdPerMillion: number;
            outputUsdPerMillion: number;
          };
          services?: Record<string, {
            inputUsdPerMillion: number;
            outputUsdPerMillion: number;
          }>;
        }>;
      };
      minPeerReputation: number;
      proxyPort: number;
    };
    payments: {
      preferredMethod: 'crypto';
      platformFeeRate: number;
      crypto?: {
        chainId: 'base' | 'arbitrum';
        rpcUrl: string;
        depositsContractAddress: string;
        usdcContractAddress: string;
      };
    };
  };
}

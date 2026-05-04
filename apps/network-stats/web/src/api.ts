export interface OnChainStats {
  agentId: number;
  totalRequests: string;
  totalInputTokens: string;
  totalOutputTokens: string;
  settlementCount: number;
  uniqueBuyers: number;
  uniqueChannels: number;
  firstSettledBlock: number | null;
  lastSettledBlock: number | null;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  avgRequestsPerChannel: number | null;
  avgRequestsPerBuyer: number | null;
  lastUpdatedAt: number | null;
}

export interface ProviderAnnouncement {
  provider?: string;
  providerId?: string;
  services?: string[];
  [key: string]: unknown;
}

export interface Peer {
  peerId: string;
  version?: number;
  displayName?: string;
  publicAddress?: string;
  sellerContract?: string;
  region?: string;
  services?: string[];
  endpoints?: string[];
  providers?: ProviderAnnouncement[];
  offerings?: unknown[];
  timestamp?: number;
  resolvedAtMs?: number;
  serverDateMs?: number;
  stakeAmountUSDC?: number;
  trustScore?: number;
  onChainChannelCount?: number;
  onChainGhostCount?: number;
  onChainStats?: OnChainStats | null;
  [key: string]: unknown;
}

export interface NetworkTotals {
  totalRequests: string;
  totalInputTokens: string;
  totalOutputTokens: string;
  settlementCount: number;
  sellerCount: number;
  lastUpdatedAt: number | null;
}

export interface IndexerInfo {
  chainId: string;
  contractAddress: string;
  lastBlock: number;
  lastUpdatedAt: number;
  latestBlock?: number;
  synced?: boolean;
  reorgSafetyBlocks?: number;
  lastSuccessAt?: number | null;
  lastErrorAt?: number | null;
  lastErrorMessage?: string | null;
}

export interface NetworkAggregates {
  peerCount: number;
  serviceCounts: Record<string, number>;
  serviceCategoryCounts: Record<string, number>;
  stake: {
    totalUsdc: number;
    medianUsdc: number;
    p95Usdc: number;
    peersWithStake: number;
  } | null;
  freshness: {
    medianAgeSeconds: number;
    p95AgeSeconds: number;
    oldestAgeSeconds: number;
    newestAgeSeconds: number;
  } | null;
  peersWithSellerContract: number;
  peersWithDisplayName: number;
}

export interface StatsResponse {
  peers: Peer[];
  updatedAt: string;
  network?: NetworkAggregates;
  totals?: NetworkTotals;
  indexer?: IndexerInfo;
}

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch('/stats');
  if (!res.ok) throw new Error(`GET /stats → ${res.status}`);
  return res.json();
}

export function getPeerServices(peer: Peer): string[] {
  const services = new Set<string>();

  for (const service of peer.services ?? []) {
    services.add(service);
  }

  for (const provider of peer.providers ?? []) {
    for (const service of provider.services ?? []) {
      services.add(service);
    }
  }

  return [...services];
}

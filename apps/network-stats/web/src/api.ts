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

export interface Peer {
  peerId: string;
  services?: string[];
  endpoints?: string[];
  timestamp?: number;
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
}

export interface StatsResponse {
  peers: Peer[];
  updatedAt: string;
  totals?: NetworkTotals;
  indexer?: IndexerInfo;
}

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch('/stats');
  if (!res.ok) throw new Error(`GET /stats → ${res.status}`);
  return res.json();
}

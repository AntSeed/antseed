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
  lastBlockTimestamp: number | null;
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

export interface BackfillStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number | null;
  finishedAt: number | null;
  scannedBlocks: number;
  totalBlocks: number;
  events: number;
  rowsWritten: number;
  phase: 'scanning' | 'resolving-timestamps' | 'done' | null;
  errorMessage: string | null;
}

export interface StatsResponse {
  peers: Peer[];
  updatedAt: string;
  network?: NetworkAggregates;
  totals?: NetworkTotals;
  indexer?: IndexerInfo;
  backfill?: BackfillStatus;
}

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch('/stats');
  if (!res.ok) throw new Error(`GET /stats → ${res.status}`);
  return res.json();
}

export type HistoryRange = '1d' | '7d' | '30d';

export interface HistoryPoint {
  ts: number;                  // unix seconds (start of bucket)
  activePeers: number | null;  // null for buckets reconstructed from chain history (DHT data unknown)
  requests: number;
  settlements: number;
  tokens: number;              // input + output tokens served within the bucket
}

export interface HistoryResponse {
  range: HistoryRange;
  bucketSeconds: number;
  points: HistoryPoint[];
}

export async function fetchHistory(range: HistoryRange): Promise<HistoryResponse> {
  const res = await fetch(`/history?range=${range}`);
  if (!res.ok) throw new Error(`GET /history → ${res.status}`);
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

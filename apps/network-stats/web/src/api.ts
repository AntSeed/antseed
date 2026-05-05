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

export interface NetworkMetrics {
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
  network?: NetworkMetrics;
  totals?: NetworkTotals;
  indexer?: IndexerInfo;
  backfill?: BackfillStatus;
}

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch('/stats');
  if (!res.ok) throw new Error(`GET /stats → ${res.status}`);
  return res.json();
}

export interface StatsNetworkResponse {
  updatedAt: string;
  network: NetworkMetrics;
  totals?: NetworkTotals;
  indexer?: IndexerInfo;
  backfill?: BackfillStatus;
}

export interface StatsPeersResponse {
  updatedAt: string;
  peers: Peer[];
}

export async function fetchStatsNetwork(): Promise<StatsNetworkResponse> {
  const res = await fetch('/stats/network');
  if (!res.ok) throw new Error(`GET /stats/network → ${res.status}`);
  return res.json();
}

export async function fetchStatsPeers(): Promise<StatsPeersResponse> {
  const res = await fetch('/stats/peers');
  if (!res.ok) throw new Error(`GET /stats/peers → ${res.status}`);
  return res.json();
}

export type HistoryRange = '1d' | '7d' | '30d';

export interface PeersHistoryPoint {
  ts: number;                  // unix seconds (start of bucket)
  activePeers: number | null;  // null for buckets reconstructed from chain history (DHT data unknown)
  requests: number;
  settlements: number;
}

export interface TokensHistoryPoint {
  ts: number;                  // unix seconds (start of bucket)
  tokens: number;              // input + output tokens served within the bucket
}

export interface HistorySeries<P> {
  range: HistoryRange;
  bucketSeconds: number;
  points: P[];
}

export type PeersHistoryResponse = HistorySeries<PeersHistoryPoint>;
export type TokensHistoryResponse = HistorySeries<TokensHistoryPoint>;

export async function fetchPeersHistory(range: HistoryRange): Promise<PeersHistoryResponse> {
  const res = await fetch(`/history/peers?range=${range}`);
  if (!res.ok) throw new Error(`GET /history/peers → ${res.status}`);
  return res.json();
}

export async function fetchTokensHistory(range: HistoryRange): Promise<TokensHistoryResponse> {
  const res = await fetch(`/history/tokens?range=${range}`);
  if (!res.ok) throw new Error(`GET /history/tokens → ${res.status}`);
  return res.json();
}

export interface NumericDistribution {
  count: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
}

export interface LeaderboardEntry {
  agentId: number | null;
  peerId: string | null;
  displayName: string | null;
  region: string | null;
  metric: string;
  secondary?: number | null;
}

export interface Leaderboards {
  mostActive: LeaderboardEntry[];
  mostSettlements: LeaderboardEntry[];
  mostBuyers: LeaderboardEntry[];
  mostStaked: LeaderboardEntry[];
  mostDiverse: LeaderboardEntry[];
  newest: LeaderboardEntry[];
  oldest: LeaderboardEntry[];
  /**
   * Sellers whose 24h request count exceeds their prior 7d daily average by
   * the largest factor. `metric` is either a 4-decimal ratio (e.g. "3.2500")
   * or the sentinel "new" for sellers with no prior-window activity.
   */
  trendingUp: LeaderboardEntry[];
  /** Inverse of trendingUp — sellers whose recent activity is collapsing. */
  trendingDown: LeaderboardEntry[];
}

export interface ServicePricingMarket {
  peerCount: number;
  input: NumericDistribution;
  output: NumericDistribution;
  cheapestPeerId: string | null;
  cheapestInputUsdPerMillion: number | null;
  cheapestOutputUsdPerMillion: number | null;
}

export interface ServiceRanking {
  key: string;
  peers: number;
}

export interface RegionDistributionEntry {
  region: string;
  peers: number;
}

export interface ConcentrationStats {
  sellerCount: number;
  gini: number | null;
  herfindahl: number | null;
  top10Share: number | null;
}

export interface VelocityWindow {
  windowSeconds: number;
  requestsDelta: string;
  tokensDelta: string;
  settlementsDelta: number;
  /**
   * Period-over-period growth fraction (e.g. 0.5 = +50%). null when there is
   * no prior window to compare against. Sentinel value -1 means "infinite
   * growth" (prior window had zero activity but the current window has >0) —
   * the UI should render this as "new" rather than "-100%".
   */
  requestsGrowthPct: number | null;
}

export interface Velocity {
  last24h: VelocityWindow | null;
  last7d: VelocityWindow | null;
}

export interface Activity {
  peersOnline: number;
  sellersActiveLast24h: number;
  totalSellersIndexed: number;
}

export interface PriceStabilityEntry {
  peerId: string;
  displayName: string | null;
  provider: string;
  service: string;
  changeCount: number;
  sampleCount: number;
  observedDays: number;
  latestInputUsdPerMillion: number;
  latestOutputUsdPerMillion: number;
}

export interface PriceMoverEntry {
  peerId: string;
  displayName: string | null;
  provider: string;
  service: string;
  inputChangePct: number;
  fromInputUsdPerMillion: number;
  toInputUsdPerMillion: number;
  fromOutputUsdPerMillion: number;
  toOutputUsdPerMillion: number;
  windowSeconds: number;
}

export interface PriceStability {
  mostStable: PriceStabilityEntry[];
  mostVolatile: PriceStabilityEntry[];
}

export interface PriceMovers {
  biggestDrops: PriceMoverEntry[];
  biggestHikes: PriceMoverEntry[];
}

export interface ServiceRankings {
  topServices: ServiceRanking[];
  topCategories: ServiceRanking[];
  topProtocols: ServiceRanking[];
  topProviders: ServiceRanking[];
}

export interface InsightsResponse {
  generatedAt: string;
  leaderboards: Leaderboards;
  pricing: { byService: Record<string, ServicePricingMarket> };
  services: ServiceRankings;
  regions: RegionDistributionEntry[];
  concentration: ConcentrationStats;
  velocity: Velocity;
  activity: Activity;
  priceStability: PriceStability;
  priceMovers: PriceMovers;
}

export async function fetchInsights(): Promise<InsightsResponse> {
  const res = await fetch('/insights');
  if (!res.ok) throw new Error(`GET /insights → ${res.status}`);
  return res.json();
}

export interface InsightsLeaderboardsResponse {
  generatedAt: string;
  leaderboards: Leaderboards;
}

export interface InsightsPricingResponse {
  generatedAt: string;
  pricing: { byService: Record<string, ServicePricingMarket> };
  priceStability: PriceStability;
  priceMovers: PriceMovers;
}

export interface InsightsServicesResponse {
  generatedAt: string;
  services: ServiceRankings;
  regions: RegionDistributionEntry[];
  concentration: ConcentrationStats;
}

export interface InsightsActivityResponse {
  generatedAt: string;
  velocity: Velocity;
  activity: Activity;
}

export async function fetchInsightsLeaderboards(): Promise<InsightsLeaderboardsResponse> {
  const res = await fetch('/insights/leaderboards');
  if (!res.ok) throw new Error(`GET /insights/leaderboards → ${res.status}`);
  return res.json();
}

export async function fetchInsightsPricing(): Promise<InsightsPricingResponse> {
  const res = await fetch('/insights/pricing');
  if (!res.ok) throw new Error(`GET /insights/pricing → ${res.status}`);
  return res.json();
}

export async function fetchInsightsServices(): Promise<InsightsServicesResponse> {
  const res = await fetch('/insights/services');
  if (!res.ok) throw new Error(`GET /insights/services → ${res.status}`);
  return res.json();
}

export async function fetchInsightsActivity(): Promise<InsightsActivityResponse> {
  const res = await fetch('/insights/activity');
  if (!res.ok) throw new Error(`GET /insights/activity → ${res.status}`);
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

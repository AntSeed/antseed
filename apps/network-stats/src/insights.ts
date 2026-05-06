/**
 * Network insights — pure derivations on top of the snapshot + the indexed
 * on-chain totals. Lives separately from `metrics.ts` because:
 *
 *   - metrics.ts:    cheap, recomputed every /stats request; only DHT-side data
 *   - insights.ts:   richer (leaderboards, pricing market, concentration);
 *                    needs both the live peer snapshot and the seller totals
 *                    enumeration from the SQLite store
 *
 * The whole module is pure — the server file does the I/O, then hands the
 * resulting arrays/maps in. That keeps unit tests fixture-driven and avoids
 * pulling node:fs / better-sqlite3 into hot derivations.
 */

import type { PeerMetadata } from '@antseed/node';
import type {
  HistorySample,
  PriceVolatilityRow,
  SellerActivityRow,
  SellerTotalsWithId,
} from './store.js';
import {
  bigintDesc,
  bump,
  collectPeerSets,
  distribution,
  getPeerLookupAddress,
  gini,
  herfindahl,
  lastAtOrBefore,
  topShare,
  type NumericDistribution,
} from './utils.js';

const LEADERBOARD_LIMIT = 10;
const PRICE_MARKET_MIN_PEERS = 1;
const ACTIVE_RECENT_SECONDS = 24 * 3600;
const PRICE_STABILITY_WINDOW_SECONDS = 30 * 86400;
/** Below this absolute % change in input price we don't classify as "moved". */
const PRICE_MOVER_MIN_PCT = 0.01;
/** A seller needs at least this many requests in the trending window to qualify, to keep noise out. */
const TRENDING_MIN_REQUESTS_24H = 5;

export interface LeaderboardEntry {
  agentId: number | null;       // null when the entry is DHT-only (e.g. mostStaked, mostDiverse)
  peerId: string | null;        // 40 hex chars (no 0x), or null when seller is offline
  displayName: string | null;
  region: string | null;
  /** Primary metric this row was ranked by, stringified to keep BigInts JSON-safe. */
  metric: string;
  /** Optional secondary number to display alongside `metric` (e.g. settlement count for the requests board). */
  secondary?: number | null;
}

export interface Leaderboards {
  mostActive: LeaderboardEntry[];        // by totalRequests
  mostSettlements: LeaderboardEntry[];   // by settlementCount
  mostBuyers: LeaderboardEntry[];        // by uniqueBuyers
  mostStaked: LeaderboardEntry[];        // by stakeAmountUSDC (DHT-only)
  mostDiverse: LeaderboardEntry[];       // by service+category breadth (DHT-only)
  newest: LeaderboardEntry[];            // by firstSeenAt DESC
  oldest: LeaderboardEntry[];            // by firstSeenAt ASC
  /**
   * Sellers whose 24h request count exceeds their prior 7d daily average by
   * the largest factor. `metric` is the trend ratio formatted to 4 decimals
   * (e.g. "3.2500" = 3.25× the baseline). `secondary` carries the raw 24h
   * delta so the UI can show both "3.25×" and "+150 reqs in 24h".
   */
  trendingUp: LeaderboardEntry[];
  /** Inverse of trendingUp — sellers whose recent activity is collapsing relative to their baseline. */
  trendingDown: LeaderboardEntry[];
}

export interface ServicePricingMarket {
  /** Number of online peers offering this service. */
  peerCount: number;
  /** Distribution of input USD/M across peers offering the service. */
  input: NumericDistribution;
  /** Distribution of output USD/M across peers offering the service. */
  output: NumericDistribution;
  /** Cheapest peer for this service, ranked on input price (tie-broken by output). */
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
  /** Number of indexed sellers that contributed to the calculation (request count > 0). */
  sellerCount: number;
  /** Lorenz-curve Gini coefficient on totalRequests; 0 = even, 1 = monopoly. Null when sellerCount < 2. */
  gini: number | null;
  /** Herfindahl-Hirschman Index on request share. Null when total requests is 0. */
  herfindahl: number | null;
  /** Share of total requests captured by the top-10 sellers (0 .. 1). Null when total is 0. */
  top10Share: number | null;
}

export interface VelocityWindow {
  /** Window length in seconds requested by the caller (e.g. 86400). */
  windowSeconds: number;
  /** Cumulative-counter deltas inside the window, stringified to keep BigInts JSON-safe. */
  requestsDelta: string;
  tokensDelta: string;
  settlementsDelta: number;
  /**
   * Period-over-period growth: requestsDelta over this window divided by the
   * matching delta in the immediately preceding window of the same length.
   * Null when the prior window is empty (cold-start) or we have <2 windows of
   * history; -1 when the prior window had zero requests but the current
   * window had >0 (infinite growth, normalized to a sentinel the UI can
   * special-case).
   */
  requestsGrowthPct: number | null;
}

export interface Velocity {
  last24h: VelocityWindow | null;
  last7d: VelocityWindow | null;
}

export interface Activity {
  /** Live count from the latest poll. */
  peersOnline: number;
  /** Sellers with on-chain activity (last_seen_at) within ACTIVE_RECENT_SECONDS. */
  sellersActiveLast24h: number;
  /** Indexed sellers ever seen on-chain. */
  totalSellersIndexed: number;
}

export interface PriceStabilityEntry {
  peerId: string;
  displayName: string | null;
  provider: string;
  service: string;
  /** Distinct (input, output) tuples observed in the window — 1 = announced once / never moved. */
  changeCount: number;
  /** Total samples in the window — useful as confidence signal. */
  sampleCount: number;
  /** Days the peer has been in the window (lastTs − firstTs)/86400, rounded. */
  observedDays: number;
  latestInputUsdPerMillion: number;
  latestOutputUsdPerMillion: number;
}

export interface PriceMoverEntry {
  peerId: string;
  displayName: string | null;
  provider: string;
  service: string;
  /** Signed % change of input price between window start and the latest sample. */
  inputChangePct: number;
  fromInputUsdPerMillion: number;
  toInputUsdPerMillion: number;
  fromOutputUsdPerMillion: number;
  toOutputUsdPerMillion: number;
  /** Window length in seconds the change is measured over. */
  windowSeconds: number;
}

export interface PriceStability {
  /** Peers/services with the fewest price changes in the window — sorted asc by changeCount. */
  mostStable: PriceStabilityEntry[];
  /** Peers/services with the most price changes — sorted desc by changeCount. */
  mostVolatile: PriceStabilityEntry[];
}

export interface PriceMovers {
  /** Largest input-price drops vs the start of the stability window. */
  biggestDrops: PriceMoverEntry[];
  /** Largest input-price hikes vs the start of the stability window. */
  biggestHikes: PriceMoverEntry[];
}

export interface NetworkInsights {
  generatedAt: string;
  leaderboards: Leaderboards;
  pricing: { byService: Record<string, ServicePricingMarket> };
  services: {
    topServices: ServiceRanking[];
    topCategories: ServiceRanking[];
    topProtocols: ServiceRanking[];
    topProviders: ServiceRanking[];
  };
  regions: RegionDistributionEntry[];
  concentration: ConcentrationStats;
  velocity: Velocity;
  activity: Activity;
  priceStability: PriceStability;
  priceMovers: PriceMovers;
}

export interface ComputeInsightsInput {
  peers: readonly PeerMetadata[];
  sellerTotals: readonly SellerTotalsWithId[];
  /**
   * Maps each seller's lookup address (sellerContract or peerAddress) to
   * agentId, mirroring what the /stats handler already builds. Used to turn
   * a leaderboard row keyed by agentId back into the live PeerMetadata when
   * available — a peer can be ranked even if it's currently offline (no
   * matching DHT entry), in which case displayName/region come back null.
   */
  agentIdByPeerAddress: ReadonlyMap<string, number | null>;
  /** Recent network_history rows sorted ascending by ts. Drives velocity. */
  history: readonly HistorySample[];
  /**
   * Per-(peer, service) pricing volatility rollup over the last
   * PRICE_STABILITY_WINDOW_SECONDS. Empty/omitted is fine — both
   * priceStability and priceMovers degrade to empty arrays.
   */
  priceVolatility?: readonly PriceVolatilityRow[];
  /**
   * Per-seller activity snapshots (cumulative totals at fixed timestamps)
   * sorted ascending by (agentId, ts). Drives trendingUp/trendingDown.
   * Empty/omitted means trending sections come back empty.
   */
  sellerActivity?: readonly SellerActivityRow[];
  /** Override for tests; defaults to wall-clock now. */
  nowMs?: number;
}

// ── leaderboard plumbing ───────────────────────────────────────────────────

function peerByAgentId(
  peers: readonly PeerMetadata[],
  agentIdByPeerAddress: ReadonlyMap<string, number | null>,
): Map<number, PeerMetadata> {
  const out = new Map<number, PeerMetadata>();
  for (const peer of peers) {
    const addr = getPeerLookupAddress(peer);
    if (!addr) continue;
    const agentId = agentIdByPeerAddress.get(addr) ?? null;
    // First-write-wins: if two peers share an agentId (shouldn't happen, but
    // possible during in-flight key rotation), surface whichever was discovered
    // first instead of silently overwriting.
    if (agentId !== null && agentId !== 0 && !out.has(agentId)) out.set(agentId, peer);
  }
  return out;
}

function entryForSeller(
  seller: SellerTotalsWithId,
  peer: PeerMetadata | undefined,
  metric: string | bigint | number,
  secondary: number | null = null,
): LeaderboardEntry {
  return {
    agentId: seller.agentId,
    peerId: peer?.peerId ?? null,
    displayName: peer?.displayName ?? null,
    region: peer?.region ?? null,
    metric: typeof metric === 'string' ? metric : metric.toString(),
    secondary,
  };
}

function entryForPeer(
  peer: PeerMetadata,
  metric: string | bigint | number,
  secondary: number | null = null,
): LeaderboardEntry {
  return {
    agentId: null,
    peerId: peer.peerId,
    displayName: peer.displayName ?? null,
    region: peer.region ?? null,
    metric: typeof metric === 'string' ? metric : metric.toString(),
    secondary,
  };
}

/**
 * Sort `items` by `compare`, take the first LEADERBOARD_LIMIT, project each
 * to a result entry. The ubiquitous `[...arr].filter().sort().slice().map()`
 * idiom in this file collapses into one call.
 */
function topByDesc<T, R>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  compare: (a: T, b: T) => number,
  toEntry: (item: T) => R,
): R[] {
  return items.filter(predicate).sort(compare).slice(0, LEADERBOARD_LIMIT).map(toEntry);
}

// ── leaderboards ───────────────────────────────────────────────────────────

function computeLeaderboards(
  input: ComputeInsightsInput,
  peerByAgent: ReadonlyMap<number, PeerMetadata>,
): Leaderboards {
  const { peers, sellerTotals } = input;
  const peerOf = (s: SellerTotalsWithId) => peerByAgent.get(s.agentId);

  const mostActive = topByDesc(
    sellerTotals,
    (s) => s.totalRequests > 0n,
    (a, b) => bigintDesc(a.totalRequests, b.totalRequests),
    (s) => entryForSeller(s, peerOf(s), s.totalRequests, s.settlementCount),
  );

  const mostSettlements = topByDesc(
    sellerTotals,
    (s) => s.settlementCount > 0,
    (a, b) => b.settlementCount - a.settlementCount,
    (s) => entryForSeller(s, peerOf(s), s.settlementCount, Number(s.totalRequests)),
  );

  const mostBuyers = topByDesc(
    sellerTotals,
    (s) => s.uniqueBuyers > 0,
    (a, b) => b.uniqueBuyers - a.uniqueBuyers,
    (s) => entryForSeller(s, peerOf(s), s.uniqueBuyers, Number(s.totalRequests)),
  );

  // newest / oldest by firstSeenAt — skip rows with no timestamp (early
  // backfill rows that were resolved before timestamp lookups landed).
  type SellerWithSeenAt = SellerTotalsWithId & { firstSeenAt: number };
  const seenSellers: SellerWithSeenAt[] = sellerTotals.filter(
    (s): s is SellerWithSeenAt => s.firstSeenAt !== null,
  );
  const newest = topByDesc(
    seenSellers,
    () => true,
    (a, b) => b.firstSeenAt - a.firstSeenAt,
    (s) => entryForSeller(s, peerOf(s), s.firstSeenAt, Number(s.totalRequests)),
  );
  const oldest = topByDesc(
    seenSellers,
    () => true,
    (a, b) => a.firstSeenAt - b.firstSeenAt,
    (s) => entryForSeller(s, peerOf(s), s.firstSeenAt, Number(s.totalRequests)),
  );

  // ── DHT-only leaderboards: stake and service breadth come from the
  // metadata announcement, not from the chain ─────────────────────────────
  type PeerWithStake = PeerMetadata & { stakeAmountUSDC: number };
  const stakedPeers: PeerWithStake[] = peers.filter(
    (p): p is PeerWithStake => typeof p.stakeAmountUSDC === 'number' && p.stakeAmountUSDC > 0,
  );
  const mostStaked = topByDesc(
    stakedPeers,
    () => true,
    (a, b) => b.stakeAmountUSDC - a.stakeAmountUSDC,
    (p) => entryForPeer(p, p.stakeAmountUSDC),
  );

  const diversity = peers.map((peer) => {
    const { services, categories } = collectPeerSets(peer);
    return { peer, breadth: services.size + categories.size, services: services.size };
  });
  const mostDiverse = topByDesc(
    diversity,
    (d) => d.breadth > 0,
    (a, b) => b.breadth - a.breadth,
    (d) => entryForPeer(d.peer, d.breadth, d.services),
  );

  return {
    mostActive,
    mostSettlements,
    mostBuyers,
    mostStaked,
    mostDiverse,
    newest,
    oldest,
    // Trending boards filled in by computeInsights — kept on the same object
    // so the public type stays cohesive (one Leaderboards type, one shape
    // regardless of which input data drove which entries).
    trendingUp: [],
    trendingDown: [],
  };
}

// ── pricing market ─────────────────────────────────────────────────────────

interface PeerServicePrice {
  peerId: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

/**
 * For one peer, return the cheapest announced (input price) per service across
 * all of that peer's providers. A peer that exposes the same service through
 * primary + fallback providers should be counted once, at the price a buyer
 * would actually route to.
 */
function cheapestPriceByServiceForPeer(peer: PeerMetadata): Map<string, PeerServicePrice> {
  const out = new Map<string, PeerServicePrice>();
  for (const provider of peer.providers) {
    for (const svc of provider.services) {
      const pricing = provider.servicePricing?.[svc] ?? provider.defaultPricing;
      if (
        !pricing
        || typeof pricing.inputUsdPerMillion !== 'number'
        || typeof pricing.outputUsdPerMillion !== 'number'
      ) continue;
      const candidate: PeerServicePrice = {
        peerId: peer.peerId,
        inputUsdPerMillion: pricing.inputUsdPerMillion,
        outputUsdPerMillion: pricing.outputUsdPerMillion,
      };
      const existing = out.get(svc);
      if (!existing || candidate.inputUsdPerMillion < existing.inputUsdPerMillion) {
        out.set(svc, candidate);
      }
    }
  }
  return out;
}

function computePricingByService(peers: readonly PeerMetadata[]): Record<string, ServicePricingMarket> {
  const byService = new Map<string, PeerServicePrice[]>();
  for (const peer of peers) {
    for (const [svc, price] of cheapestPriceByServiceForPeer(peer)) {
      const list = byService.get(svc);
      if (list) list.push(price);
      else byService.set(svc, [price]);
    }
  }

  const out: Record<string, ServicePricingMarket> = {};
  for (const [service, prices] of byService) {
    if (prices.length < PRICE_MARKET_MIN_PEERS) continue;
    // Cheapest = lowest input; ties broken by output so we surface a single
    // deterministic peer per service rather than randomly picking among
    // equally-cheap providers.
    const cheapest = [...prices].sort((a, b) =>
      a.inputUsdPerMillion - b.inputUsdPerMillion
      || a.outputUsdPerMillion - b.outputUsdPerMillion
    )[0]!;
    out[service] = {
      peerCount: prices.length,
      input: distribution(prices.map((p) => p.inputUsdPerMillion)),
      output: distribution(prices.map((p) => p.outputUsdPerMillion)),
      cheapestPeerId: cheapest.peerId,
      cheapestInputUsdPerMillion: cheapest.inputUsdPerMillion,
      cheapestOutputUsdPerMillion: cheapest.outputUsdPerMillion,
    };
  }
  return out;
}

// ── service / category / provider rankings ─────────────────────────────────

function rank(map: Record<string, number>): ServiceRanking[] {
  return Object.entries(map)
    .map(([key, peers]) => ({ key, peers }))
    .sort((a, b) => (b.peers - a.peers) || a.key.localeCompare(b.key));
}

function computeServiceRankings(peers: readonly PeerMetadata[]): NetworkInsights['services'] {
  const services: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const protocols: Record<string, number> = {};
  const providers: Record<string, number> = {};
  for (const peer of peers) {
    const sets = collectPeerSets(peer);
    for (const s of sets.services) bump(services, s);
    for (const c of sets.categories) bump(categories, c);
    for (const p of sets.protocols) bump(protocols, p);
    for (const p of sets.providers) bump(providers, p);
  }
  return {
    topServices: rank(services),
    topCategories: rank(categories),
    topProtocols: rank(protocols),
    topProviders: rank(providers),
  };
}

// ── region distribution ────────────────────────────────────────────────────

function computeRegions(peers: readonly PeerMetadata[]): RegionDistributionEntry[] {
  const counts: Record<string, number> = {};
  for (const peer of peers) {
    if (typeof peer.region === 'string' && peer.region.length > 0) bump(counts, peer.region);
  }
  return Object.entries(counts)
    .map(([region, peers]) => ({ region, peers }))
    .sort((a, b) => (b.peers - a.peers) || a.region.localeCompare(b.region));
}

// ── concentration ──────────────────────────────────────────────────────────

function computeConcentration(sellerTotals: readonly SellerTotalsWithId[]): ConcentrationStats {
  const requests = sellerTotals.map((s) => s.totalRequests).filter((v) => v > 0n);
  return {
    sellerCount: requests.length,
    gini: gini(requests),
    herfindahl: herfindahl(requests),
    top10Share: topShare(requests, LEADERBOARD_LIMIT),
  };
}

// ── velocity ───────────────────────────────────────────────────────────────

function computeVelocityWindow(
  history: readonly HistorySample[],
  windowSeconds: number,
  nowSeconds: number,
): VelocityWindow | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1]!;
  // Anchor "now" to the freshest sample, not wall-clock — wall-clock can be
  // up to one sampling interval ahead of the latest write, which makes the
  // current-window delta artificially small.
  const tsNow = Math.min(nowSeconds, last.ts);
  const currentBaseline = lastAtOrBefore(history, tsNow - windowSeconds);
  if (!currentBaseline) return null;

  const requestsDelta = last.totalRequests - currentBaseline.totalRequests;
  const tokensDelta =
    last.totalInputTokens + last.totalOutputTokens
    - currentBaseline.totalInputTokens - currentBaseline.totalOutputTokens;
  const settlementsDelta = last.settlementCount - currentBaseline.settlementCount;

  return {
    windowSeconds,
    requestsDelta: requestsDelta.toString(),
    tokensDelta: tokensDelta.toString(),
    settlementsDelta,
    requestsGrowthPct: computeGrowthPct(history, currentBaseline, requestsDelta, tsNow - 2 * windowSeconds),
  };
}

function computeGrowthPct(
  history: readonly HistorySample[],
  currentBaseline: HistorySample,
  requestsDelta: bigint,
  priorWindowStart: number,
): number | null {
  const priorBaseline = lastAtOrBefore(history, priorWindowStart);
  if (!priorBaseline || priorBaseline.ts >= currentBaseline.ts) return null;

  const priorRequests = currentBaseline.totalRequests - priorBaseline.totalRequests;
  if (priorRequests > 0n) {
    // Number-cast is safe enough for display: counts in a single window
    // comfortably fit JS Number range; precision loss only matters above
    // 2^53 (>9e15), well past realistic.
    return (Number(requestsDelta) - Number(priorRequests)) / Number(priorRequests);
  }
  // Prior window had no activity. Sentinel -1 flags "infinite growth" so the
  // UI can render "new" instead of NaN/Infinity; 0 means truly idle.
  return requestsDelta > 0n ? -1 : 0;
}

function computeVelocity(history: readonly HistorySample[], nowSeconds: number): Velocity {
  return {
    last24h: computeVelocityWindow(history, 86400, nowSeconds),
    last7d: computeVelocityWindow(history, 86400 * 7, nowSeconds),
  };
}

// ── activity ───────────────────────────────────────────────────────────────

function computeActivity(
  peers: readonly PeerMetadata[],
  sellerTotals: readonly SellerTotalsWithId[],
  nowSeconds: number,
): Activity {
  const cutoff = nowSeconds - ACTIVE_RECENT_SECONDS;
  let active = 0;
  for (const seller of sellerTotals) {
    if (seller.lastSeenAt !== null && seller.lastSeenAt >= cutoff) active++;
  }
  return {
    peersOnline: peers.length,
    sellersActiveLast24h: active,
    totalSellersIndexed: sellerTotals.length,
  };
}

// ── price stability / movers ───────────────────────────────────────────────

function displayNamesByPeerId(peers: readonly PeerMetadata[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const peer of peers) {
    if (typeof peer.peerId === 'string') out.set(peer.peerId, peer.displayName ?? null);
  }
  return out;
}

function toStabilityEntry(
  row: PriceVolatilityRow,
  displayName: string | null,
): PriceStabilityEntry {
  return {
    peerId: row.peerId,
    displayName,
    provider: row.provider,
    service: row.service,
    changeCount: row.changeCount,
    sampleCount: row.sampleCount,
    observedDays: Math.max(0, Math.round((row.lastTs - row.firstTs) / 86400)),
    latestInputUsdPerMillion: row.latestInputUsdPerMillion,
    latestOutputUsdPerMillion: row.latestOutputUsdPerMillion,
  };
}

function computePriceStability(
  rows: readonly PriceVolatilityRow[],
  names: ReadonlyMap<string, string | null>,
): PriceStability {
  if (rows.length === 0) return { mostStable: [], mostVolatile: [] };

  const toEntry = (row: PriceVolatilityRow) => toStabilityEntry(row, names.get(row.peerId) ?? null);

  // mostStable: lowest changeCount wins; tie-break by sampleCount desc (more
  // samples = stronger evidence the price is genuinely stable, not just one
  // lonely announcement) then by latest input price asc (cheaper first).
  const mostStable = topByDesc(
    rows,
    () => true,
    (a, b) =>
      a.changeCount - b.changeCount
      || b.sampleCount - a.sampleCount
      || a.latestInputUsdPerMillion - b.latestInputUsdPerMillion,
    toEntry,
  );

  // changeCount<2 means it didn't actually change.
  const mostVolatile = topByDesc(
    rows,
    (row) => row.changeCount >= 2,
    (a, b) => (b.changeCount - a.changeCount) || (b.sampleCount - a.sampleCount),
    toEntry,
  );

  return { mostStable, mostVolatile };
}

function toMoverEntry(
  row: PriceVolatilityRow,
  pct: number,
  displayName: string | null,
): PriceMoverEntry {
  return {
    peerId: row.peerId,
    displayName,
    provider: row.provider,
    service: row.service,
    inputChangePct: pct,
    fromInputUsdPerMillion: row.firstInputUsdPerMillion,
    toInputUsdPerMillion: row.latestInputUsdPerMillion,
    fromOutputUsdPerMillion: row.firstOutputUsdPerMillion,
    toOutputUsdPerMillion: row.latestOutputUsdPerMillion,
    windowSeconds: PRICE_STABILITY_WINDOW_SECONDS,
  };
}

function computePriceMovers(
  rows: readonly PriceVolatilityRow[],
  names: ReadonlyMap<string, string | null>,
): PriceMovers {
  if (rows.length === 0) return { biggestDrops: [], biggestHikes: [] };

  const movers: PriceMoverEntry[] = [];
  for (const row of rows) {
    if (row.firstInputUsdPerMillion <= 0) continue;
    if (row.firstInputUsdPerMillion === row.latestInputUsdPerMillion) continue;
    const pct = (row.latestInputUsdPerMillion - row.firstInputUsdPerMillion) / row.firstInputUsdPerMillion;
    if (Math.abs(pct) < PRICE_MOVER_MIN_PCT) continue;
    movers.push(toMoverEntry(row, pct, names.get(row.peerId) ?? null));
  }

  return {
    biggestDrops: movers
      .filter((m) => m.inputChangePct < 0)
      .sort((a, b) => a.inputChangePct - b.inputChangePct)
      .slice(0, LEADERBOARD_LIMIT),
    biggestHikes: movers
      .filter((m) => m.inputChangePct > 0)
      .sort((a, b) => b.inputChangePct - a.inputChangePct)
      .slice(0, LEADERBOARD_LIMIT),
  };
}

// ── trending leaderboards ──────────────────────────────────────────────────

interface TrendingComputed {
  agentId: number;
  ratio: number;        // last24h_delta / prior_daily_avg
  last24hDelta: number;
}

function groupActivity(rows: readonly SellerActivityRow[]): Map<number, SellerActivityRow[]> {
  const out = new Map<number, SellerActivityRow[]>();
  for (const row of rows) {
    let bucket = out.get(row.agentId);
    if (!bucket) {
      bucket = [];
      out.set(row.agentId, bucket);
    }
    bucket.push(row);
  }
  return out;
}

/** Pure number-crunching: maps the grouped activity rows to per-agent ratios. */
function computeTrendingRatios(
  sellerActivity: readonly SellerActivityRow[],
  nowSeconds: number,
): TrendingComputed[] {
  const grouped = groupActivity(sellerActivity);
  const cutoff24h = nowSeconds - 86400;
  const cutoff8d = nowSeconds - 86400 * 8;

  const out: TrendingComputed[] = [];
  for (const [agentId, rows] of grouped) {
    if (rows.length < 2) continue;
    const latest = rows[rows.length - 1]!;
    const at24h = lastAtOrBefore(rows, cutoff24h);
    const at8d = lastAtOrBefore(rows, cutoff8d);
    if (!at24h || !at8d) continue;

    const last24hDelta = Number(latest.totalRequests - at24h.totalRequests);
    const prior7dDelta = Number(at24h.totalRequests - at8d.totalRequests);
    // Tiny absolute volume — leave out so the leaderboard doesn't surface
    // 1-request sellers as "trending up 100×".
    if (last24hDelta < TRENDING_MIN_REQUESTS_24H && prior7dDelta < TRENDING_MIN_REQUESTS_24H * 7) continue;

    if (prior7dDelta <= 0) {
      // Brand-new seller — flag with sentinel ratio so the UI can display
      // "new" rather than a ratio. Infinity sorts to the top of trendingUp.
      out.push({ agentId, ratio: Number.POSITIVE_INFINITY, last24hDelta });
      continue;
    }
    const priorDailyAvg = prior7dDelta / 7;
    if (priorDailyAvg <= 0) continue;
    out.push({ agentId, ratio: last24hDelta / priorDailyAvg, last24hDelta });
  }
  return out;
}

function trendingToEntry(
  t: TrendingComputed,
  peerByAgent: ReadonlyMap<number, PeerMetadata>,
): LeaderboardEntry {
  const peer = peerByAgent.get(t.agentId);
  return {
    agentId: t.agentId,
    peerId: peer?.peerId ?? null,
    displayName: peer?.displayName ?? null,
    region: peer?.region ?? null,
    metric: Number.isFinite(t.ratio) ? t.ratio.toFixed(4) : 'new',
    secondary: t.last24hDelta,
  };
}

function computeTrending(
  sellerActivity: readonly SellerActivityRow[],
  peerByAgent: ReadonlyMap<number, PeerMetadata>,
  nowSeconds: number,
): { trendingUp: LeaderboardEntry[]; trendingDown: LeaderboardEntry[] } {
  if (sellerActivity.length === 0) return { trendingUp: [], trendingDown: [] };
  const computed = computeTrendingRatios(sellerActivity, nowSeconds);

  const up = computed
    // Only sellers that genuinely accelerated above their baseline make the
    // up-board — a ratio of 0.7 (down-trending) shouldn't show up here just
    // because it sorts above other downward sellers.
    .filter((t) => t.ratio > 1 || !Number.isFinite(t.ratio))
    .sort((a, b) => {
      // Infinity-ratio (brand-new active sellers) wins outright, then by ratio desc.
      if (a.ratio === b.ratio) return b.last24hDelta - a.last24hDelta;
      return b.ratio - a.ratio;
    })
    .slice(0, LEADERBOARD_LIMIT)
    .map((t) => trendingToEntry(t, peerByAgent));

  const down = computed
    .filter((t) => Number.isFinite(t.ratio) && t.ratio < 1)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, LEADERBOARD_LIMIT)
    .map((t) => trendingToEntry(t, peerByAgent));

  return { trendingUp: up, trendingDown: down };
}

// ── public entry point ─────────────────────────────────────────────────────

export function computeInsights(input: ComputeInsightsInput): NetworkInsights {
  const nowMs = input.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  // Build the live-peer lookup maps once; both leaderboards/trending and
  // priceStability/priceMovers join against them.
  const peerByAgent = peerByAgentId(input.peers, input.agentIdByPeerAddress);
  const namesByPeerId = displayNamesByPeerId(input.peers);
  const leaderboards = computeLeaderboards(input, peerByAgent);
  const trending = computeTrending(input.sellerActivity ?? [], peerByAgent, nowSeconds);
  leaderboards.trendingUp = trending.trendingUp;
  leaderboards.trendingDown = trending.trendingDown;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    leaderboards,
    pricing: { byService: computePricingByService(input.peers) },
    services: computeServiceRankings(input.peers),
    regions: computeRegions(input.peers),
    concentration: computeConcentration(input.sellerTotals),
    velocity: computeVelocity(input.history, nowSeconds),
    activity: computeActivity(input.peers, input.sellerTotals, nowSeconds),
    priceStability: computePriceStability(input.priceVolatility ?? [], namesByPeerId),
    priceMovers: computePriceMovers(input.priceVolatility ?? [], namesByPeerId),
  };
}

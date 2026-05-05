import Database from 'better-sqlite3';
import type { DecodedMetadataRecorded } from '@antseed/node';

export interface SellerTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  firstSettledBlock: number;
  lastSettledBlock: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  uniqueBuyers: number;
  uniqueChannels: number;
  avgRequestsPerChannel: number;
  avgRequestsPerBuyer: number;
  lastUpdatedAt: number;
}

/**
 * Per-seller totals row keyed by agentId — the same shape consumers see in
 * /stats per peer, but enumerated across the whole indexed set so the
 * insights endpoint can build leaderboards without N+1 round trips. Returned
 * by `getAllSellerTotalsWithIds` and consumed by `insights.ts`.
 */
export interface SellerTotalsWithId extends SellerTotals {
  agentId: number;
}

export interface NetworkTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  sellerCount: number;
  lastUpdatedAt: number | null;
}

export interface HistorySample {
  ts: number;                    // unix seconds
  activePeers: number;
  sellerCount: number;
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
}

export type HistoryRange = '1d' | '7d' | '30d';

export interface HistoryPoint {
  ts: number;                  // unix seconds, bucket boundary (start of bucket)
  activePeers: number | null;  // last gauge sample in bucket; null when only chain-backfilled rows are present (we have no DHT history for the past)
  requests: number;            // delta of cumulative within the bucket
  settlements: number;         // delta of cumulative within the bucket
  tokens: number;              // delta of cumulative input+output tokens within the bucket
}

export interface HistoryResponse {
  range: HistoryRange;
  bucketSeconds: number;
  points: HistoryPoint[];
}

/**
 * Sentinel written into `network_history.active_peers` by the chain backfill
 * since we genuinely don't know how many peers were online at past timestamps.
 * `bucketHistoryRows` translates -1 into a null on the way out so the chart
 * skips the peers line for those buckets without needing a schema change.
 */
export const ACTIVE_PEERS_UNKNOWN = -1;

export interface PriceSampleInput {
  peerId: string;        // 40 hex chars (no 0x), normalized lowercase
  provider: string;
  service: string;
  ts: number;            // unix seconds
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number | null;
}

const PRICE_SAMPLE_HEARTBEAT_SECONDS = 86_400;

/**
 * Per-(peer, service) pricing volatility rollup over a window. Drives the
 * "most stable / most volatile" insight leaderboards. `changeCount` is the
 * number of distinct price tuples observed in the window; stable peers remain
 * visible because unchanged announcements are persisted as daily heartbeats.
 */
export interface PriceVolatilityRow {
  peerId: string;
  provider: string;
  service: string;
  sampleCount: number;
  changeCount: number;       // distinct (input, output) tuples in the window
  firstTs: number;
  lastTs: number;
  firstInputUsdPerMillion: number;
  firstOutputUsdPerMillion: number;
  latestInputUsdPerMillion: number;
  latestOutputUsdPerMillion: number;
}

export interface SellerActivityRow {
  agentId: number;
  ts: number;
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
}

export interface SellerActivitySnapshotInput {
  agentId: number;
  ts: number;
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
}

// ── DB row shapes (snake_case mirror of the SQL columns) ───────────────────

interface SellerRow {
  total_input_tokens: string;
  total_output_tokens: string;
  total_request_count: string;
  settlement_count: number;
  first_settled_block: number | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
}

interface AggregateRow {
  total_input_tokens: string;
  total_output_tokens: string;
  total_request_count: string;
  settlement_count: number;
  first_settled_block: number;
}

interface SellerTotalsRow {
  total_request_count: string;
  total_input_tokens: string;
  total_output_tokens: string;
  settlement_count: number;
  first_settled_block: number | null;
  last_settled_block: number | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
  last_updated_at: number;
}

interface HistoryRow {
  ts: number;
  active_peers: number;
  seller_count: number;
  total_requests: string;
  total_input_tokens: string;
  total_output_tokens: string;
  settlement_count: number;
}

interface SellerActivityDbRow {
  agent_id: number;
  ts: number;
  total_requests: string;
  total_input_tokens: string;
  total_output_tokens: string;
  settlement_count: number;
}

// ── DDL + prepared statements ──────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS seller_metadata_totals (
    agent_id INTEGER PRIMARY KEY,
    total_input_tokens TEXT NOT NULL DEFAULT '0',
    total_output_tokens TEXT NOT NULL DEFAULT '0',
    total_request_count TEXT NOT NULL DEFAULT '0',
    settlement_count INTEGER NOT NULL DEFAULT 0,
    first_settled_block INTEGER,
    last_settled_block INTEGER,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    last_updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seller_buyer_totals (
    agent_id INTEGER NOT NULL,
    buyer TEXT NOT NULL,
    total_input_tokens TEXT NOT NULL DEFAULT '0',
    total_output_tokens TEXT NOT NULL DEFAULT '0',
    total_request_count TEXT NOT NULL DEFAULT '0',
    settlement_count INTEGER NOT NULL DEFAULT 0,
    first_settled_block INTEGER NOT NULL,
    last_settled_block INTEGER NOT NULL,
    PRIMARY KEY (agent_id, buyer)
  );

  CREATE TABLE IF NOT EXISTS seller_channel_totals (
    agent_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    buyer TEXT NOT NULL,
    total_input_tokens TEXT NOT NULL DEFAULT '0',
    total_output_tokens TEXT NOT NULL DEFAULT '0',
    total_request_count TEXT NOT NULL DEFAULT '0',
    settlement_count INTEGER NOT NULL DEFAULT 0,
    first_settled_block INTEGER NOT NULL,
    last_settled_block INTEGER NOT NULL,
    PRIMARY KEY (agent_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS indexer_checkpoint (
    chain_id TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    last_block INTEGER NOT NULL,
    last_block_timestamp INTEGER,
    PRIMARY KEY (chain_id, contract_address)
  );

  CREATE TABLE IF NOT EXISTS network_history (
    ts INTEGER PRIMARY KEY,
    active_peers INTEGER NOT NULL,
    seller_count INTEGER NOT NULL,
    total_requests TEXT NOT NULL,
    total_input_tokens TEXT NOT NULL,
    total_output_tokens TEXT NOT NULL,
    settlement_count INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS peer_pricing_history (
    peer_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    service TEXT NOT NULL,
    ts INTEGER NOT NULL,
    input_usd_per_million REAL NOT NULL,
    output_usd_per_million REAL NOT NULL,
    cached_input_usd_per_million REAL,
    PRIMARY KEY (peer_id, provider, service, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_peer_pricing_history_ts
    ON peer_pricing_history (ts);

  CREATE TABLE IF NOT EXISTS seller_activity_history (
    agent_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    total_requests TEXT NOT NULL,
    total_input_tokens TEXT NOT NULL,
    total_output_tokens TEXT NOT NULL,
    settlement_count INTEGER NOT NULL,
    PRIMARY KEY (agent_id, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_seller_activity_history_ts
    ON seller_activity_history (ts);
`;

interface PriceVolatilityDbRow {
  peer_id: string;
  provider: string;
  service: string;
  sample_count: number;
  change_count: number;
  first_ts: number;
  last_ts: number;
  first_input: number;
  first_output: number;
  latest_input: number;
  latest_output: number;
}

interface PriceSampleRow {
  ts: number;
  input_usd_per_million: number;
  output_usd_per_million: number;
  cached_input_usd_per_million: number | null;
}

interface CountByAgent { agent_id: number; c: number }
interface CountResult { c: number }
interface CheckpointRow { last_block: number; last_block_timestamp: number | null }

/**
 * All prepared statements compiled once per store. Lifting them out of the
 * class body keeps the class focused on its public methods and isolates the
 * SQL surface in one place.
 */
interface Statements {
  selectCheckpoint: Database.Statement<[string, string], CheckpointRow>;
  upsertCheckpoint: Database.Statement<[string, string, number, number | null]>;

  selectSeller: Database.Statement<[number], SellerRow>;
  upsertSeller: Database.Statement<[number, string, string, string, number, number, number, number | null, number | null, number]>;
  selectSellerTotals: Database.Statement<[number], SellerTotalsRow>;
  selectAllSellerTotalsWithIds: Database.Statement<[], SellerTotalsRow & { agent_id: number }>;

  selectBuyer: Database.Statement<[number, string], AggregateRow>;
  upsertBuyer: Database.Statement<[number, string, string, string, string, number, number, number]>;
  countBuyersAll: Database.Statement<[], CountByAgent>;
  countBuyers: Database.Statement<[number], CountResult>;

  selectChannel: Database.Statement<[number, string], AggregateRow & { buyer: string }>;
  upsertChannel: Database.Statement<[number, string, string, string, string, string, number, number, number]>;
  countChannelsAll: Database.Statement<[], CountByAgent>;
  countChannels: Database.Statement<[number], CountResult>;

  insertHistory: Database.Statement<[number, number, number, string, string, string, number]>;
  selectHistorySince: Database.Statement<[number], HistoryRow>;
  selectEarliestHistoryTs: Database.Statement<[], { ts: number | null }>;
  selectLatestHistoryAtOrBefore: Database.Statement<
    [number],
    Pick<HistoryRow, 'total_requests' | 'total_input_tokens' | 'total_output_tokens' | 'settlement_count'>
  >;

  selectLatestPriceSample: Database.Statement<[string, string, string], PriceSampleRow>;
  insertPriceSample: Database.Statement<[string, string, string, number, number, number, number | null]>;
  selectPriceVolatility: Database.Statement<[number, number, number], PriceVolatilityDbRow>;

  selectLatestSellerActivity: Database.Statement<[number], Omit<SellerActivityDbRow, 'agent_id'>>;
  selectLatestSellerActivityAtOrBefore: Database.Statement<[number, number], SellerActivityDbRow>;
  insertSellerActivity: Database.Statement<[number, number, string, string, string, number]>;
  selectSellerActivitySince: Database.Statement<[number], SellerActivityDbRow>;
}

function prepareStatements(db: Database.Database): Statements {
  return {
    selectCheckpoint: db.prepare(
      'SELECT last_block, last_block_timestamp FROM indexer_checkpoint WHERE chain_id = ? AND contract_address = ?',
    ),
    upsertCheckpoint: db.prepare(
      `INSERT INTO indexer_checkpoint (chain_id, contract_address, last_block, last_block_timestamp)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, contract_address) DO UPDATE SET
         last_block = excluded.last_block,
         last_block_timestamp = excluded.last_block_timestamp`,
    ),

    selectSeller: db.prepare(
      `SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count,
              first_settled_block, first_seen_at, last_seen_at
         FROM seller_metadata_totals WHERE agent_id = ?`,
    ),
    upsertSeller: db.prepare(
      `INSERT OR REPLACE INTO seller_metadata_totals
         (agent_id, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block,
          first_seen_at, last_seen_at, last_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectSellerTotals: db.prepare(
      `SELECT total_request_count, total_input_tokens, total_output_tokens, settlement_count,
              first_settled_block, last_settled_block, first_seen_at, last_seen_at, last_updated_at
         FROM seller_metadata_totals WHERE agent_id = ?`,
    ),
    selectAllSellerTotalsWithIds: db.prepare(
      `SELECT agent_id, total_request_count, total_input_tokens, total_output_tokens, settlement_count,
              first_settled_block, last_settled_block, first_seen_at, last_seen_at, last_updated_at
         FROM seller_metadata_totals`,
    ),

    selectBuyer: db.prepare(
      `SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block
         FROM seller_buyer_totals WHERE agent_id = ? AND buyer = ?`,
    ),
    upsertBuyer: db.prepare(
      `INSERT OR REPLACE INTO seller_buyer_totals
         (agent_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    countBuyersAll: db.prepare('SELECT agent_id, COUNT(*) AS c FROM seller_buyer_totals GROUP BY agent_id'),
    countBuyers: db.prepare('SELECT COUNT(*) AS c FROM seller_buyer_totals WHERE agent_id = ?'),

    selectChannel: db.prepare(
      `SELECT buyer, total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block
         FROM seller_channel_totals WHERE agent_id = ? AND channel_id = ?`,
    ),
    upsertChannel: db.prepare(
      `INSERT OR REPLACE INTO seller_channel_totals
         (agent_id, channel_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    countChannelsAll: db.prepare('SELECT agent_id, COUNT(*) AS c FROM seller_channel_totals GROUP BY agent_id'),
    countChannels: db.prepare('SELECT COUNT(*) AS c FROM seller_channel_totals WHERE agent_id = ?'),

    insertHistory: db.prepare(
      `INSERT OR IGNORE INTO network_history
         (ts, active_peers, seller_count, total_requests,
          total_input_tokens, total_output_tokens, settlement_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    selectHistorySince: db.prepare(
      `SELECT ts, active_peers, seller_count, total_requests,
              total_input_tokens, total_output_tokens, settlement_count
         FROM network_history WHERE ts >= ? ORDER BY ts ASC`,
    ),
    selectEarliestHistoryTs: db.prepare('SELECT MIN(ts) AS ts FROM network_history'),
    selectLatestHistoryAtOrBefore: db.prepare(
      `SELECT total_requests, total_input_tokens, total_output_tokens, settlement_count
         FROM network_history WHERE ts <= ? ORDER BY ts DESC LIMIT 1`,
    ),

    selectLatestPriceSample: db.prepare(
      `SELECT ts, input_usd_per_million, output_usd_per_million, cached_input_usd_per_million
         FROM peer_pricing_history
        WHERE peer_id = ? AND provider = ? AND service = ?
        ORDER BY ts DESC LIMIT 1`,
    ),
    insertPriceSample: db.prepare(
      `INSERT OR IGNORE INTO peer_pricing_history
         (peer_id, provider, service, ts, input_usd_per_million,
          output_usd_per_million, cached_input_usd_per_million)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Per-(peer, provider, service) rollup. `change_count` counts distinct
    // (input, output) tuples — a peer that posted (1,2) (1,2) (3,4) (3,4)
    // has changeCount=2. The four correlated subqueries pick out the first/
    // latest sample inside the window so callers can compute % change.
    selectPriceVolatility: db.prepare(
      `SELECT
         peer_id, provider, service,
         COUNT(*) AS sample_count,
         COUNT(DISTINCT input_usd_per_million || '|' || output_usd_per_million) AS change_count,
         MIN(ts) AS first_ts, MAX(ts) AS last_ts,
         (SELECT input_usd_per_million FROM peer_pricing_history p2
            WHERE p2.peer_id = p1.peer_id AND p2.provider = p1.provider
              AND p2.service = p1.service AND p2.ts >= ?
            ORDER BY ts ASC LIMIT 1) AS first_input,
         (SELECT output_usd_per_million FROM peer_pricing_history p2
            WHERE p2.peer_id = p1.peer_id AND p2.provider = p1.provider
              AND p2.service = p1.service AND p2.ts >= ?
            ORDER BY ts ASC LIMIT 1) AS first_output,
         (SELECT input_usd_per_million FROM peer_pricing_history p2
            WHERE p2.peer_id = p1.peer_id AND p2.provider = p1.provider
              AND p2.service = p1.service
            ORDER BY ts DESC LIMIT 1) AS latest_input,
         (SELECT output_usd_per_million FROM peer_pricing_history p2
            WHERE p2.peer_id = p1.peer_id AND p2.provider = p1.provider
              AND p2.service = p1.service
            ORDER BY ts DESC LIMIT 1) AS latest_output
       FROM peer_pricing_history p1
       WHERE ts >= ?
       GROUP BY peer_id, provider, service`,
    ),

    selectLatestSellerActivity: db.prepare(
      `SELECT ts, total_requests, total_input_tokens, total_output_tokens, settlement_count
         FROM seller_activity_history WHERE agent_id = ? ORDER BY ts DESC LIMIT 1`,
    ),
    selectLatestSellerActivityAtOrBefore: db.prepare(
      `SELECT agent_id, ts, total_requests, total_input_tokens, total_output_tokens, settlement_count
         FROM seller_activity_history WHERE agent_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
    ),
    insertSellerActivity: db.prepare(
      `INSERT OR IGNORE INTO seller_activity_history
         (agent_id, ts, total_requests, total_input_tokens, total_output_tokens, settlement_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    selectSellerActivitySince: db.prepare(
      `SELECT agent_id, ts, total_requests, total_input_tokens, total_output_tokens, settlement_count
         FROM seller_activity_history WHERE ts >= ? ORDER BY agent_id ASC, ts ASC`,
    ),
  };
}

// ── pure row → domain converters ───────────────────────────────────────────

function rowToSellerTotals(
  row: SellerTotalsRow,
  uniqueBuyers: number,
  uniqueChannels: number,
): SellerTotals {
  const totalRequests = BigInt(row.total_request_count);
  return {
    totalRequests,
    totalInputTokens: BigInt(row.total_input_tokens),
    totalOutputTokens: BigInt(row.total_output_tokens),
    settlementCount: row.settlement_count,
    firstSettledBlock: row.first_settled_block ?? 0,
    lastSettledBlock: row.last_settled_block ?? 0,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    uniqueBuyers,
    uniqueChannels,
    avgRequestsPerBuyer: uniqueBuyers === 0 ? 0 : Number(totalRequests / BigInt(uniqueBuyers)),
    avgRequestsPerChannel: uniqueChannels === 0 ? 0 : Number(totalRequests / BigInt(uniqueChannels)),
    lastUpdatedAt: row.last_updated_at,
  };
}

function rowToSellerActivity(row: SellerActivityDbRow): SellerActivityRow {
  return {
    agentId: row.agent_id,
    ts: row.ts,
    totalRequests: BigInt(row.total_requests),
    totalInputTokens: BigInt(row.total_input_tokens),
    totalOutputTokens: BigInt(row.total_output_tokens),
    settlementCount: row.settlement_count,
  };
}

/**
 * Compute the new (input, output, request, settlement, firstBlock) tuple after
 * applying one settlement event to a buyer- or channel-scoped aggregate row.
 * Used inside applyBatch's atomic transaction; pure so it's trivial to reason
 * about under rollback.
 */
function mergeAggregate(
  prev: AggregateRow | undefined,
  ev: DecodedMetadataRecorded,
): {
  inputTokens: bigint;
  outputTokens: bigint;
  requestCount: bigint;
  settlementCount: number;
  firstBlock: number;
} {
  return {
    inputTokens: (prev ? BigInt(prev.total_input_tokens) : 0n) + ev.inputTokens,
    outputTokens: (prev ? BigInt(prev.total_output_tokens) : 0n) + ev.outputTokens,
    requestCount: (prev ? BigInt(prev.total_request_count) : 0n) + ev.requestCount,
    settlementCount: (prev?.settlement_count ?? 0) + 1,
    firstBlock: prev?.first_settled_block ?? ev.blockNumber,
  };
}

export class SqliteStore {
  // The store.test.ts table-listing assertion peeks at this field name via a
  // structural cast; renaming would silently break that test path.
  private db: Database.Database;
  private statements!: Statements;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  /** Creates tables if missing and compiles prepared statements. Idempotent. */
  init(): void {
    this.db.exec(SCHEMA);
    this.statements = prepareStatements(this.db);
  }

  /**
   * Earliest history sample timestamp (unix seconds), or null if the table is
   * empty. Used by the backfill driver to decide whether to re-fetch chain
   * events: if we already have history reaching back further than the cutoff,
   * skip the backfill.
   */
  getEarliestHistoryTs(): number | null {
    return this.statements.selectEarliestHistoryTs.get()?.ts ?? null;
  }

  /** Returns last indexed block for (chainId, contractAddress), or null if no checkpoint. */
  getCheckpoint(chainId: string, contractAddress: string): number | null {
    const row = this.statements.selectCheckpoint.get(chainId, contractAddress.toLowerCase());
    return row ? row.last_block : null;
  }

  /**
   * Atomic transaction:
   *   1. For each event, upsert seller_metadata_totals (add deltas, track first/last block, bump count).
   *   2. Upsert seller_buyer_totals for (agentId, buyer) with the same deltas.
   *   3. Upsert seller_channel_totals for (agentId, channelId) with the same deltas.
   *   4. Advance indexer_checkpoint.last_block = newCheckpoint for this (chainId, contractAddress).
   * If any step throws, the transaction is rolled back — next tick re-fetches the same range.
   *
   * Events MUST be sorted ascending by (blockNumber, logIndex) — StatsClient guarantees this.
   * first_settled_block is set only on first insert and never overwritten; last_settled_block is
   * always set to the current event's block (monotonically non-decreasing given the sort order).
   */
  applyBatch(
    chainId: string,
    contractAddress: string,
    events: DecodedMetadataRecorded[],
    newCheckpoint: number,
    blockTimestamps?: Map<number, number>,
    newCheckpointTimestamp?: number | null,
  ): void {
    const s = this.statements;
    this.db.transaction(() => {
      for (const event of events) {
        // uint256 → number narrowing. agentIds are sequential and small in practice,
        // but the ERC-8004 IdentityRegistry is uint256, so guard against a pathological
        // future value that would silently collide or miss the PK lookup.
        if (event.agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
          console.warn(`[store] agentId ${event.agentId} exceeds MAX_SAFE_INTEGER — skipping event`);
          continue;
        }
        const agentId = Number(event.agentId);
        const buyer = event.buyer.toLowerCase();
        const channelId = event.channelId.toLowerCase();
        const eventTimestamp = blockTimestamps?.get(event.blockNumber) ?? null;
        const now = Math.floor(Date.now() / 1000);

        // ── seller_metadata_totals ───────────────────────────────────
        const prevSeller = s.selectSeller.get(agentId);
        const prevSellerInput = prevSeller ? BigInt(prevSeller.total_input_tokens) : 0n;
        const prevSellerOutput = prevSeller ? BigInt(prevSeller.total_output_tokens) : 0n;
        const prevSellerCount = prevSeller ? BigInt(prevSeller.total_request_count) : 0n;
        // Events arrive sorted by (blockNumber, logIndex), so the current event's
        // block is always >= the stored last_seen_at — no max() needed.
        const firstSeenAt = prevSeller?.first_seen_at ?? eventTimestamp;
        const lastSeenAt = eventTimestamp ?? prevSeller?.last_seen_at ?? null;

        s.upsertSeller.run(
          agentId,
          (prevSellerInput + event.inputTokens).toString(),
          (prevSellerOutput + event.outputTokens).toString(),
          (prevSellerCount + event.requestCount).toString(),
          (prevSeller?.settlement_count ?? 0) + 1,
          prevSeller?.first_settled_block ?? event.blockNumber,
          event.blockNumber,
          firstSeenAt,
          lastSeenAt,
          now,
        );

        // ── seller_buyer_totals ──────────────────────────────────────
        const buyerNext = mergeAggregate(s.selectBuyer.get(agentId, buyer), event);
        s.upsertBuyer.run(
          agentId,
          buyer,
          buyerNext.inputTokens.toString(),
          buyerNext.outputTokens.toString(),
          buyerNext.requestCount.toString(),
          buyerNext.settlementCount,
          buyerNext.firstBlock,
          event.blockNumber,
        );

        // ── seller_channel_totals ────────────────────────────────────
        const channelNext = mergeAggregate(s.selectChannel.get(agentId, channelId), event);
        s.upsertChannel.run(
          agentId,
          channelId,
          buyer,
          channelNext.inputTokens.toString(),
          channelNext.outputTokens.toString(),
          channelNext.requestCount.toString(),
          channelNext.settlementCount,
          channelNext.firstBlock,
          event.blockNumber,
        );
      }

      s.upsertCheckpoint.run(
        chainId,
        contractAddress.toLowerCase(),
        newCheckpoint,
        newCheckpointTimestamp ?? null,
      );
    })();
  }

  /** Returns last indexed block + block timestamp, or null if no checkpoint. */
  getCheckpointInfo(
    chainId: string,
    contractAddress: string,
  ): { lastBlock: number; lastBlockTimestamp: number | null } | null {
    const row = this.statements.selectCheckpoint.get(chainId, contractAddress.toLowerCase());
    return row ? { lastBlock: row.last_block, lastBlockTimestamp: row.last_block_timestamp } : null;
  }

  /** Returns cumulative totals for a single agentId, or null if never seen. */
  getSellerTotals(agentId: number): SellerTotals | null {
    const row = this.statements.selectSellerTotals.get(agentId);
    if (!row) return null;
    const uniqueBuyers = this.statements.countBuyers.get(agentId)?.c ?? 0;
    const uniqueChannels = this.statements.countChannels.get(agentId)?.c ?? 0;
    return rowToSellerTotals(row, uniqueBuyers, uniqueChannels);
  }

  /**
   * Returns one row per indexed seller, keyed by agentId, with the same
   * derived fields exposed via `getSellerTotals` (uniqueBuyers/Channels and
   * avgRequestsPerBuyer/Channel). Two GROUP BY queries pre-fetch the buyer/
   * channel counts so the per-row work is O(1) lookups instead of N+1 SELECTs.
   *
   * Used by the insights endpoint to build cross-network leaderboards (most
   * active, most settlements, biggest customer base, etc.) in a single pass.
   */
  getAllSellerTotalsWithIds(): SellerTotalsWithId[] {
    const buyerCounts = new Map<number, number>();
    for (const row of this.statements.countBuyersAll.all()) buyerCounts.set(row.agent_id, row.c);
    const channelCounts = new Map<number, number>();
    for (const row of this.statements.countChannelsAll.all()) channelCounts.set(row.agent_id, row.c);

    return this.statements.selectAllSellerTotalsWithIds.all().map((row) => ({
      agentId: row.agent_id,
      ...rowToSellerTotals(row, buyerCounts.get(row.agent_id) ?? 0, channelCounts.get(row.agent_id) ?? 0),
    }));
  }

  /**
   * Raw `network_history` rows from the last `secondsAgo` seconds, ordered
   * ascending by ts. Used by the insights endpoint to compute network velocity
   * (24h / 7d deltas) without re-implementing the bucketing logic.
   */
  getHistorySince(secondsAgo: number, nowSeconds: number = Math.floor(Date.now() / 1000)): HistorySample[] {
    return this.statements.selectHistorySince.all(nowSeconds - secondsAgo).map((row) => ({
      ts: row.ts,
      activePeers: row.active_peers,
      sellerCount: row.seller_count,
      totalRequests: BigInt(row.total_requests),
      totalInputTokens: BigInt(row.total_input_tokens),
      totalOutputTokens: BigInt(row.total_output_tokens),
      settlementCount: row.settlement_count,
    }));
  }

  /**
   * Cumulative totals across all indexed sellers, including those not currently
   * online. Computed by walking every row in JS rather than `SELECT SUM(...)`
   * because the cumulative columns are stored as TEXT bigints — SQLite's SUM
   * would silently overflow at 2^63 on values the test suite explicitly exercises.
   */
  getNetworkTotals(): NetworkTotals {
    let totalRequests = 0n;
    let totalInputTokens = 0n;
    let totalOutputTokens = 0n;
    let settlementCount = 0;
    let sellerCount = 0;
    let lastUpdatedAt: number | null = null;

    for (const row of this.statements.selectAllSellerTotalsWithIds.all()) {
      totalRequests += BigInt(row.total_request_count);
      totalInputTokens += BigInt(row.total_input_tokens);
      totalOutputTokens += BigInt(row.total_output_tokens);
      settlementCount += row.settlement_count;
      sellerCount += 1;
      lastUpdatedAt = Math.max(lastUpdatedAt ?? 0, row.last_updated_at);
    }

    return { totalRequests, totalInputTokens, totalOutputTokens, settlementCount, sellerCount, lastUpdatedAt };
  }

  /**
   * Append one history sample. INSERT OR IGNORE — if two writes land in the
   * same second (poll retry, clock jitter), the first wins and the second is
   * silently dropped. The poller cadence is 15 minutes, so collisions are rare
   * enough that overwrite-vs-keep doesn't change any chart.
   *
   * Monotonicity guard: cumulative totals only ever go up — settlements are
   * append-only on-chain. If a new sample's cum is below the most recent
   * stored row's cum, the writer is reading from a temporarily-behind source
   * (live sampler racing the indexer's catch-up to the backfill). Dropping
   * keeps the table monotonic-by-ts so velocity windows can't compute negative
   * deltas. Returns true if the row was written, false if dropped.
   */
  recordHistorySample(sample: HistorySample): { written: boolean } {
    const prior = this.statements.selectLatestHistoryAtOrBefore.get(sample.ts);
    if (prior && wouldRegress(sample, prior)) return { written: false };

    this.statements.insertHistory.run(
      sample.ts,
      sample.activePeers,
      sample.sellerCount,
      sample.totalRequests.toString(),
      sample.totalInputTokens.toString(),
      sample.totalOutputTokens.toString(),
      sample.settlementCount,
    );
    return { written: true };
  }

  /**
   * Bucketed history for the dashboard chart.
   *
   * - 1d  → 1h buckets
   * - 7d  → 1d buckets
   * - 30d → 1d buckets
   *
   * activePeers is a gauge — we report the LAST sample in each bucket
   * ("what was it at close-of-bucket"). requests/settlements are cumulative
   * counters, so per-bucket values are computed as deltas: the bucket's last
   * cumulative minus the previous bucket's last cumulative. The first bucket
   * uses its own first sample as the baseline (so it shows "growth within
   * the bucket"), which under-counts only the first bucket of the range and
   * is the simplest behavior that doesn't require fetching pre-range data.
   */
  getHistory(range: HistoryRange, nowSeconds: number = Math.floor(Date.now() / 1000)): HistoryResponse {
    const bucketSeconds = range === '1d' ? 3600 : 86400;
    const rangeSeconds = range === '1d' ? 86400 : range === '7d' ? 86400 * 7 : 86400 * 30;
    const rows = this.statements.selectHistorySince.all(nowSeconds - rangeSeconds);
    return { range, bucketSeconds, points: bucketHistoryRows(rows, bucketSeconds) };
  }

  /**
   * Append a price sample for (peer, provider, service) — but only if it
   * differs from the most recent stored sample for the same key, or if the
   * latest identical row is older than the daily heartbeat interval. The point
   * is to keep `peer_pricing_history` mostly event-shaped while still proving
   * that a stable price was observed inside later insight windows.
   *
   * INSERT OR IGNORE handles the rare case that two writes land in the same
   * second — first wins, second is silently dropped via the ts PK component.
   */
  recordPriceSample(input: PriceSampleInput): void {
    const latest = this.statements.selectLatestPriceSample.get(input.peerId, input.provider, input.service);
    if (latest && isPriceSampleDuplicate(latest, input)) return;

    this.statements.insertPriceSample.run(
      input.peerId,
      input.provider,
      input.service,
      input.ts,
      input.inputUsdPerMillion,
      input.outputUsdPerMillion,
      input.cachedInputUsdPerMillion ?? null,
    );
  }

  /**
   * Append a per-seller activity snapshot — but only if cumulative totals
   * differ from the most recent stored sample for the agent. Idle sellers
   * therefore never inflate the table; active sellers get a row whenever a
   * new settlement lands. Trending derivations diff snapshots across windows.
   */
  recordSellerActivitySample(input: SellerActivitySnapshotInput): void {
    const latest = this.statements.selectLatestSellerActivity.get(input.agentId);
    if (latest && isSellerActivityDuplicate(latest, input)) return;

    this.statements.insertSellerActivity.run(
      input.agentId,
      input.ts,
      input.totalRequests.toString(),
      input.totalInputTokens.toString(),
      input.totalOutputTokens.toString(),
      input.settlementCount,
    );
  }

  /**
   * One row per (peer, provider, service) summarising pricing volatility over
   * `[since, now]`. `changeCount` counts distinct (input, output) tuples;
   * `firstInput/Output` is the earliest sample inside the window (so % change
   * vs window-start is computable client-side); `latestInput/Output` is the
   * most recent sample, which may be older than the window — that's the
   * point: stable pricing should still surface in the rollup.
   */
  getPriceVolatility(sinceSec: number): PriceVolatilityRow[] {
    return this.statements.selectPriceVolatility.all(sinceSec, sinceSec, sinceSec).map((row) => ({
      peerId: row.peer_id,
      provider: row.provider,
      service: row.service,
      sampleCount: row.sample_count,
      changeCount: row.change_count,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
      firstInputUsdPerMillion: row.first_input,
      firstOutputUsdPerMillion: row.first_output,
      latestInputUsdPerMillion: row.latest_input,
      latestOutputUsdPerMillion: row.latest_output,
    }));
  }

  /**
   * All seller activity snapshots since `sinceSec`, sorted by (agentId, ts)
   * ascending — the shape the trending computation wants. Callers group by
   * agentId in JS to avoid building a window function per agent in SQL.
   */
  getSellerActivitySince(sinceSec: number): SellerActivityRow[] {
    return this.statements.selectSellerActivitySince.all(sinceSec).map(rowToSellerActivity);
  }

  /**
   * Activity rows for trend windows: all rows inside the current 8d window,
   * plus the latest pre-window baseline per agent. `computeTrending` needs
   * "at or before 8d ago"; a plain `WHERE ts >= cutoff` almost never includes
   * an exact boundary sample, so trending boards would otherwise be empty.
   */
  getSellerActivityForTrending(cutoffSec: number): SellerActivityRow[] {
    const recent = this.statements.selectSellerActivitySince.all(cutoffSec);
    const byKey = new Map<string, SellerActivityDbRow>();
    for (const row of recent) byKey.set(`${row.agent_id}:${row.ts}`, row);

    for (const agentId of new Set(recent.map((row) => row.agent_id))) {
      const baseline = this.statements.selectLatestSellerActivityAtOrBefore.get(agentId, cutoffSec);
      if (baseline) byKey.set(`${baseline.agent_id}:${baseline.ts}`, baseline);
    }

    return [...byKey.values()]
      .sort((a, b) => a.agent_id - b.agent_id || a.ts - b.ts)
      .map(rowToSellerActivity);
  }

  /** Closes the underlying DB handle. */
  close(): void {
    this.db.close();
  }
}

// ── private helpers (file-scope, pure) ─────────────────────────────────────

function wouldRegress(
  sample: HistorySample,
  prior: Pick<HistoryRow, 'total_requests' | 'total_input_tokens' | 'total_output_tokens' | 'settlement_count'>,
): boolean {
  return (
    sample.totalRequests < BigInt(prior.total_requests)
    || sample.totalInputTokens < BigInt(prior.total_input_tokens)
    || sample.totalOutputTokens < BigInt(prior.total_output_tokens)
    || sample.settlementCount < prior.settlement_count
  );
}

function isPriceSampleDuplicate(latest: PriceSampleRow, input: PriceSampleInput): boolean {
  const sameInput = latest.input_usd_per_million === input.inputUsdPerMillion;
  const sameOutput = latest.output_usd_per_million === input.outputUsdPerMillion;
  const sameCached = (latest.cached_input_usd_per_million ?? null) === (input.cachedInputUsdPerMillion ?? null);
  return sameInput && sameOutput && sameCached && input.ts - latest.ts < PRICE_SAMPLE_HEARTBEAT_SECONDS;
}

function isSellerActivityDuplicate(
  latest: Omit<SellerActivityDbRow, 'agent_id'>,
  input: SellerActivitySnapshotInput,
): boolean {
  return (
    latest.total_requests === input.totalRequests.toString()
    && latest.total_input_tokens === input.totalInputTokens.toString()
    && latest.total_output_tokens === input.totalOutputTokens.toString()
    && latest.settlement_count === input.settlementCount
  );
}

/**
 * Pure bucketing — exported for unit tests. Groups rows by floor(ts/bucket),
 * then for each bucket emits:
 *   - activePeers: last sample's gauge value (sentinel → null)
 *   - requests:    last cumulative − previous bucket's last cumulative
 *   - settlements: same, for settlement_count
 *   - tokens:      same, for input + output tokens
 *
 * For the very first bucket there's no previous bucket; we use the bucket's
 * own first sample as the baseline.
 */
export function bucketHistoryRows(rows: HistoryRow[], bucketSeconds: number): HistoryPoint[] {
  if (rows.length === 0) return [];

  // Two-pass: collect first/last samples per bucket, then diff across buckets.
  interface Bucket {
    bucketTs: number;
    firstRequests: bigint;
    firstSettlements: number;
    firstTokens: bigint;
    lastRequests: bigint;
    lastSettlements: number;
    lastTokens: bigint;
    lastActivePeers: number;
  }

  const buckets: Bucket[] = [];
  for (const row of rows) {
    const bucketTs = Math.floor(row.ts / bucketSeconds) * bucketSeconds;
    const tokens = BigInt(row.total_input_tokens) + BigInt(row.total_output_tokens);
    const requests = BigInt(row.total_requests);
    const tail = buckets[buckets.length - 1];
    if (tail && tail.bucketTs === bucketTs) {
      tail.lastRequests = requests;
      tail.lastSettlements = row.settlement_count;
      tail.lastTokens = tokens;
      tail.lastActivePeers = row.active_peers;
    } else {
      buckets.push({
        bucketTs,
        firstRequests: requests,
        firstSettlements: row.settlement_count,
        firstTokens: tokens,
        lastRequests: requests,
        lastSettlements: row.settlement_count,
        lastTokens: tokens,
        lastActivePeers: row.active_peers,
      });
    }
  }

  return buckets.map((cur, i) => {
    const prev = i === 0 ? null : buckets[i - 1]!;
    const baseRequests = prev ? prev.lastRequests : cur.firstRequests;
    const baseSettlements = prev ? prev.lastSettlements : cur.firstSettlements;
    const baseTokens = prev ? prev.lastTokens : cur.firstTokens;

    // Cumulative counters are monotonic; clamp to guard against pathological
    // cases (DB reset, manual edit). Sentinel -1 → null so the chart skips
    // drawing the peers line for backfilled buckets.
    return {
      ts: cur.bucketTs,
      activePeers: cur.lastActivePeers === ACTIVE_PEERS_UNKNOWN ? null : cur.lastActivePeers,
      requests: clampNonNegBigint(cur.lastRequests - baseRequests),
      settlements: Math.max(0, cur.lastSettlements - baseSettlements),
      tokens: clampNonNegBigint(cur.lastTokens - baseTokens),
    };
  });
}

function clampNonNegBigint(d: bigint): number {
  return Number(d < 0n ? 0n : d);
}

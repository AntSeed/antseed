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

interface SellerRow {
  total_input_tokens: string;
  total_output_tokens: string;
  total_request_count: string;
  settlement_count: number;
  first_settled_block: number | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
}

interface BuyerOrChannelRow {
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

export class SqliteStore {
  private db: Database.Database;

  // Prepared statements — compiled once in init(), reused on every applyBatch /
  // read call. Re-preparing on every invocation is measurable overhead when
  // catch-up indexing fires applyBatch many times in quick succession.
  private _selectCheckpoint!: Database.Statement<[string, string], { last_block: number; last_block_timestamp: number | null }>;
  private _upsertCheckpoint!: Database.Statement<[string, string, number, number | null]>;
  private _selectSeller!: Database.Statement<[number], SellerRow>;
  private _upsertSeller!: Database.Statement<[number, string, string, string, number, number, number, number | null, number | null, number]>;
  private _selectBuyer!: Database.Statement<[number, string], BuyerOrChannelRow>;
  private _upsertBuyer!: Database.Statement<[number, string, string, string, string, number, number, number]>;
  private _selectChannel!: Database.Statement<[number, string], BuyerOrChannelRow & { buyer: string }>;
  private _upsertChannel!: Database.Statement<[number, string, string, string, string, string, number, number, number]>;
  private _selectSellerTotals!: Database.Statement<[number], SellerTotalsRow>;
  private _selectAllSellerTotals!: Database.Statement<[], SellerTotalsRow>;
  private _countBuyers!: Database.Statement<[number], { c: number }>;
  private _countChannels!: Database.Statement<[number], { c: number }>;
  private _insertHistory!: Database.Statement<[number, number, number, string, string, string, number]>;
  private _selectHistorySince!: Database.Statement<[number], HistoryRow>;
  private _selectEarliestHistoryTs!: Database.Statement<[], { ts: number | null }>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  /** Creates tables if missing and compiles prepared statements. Idempotent. */
  init(): void {
    this.db.exec(`
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
    `);

    this._selectCheckpoint = this.db.prepare(
      'SELECT last_block, last_block_timestamp FROM indexer_checkpoint WHERE chain_id = ? AND contract_address = ?',
    );

    this._upsertCheckpoint = this.db.prepare(
      `INSERT INTO indexer_checkpoint (chain_id, contract_address, last_block, last_block_timestamp)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, contract_address) DO UPDATE SET
         last_block = excluded.last_block,
         last_block_timestamp = excluded.last_block_timestamp`,
    );

    this._selectSeller = this.db.prepare(
      'SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block, first_seen_at, last_seen_at FROM seller_metadata_totals WHERE agent_id = ?',
    );

    this._upsertSeller = this.db.prepare(
      `INSERT OR REPLACE INTO seller_metadata_totals
         (agent_id, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block,
          first_seen_at, last_seen_at, last_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectBuyer = this.db.prepare(
      'SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block FROM seller_buyer_totals WHERE agent_id = ? AND buyer = ?',
    );

    this._upsertBuyer = this.db.prepare(
      `INSERT OR REPLACE INTO seller_buyer_totals
         (agent_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectChannel = this.db.prepare(
      'SELECT buyer, total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block FROM seller_channel_totals WHERE agent_id = ? AND channel_id = ?',
    );

    this._upsertChannel = this.db.prepare(
      `INSERT OR REPLACE INTO seller_channel_totals
         (agent_id, channel_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectSellerTotals = this.db.prepare(
      'SELECT total_request_count, total_input_tokens, total_output_tokens, settlement_count, first_settled_block, last_settled_block, first_seen_at, last_seen_at, last_updated_at FROM seller_metadata_totals WHERE agent_id = ?',
    );

    this._selectAllSellerTotals = this.db.prepare(
      'SELECT total_request_count, total_input_tokens, total_output_tokens, settlement_count, first_settled_block, last_settled_block, first_seen_at, last_seen_at, last_updated_at FROM seller_metadata_totals',
    );

    this._countBuyers = this.db.prepare(
      'SELECT COUNT(*) AS c FROM seller_buyer_totals WHERE agent_id = ?',
    );

    this._countChannels = this.db.prepare(
      'SELECT COUNT(*) AS c FROM seller_channel_totals WHERE agent_id = ?',
    );

    this._insertHistory = this.db.prepare(
      `INSERT OR IGNORE INTO network_history
         (ts, active_peers, seller_count, total_requests,
          total_input_tokens, total_output_tokens, settlement_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectHistorySince = this.db.prepare(
      `SELECT ts, active_peers, seller_count, total_requests,
              total_input_tokens, total_output_tokens, settlement_count
         FROM network_history
        WHERE ts >= ?
        ORDER BY ts ASC`,
    );

    this._selectEarliestHistoryTs = this.db.prepare(
      'SELECT MIN(ts) AS ts FROM network_history',
    );
  }

  /**
   * Earliest history sample timestamp (unix seconds), or null if the table is
   * empty. Used by the backfill driver to decide whether to re-fetch chain
   * events: if we already have history reaching back further than the cutoff,
   * skip the backfill.
   */
  getEarliestHistoryTs(): number | null {
    const row = this._selectEarliestHistoryTs.get();
    return row?.ts ?? null;
  }

  /** Returns last indexed block for (chainId, contractAddress), or null if no checkpoint. */
  getCheckpoint(chainId: string, contractAddress: string): number | null {
    const row = this._selectCheckpoint.get(chainId, contractAddress.toLowerCase());
    return row !== undefined ? row.last_block : null;
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
    this.db.transaction(() => {
      for (const event of events) {
        // uint256 → number narrowing. In practice agentIds are sequential and small,
        // but the ERC-8004 IdentityRegistry is uint256, so guard against a pathological
        // future value that would silently collide or miss the PK lookup.
        if (event.agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
          console.warn(`[store] agentId ${event.agentId} exceeds MAX_SAFE_INTEGER — skipping event`);
          continue;
        }
        const agentId = Number(event.agentId);
        const buyer = event.buyer.toLowerCase();
        const channelId = event.channelId.toLowerCase();
        const now = Math.floor(Date.now() / 1000);

        // ── seller_metadata_totals ───────────────────────────────────
        const existingSeller = this._selectSeller.get(agentId);
        const prevSellerInput = existingSeller ? BigInt(existingSeller.total_input_tokens) : 0n;
        const prevSellerOutput = existingSeller ? BigInt(existingSeller.total_output_tokens) : 0n;
        const prevSellerCount = existingSeller ? BigInt(existingSeller.total_request_count) : 0n;
        const prevSellerSettlements = existingSeller?.settlement_count ?? 0;
        const prevSellerFirstBlock = existingSeller?.first_settled_block ?? null;
        const prevSellerFirstSeen = existingSeller?.first_seen_at ?? null;
        const prevSellerLastSeen = existingSeller?.last_seen_at ?? null;
        const eventTimestamp = blockTimestamps?.get(event.blockNumber) ?? null;
        const firstSeenAt = prevSellerFirstSeen ?? eventTimestamp;
        // Events arrive sorted ascending by (blockNumber, logIndex), so the
        // current event's block is always >= the stored last_seen_at.
        const lastSeenAt = eventTimestamp ?? prevSellerLastSeen;

        this._upsertSeller.run(
          agentId,
          (prevSellerInput + event.inputTokens).toString(),
          (prevSellerOutput + event.outputTokens).toString(),
          (prevSellerCount + event.requestCount).toString(),
          prevSellerSettlements + 1,
          prevSellerFirstBlock ?? event.blockNumber,
          event.blockNumber,
          firstSeenAt,
          lastSeenAt,
          now,
        );

        // ── seller_buyer_totals ──────────────────────────────────────
        const existingBuyer = this._selectBuyer.get(agentId, buyer);
        const prevBuyerInput = existingBuyer ? BigInt(existingBuyer.total_input_tokens) : 0n;
        const prevBuyerOutput = existingBuyer ? BigInt(existingBuyer.total_output_tokens) : 0n;
        const prevBuyerCount = existingBuyer ? BigInt(existingBuyer.total_request_count) : 0n;
        const prevBuyerSettlements = existingBuyer?.settlement_count ?? 0;
        const prevBuyerFirstBlock = existingBuyer?.first_settled_block ?? event.blockNumber;

        this._upsertBuyer.run(
          agentId,
          buyer,
          (prevBuyerInput + event.inputTokens).toString(),
          (prevBuyerOutput + event.outputTokens).toString(),
          (prevBuyerCount + event.requestCount).toString(),
          prevBuyerSettlements + 1,
          prevBuyerFirstBlock,
          event.blockNumber,
        );

        // ── seller_channel_totals ────────────────────────────────────
        const existingChannel = this._selectChannel.get(agentId, channelId);
        const prevChannelInput = existingChannel ? BigInt(existingChannel.total_input_tokens) : 0n;
        const prevChannelOutput = existingChannel ? BigInt(existingChannel.total_output_tokens) : 0n;
        const prevChannelCount = existingChannel ? BigInt(existingChannel.total_request_count) : 0n;
        const prevChannelSettlements = existingChannel?.settlement_count ?? 0;
        const prevChannelFirstBlock = existingChannel?.first_settled_block ?? event.blockNumber;

        this._upsertChannel.run(
          agentId,
          channelId,
          buyer,
          (prevChannelInput + event.inputTokens).toString(),
          (prevChannelOutput + event.outputTokens).toString(),
          (prevChannelCount + event.requestCount).toString(),
          prevChannelSettlements + 1,
          prevChannelFirstBlock,
          event.blockNumber,
        );
      }

      this._upsertCheckpoint.run(
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
    const row = this._selectCheckpoint.get(chainId, contractAddress.toLowerCase());
    if (row === undefined) return null;
    return { lastBlock: row.last_block, lastBlockTimestamp: row.last_block_timestamp };
  }

  /** Returns cumulative totals for a single agentId, or null if never seen. */
  getSellerTotals(agentId: number): SellerTotals | null {
    const row = this._selectSellerTotals.get(agentId);
    if (row === undefined) return null;

    const uniqueBuyers = (this._countBuyers.get(agentId) ?? { c: 0 }).c;
    const uniqueChannels = (this._countChannels.get(agentId) ?? { c: 0 }).c;

    const totalRequests = BigInt(row.total_request_count);
    const avgRequestsPerBuyer =
      uniqueBuyers === 0 ? 0 : Number(totalRequests / BigInt(uniqueBuyers));
    const avgRequestsPerChannel =
      uniqueChannels === 0 ? 0 : Number(totalRequests / BigInt(uniqueChannels));

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
      avgRequestsPerChannel,
      avgRequestsPerBuyer,
      lastUpdatedAt: row.last_updated_at,
    };
  }

  /** Returns cumulative totals across all indexed sellers, including sellers not currently online. */
  getNetworkTotals(): NetworkTotals {
    let totalRequests = 0n;
    let totalInputTokens = 0n;
    let totalOutputTokens = 0n;
    let settlementCount = 0;
    let sellerCount = 0;
    let lastUpdatedAt: number | null = null;

    for (const row of this._selectAllSellerTotals.all()) {
      totalRequests += BigInt(row.total_request_count);
      totalInputTokens += BigInt(row.total_input_tokens);
      totalOutputTokens += BigInt(row.total_output_tokens);
      settlementCount += row.settlement_count;
      sellerCount += 1;
      lastUpdatedAt = Math.max(lastUpdatedAt ?? 0, row.last_updated_at);
    }

    return {
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      settlementCount,
      sellerCount,
      lastUpdatedAt,
    };
  }

  /**
   * Append one history sample. INSERT OR IGNORE — if two writes land in the
   * same second (poll retry, clock jitter), the first wins and the second is
   * silently dropped. The poller cadence is 15 minutes, so collisions are rare
   * enough that overwrite-vs-keep doesn't change any chart.
   */
  recordHistorySample(sample: HistorySample): void {
    this._insertHistory.run(
      sample.ts,
      sample.activePeers,
      sample.sellerCount,
      sample.totalRequests.toString(),
      sample.totalInputTokens.toString(),
      sample.totalOutputTokens.toString(),
      sample.settlementCount,
    );
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
    const since = nowSeconds - rangeSeconds;

    const rows = this._selectHistorySince.all(since);
    const buckets = bucketHistoryRows(rows, bucketSeconds);

    return { range, bucketSeconds, points: buckets };
  }

  /** Closes the underlying DB handle. */
  close(): void {
    this.db.close();
  }
}

/**
 * Pure bucketing — exported for unit tests. Groups rows by floor(ts/bucket),
 * then for each bucket emits:
 *   - activePeers: last sample's gauge value
 *   - requests:    last cumulative − previous bucket's last cumulative
 *   - settlements: same, for settlement_count
 *
 * For the very first bucket there's no previous bucket; we use the bucket's
 * own first sample as the baseline.
 */
export function bucketHistoryRows(rows: HistoryRow[], bucketSeconds: number): HistoryPoint[] {
  if (rows.length === 0) return [];

  interface Acc {
    bucketTs: number;
    firstRequests: bigint;
    firstSettlements: number;
    firstTokens: bigint;
    lastRequests: bigint;
    lastSettlements: number;
    lastTokens: bigint;
    lastActivePeers: number;
  }

  const grouped: Acc[] = [];
  for (const row of rows) {
    const bucketTs = Math.floor(row.ts / bucketSeconds) * bucketSeconds;
    const rowTokens = BigInt(row.total_input_tokens) + BigInt(row.total_output_tokens);
    const tail = grouped[grouped.length - 1];
    if (tail && tail.bucketTs === bucketTs) {
      tail.lastRequests = BigInt(row.total_requests);
      tail.lastSettlements = row.settlement_count;
      tail.lastTokens = rowTokens;
      tail.lastActivePeers = row.active_peers;
    } else {
      grouped.push({
        bucketTs,
        firstRequests: BigInt(row.total_requests),
        firstSettlements: row.settlement_count,
        firstTokens: rowTokens,
        lastRequests: BigInt(row.total_requests),
        lastSettlements: row.settlement_count,
        lastTokens: rowTokens,
        lastActivePeers: row.active_peers,
      });
    }
  }

  const points: HistoryPoint[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const cur = grouped[i]!;
    const prev = i === 0 ? null : grouped[i - 1]!;
    const baselineRequests = prev ? prev.lastRequests : cur.firstRequests;
    const baselineSettlements = prev ? prev.lastSettlements : cur.firstSettlements;
    const baselineTokens = prev ? prev.lastTokens : cur.firstTokens;
    const requestsDelta = cur.lastRequests - baselineRequests;
    const settlementsDelta = cur.lastSettlements - baselineSettlements;
    const tokensDelta = cur.lastTokens - baselineTokens;
    points.push({
      ts: cur.bucketTs,
      // -1 is the backfill sentinel — emit null so the chart skips drawing
      // the peers line for buckets that contain only chain-reconstructed data.
      activePeers: cur.lastActivePeers === ACTIVE_PEERS_UNKNOWN ? null : cur.lastActivePeers,
      // Cumulative counters are monotonic, so deltas should be ≥ 0. Clamp to
      // guard against pathological cases (DB reset, manual edit).
      requests: Number(requestsDelta < 0n ? 0n : requestsDelta),
      settlements: settlementsDelta < 0 ? 0 : settlementsDelta,
      tokens: Number(tokensDelta < 0n ? 0n : tokensDelta),
    });
  }
  return points;
}

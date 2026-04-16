import Database from 'better-sqlite3';
import type { DecodedMetadataRecorded, DecodedChannelSettled } from '@antseed/node';

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

export interface LeaderboardEntry {
  /** agent_id for sellers, buyer address for buyers */
  id: string;
  totalRevenue: string;   // USDC amount as string (bigint)
  totalFees: string;      // platform fees as string (bigint)
  totalInputTokens: string;
  totalOutputTokens: string;
  totalRequests: string;
  settlementCount: number;
}

export type LeaderboardPeriod = 'day' | 'month' | 'all';
export type LeaderboardRole = 'seller' | 'buyer';

interface LeaderboardRow {
  id: string;
  total_revenue: string;
  total_fees: string;
  total_input_tokens: string;
  total_output_tokens: string;
  total_requests: string;
  settlement_count: number;
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
  private _countBuyers!: Database.Statement<[number], { c: number }>;
  private _countChannels!: Database.Statement<[number], { c: number }>;
  private _insertSettlement!: Database.Statement<[number, number, string, number, string, number, string, string, string, string, string, string, string, string]>;
  private _leaderboardSeller!: Database.Statement<[number, number, number], LeaderboardRow>;
  private _leaderboardSellerAll!: Database.Statement<[number], LeaderboardRow>;
  private _leaderboardBuyer!: Database.Statement<[number, number, number], LeaderboardRow>;
  private _leaderboardBuyerAll!: Database.Statement<[number], LeaderboardRow>;

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

      CREATE TABLE IF NOT EXISTS settlement_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        block_number    INTEGER NOT NULL,
        block_timestamp INTEGER NOT NULL,
        tx_hash         TEXT NOT NULL,
        log_index       INTEGER NOT NULL,
        channel_id      TEXT NOT NULL,
        agent_id        INTEGER NOT NULL,
        seller          TEXT NOT NULL,
        buyer           TEXT NOT NULL,
        delta_amount    TEXT NOT NULL,
        cumulative_amount TEXT NOT NULL,
        platform_fee    TEXT NOT NULL,
        input_tokens    TEXT NOT NULL DEFAULT '0',
        output_tokens   TEXT NOT NULL DEFAULT '0',
        request_count   TEXT NOT NULL DEFAULT '0',
        UNIQUE(tx_hash, log_index)
      );

      CREATE INDEX IF NOT EXISTS idx_settlement_events_timestamp
        ON settlement_events (block_timestamp);
      CREATE INDEX IF NOT EXISTS idx_settlement_events_agent
        ON settlement_events (agent_id, block_timestamp);
      CREATE INDEX IF NOT EXISTS idx_settlement_events_buyer
        ON settlement_events (buyer, block_timestamp);
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

    this._countBuyers = this.db.prepare(
      'SELECT COUNT(*) AS c FROM seller_buyer_totals WHERE agent_id = ?',
    );

    this._countChannels = this.db.prepare(
      'SELECT COUNT(*) AS c FROM seller_channel_totals WHERE agent_id = ?',
    );

    this._insertSettlement = this.db.prepare(
      `INSERT OR IGNORE INTO settlement_events
         (block_number, block_timestamp, tx_hash, log_index, channel_id,
          agent_id, seller, buyer, delta_amount, cumulative_amount,
          platform_fee, input_tokens, output_tokens, request_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._leaderboardSeller = this.db.prepare(
      `SELECT
         CAST(agent_id AS TEXT) AS id,
         COALESCE(SUM(CAST(delta_amount AS INTEGER)), 0) AS total_revenue,
         COALESCE(SUM(CAST(platform_fee AS INTEGER)), 0) AS total_fees,
         COALESCE(SUM(CAST(input_tokens AS INTEGER)), 0) AS total_input_tokens,
         COALESCE(SUM(CAST(output_tokens AS INTEGER)), 0) AS total_output_tokens,
         COALESCE(SUM(CAST(request_count AS INTEGER)), 0) AS total_requests,
         COUNT(*) AS settlement_count
       FROM settlement_events
       WHERE block_timestamp >= ? AND block_timestamp < ?
       GROUP BY agent_id
       ORDER BY total_revenue DESC
       LIMIT ?`,
    );

    this._leaderboardSellerAll = this.db.prepare(
      `SELECT
         CAST(agent_id AS TEXT) AS id,
         COALESCE(SUM(CAST(delta_amount AS INTEGER)), 0) AS total_revenue,
         COALESCE(SUM(CAST(platform_fee AS INTEGER)), 0) AS total_fees,
         COALESCE(SUM(CAST(input_tokens AS INTEGER)), 0) AS total_input_tokens,
         COALESCE(SUM(CAST(output_tokens AS INTEGER)), 0) AS total_output_tokens,
         COALESCE(SUM(CAST(request_count AS INTEGER)), 0) AS total_requests,
         COUNT(*) AS settlement_count
       FROM settlement_events
       GROUP BY agent_id
       ORDER BY total_revenue DESC
       LIMIT ?`,
    );

    this._leaderboardBuyer = this.db.prepare(
      `SELECT
         buyer AS id,
         COALESCE(SUM(CAST(delta_amount AS INTEGER)), 0) AS total_revenue,
         COALESCE(SUM(CAST(platform_fee AS INTEGER)), 0) AS total_fees,
         COALESCE(SUM(CAST(input_tokens AS INTEGER)), 0) AS total_input_tokens,
         COALESCE(SUM(CAST(output_tokens AS INTEGER)), 0) AS total_output_tokens,
         COALESCE(SUM(CAST(request_count AS INTEGER)), 0) AS total_requests,
         COUNT(*) AS settlement_count
       FROM settlement_events
       WHERE block_timestamp >= ? AND block_timestamp < ?
       GROUP BY buyer
       ORDER BY total_revenue DESC
       LIMIT ?`,
    );

    this._leaderboardBuyerAll = this.db.prepare(
      `SELECT
         buyer AS id,
         COALESCE(SUM(CAST(delta_amount AS INTEGER)), 0) AS total_revenue,
         COALESCE(SUM(CAST(platform_fee AS INTEGER)), 0) AS total_fees,
         COALESCE(SUM(CAST(input_tokens AS INTEGER)), 0) AS total_input_tokens,
         COALESCE(SUM(CAST(output_tokens AS INTEGER)), 0) AS total_output_tokens,
         COALESCE(SUM(CAST(request_count AS INTEGER)), 0) AS total_requests,
         COUNT(*) AS settlement_count
       FROM settlement_events
       GROUP BY buyer
       ORDER BY total_revenue DESC
       LIMIT ?`,
    );
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

  /**
   * Atomic transaction: inserts settlement events and advances the checkpoint.
   *
   * Each ChannelSettled event is correlated with its MetadataRecorded counterpart
   * (from the same tx) to get token counts. If no matching MetadataRecorded exists
   * (e.g. metadata recording was silently swallowed), token counts default to 0.
   *
   * Events with agentId=0 (unstaked sellers) are stored with agent_id=0 — the
   * leaderboard can filter these out if needed.
   *
   * Uses INSERT OR IGNORE to safely handle re-indexing of already-processed events
   * (e.g. after a reorg rollback that doesn't fully clear old data).
   */
  applySettlementBatch(
    chainId: string,
    contractAddress: string,
    events: DecodedChannelSettled[],
    metadataByTx: Map<string, DecodedMetadataRecorded[]>,
    agentIdBySeller: Map<string, number>,
    newCheckpoint: number,
    blockTimestamps: Map<number, number>,
    newCheckpointTimestamp?: number | null,
  ): void {
    this.db.transaction(() => {
      for (const event of events) {
        const agentId = agentIdBySeller.get(event.seller) ?? 0;
        const blockTs = blockTimestamps.get(event.blockNumber);
        if (blockTs === undefined) {
          console.warn(`[store] missing block timestamp for block ${event.blockNumber} — skipping settlement`);
          continue;
        }

        // Find matching MetadataRecorded from the same tx + channelId
        const txMeta = metadataByTx.get(event.txHash);
        const matched = txMeta?.find(
          (m) => m.channelId.toLowerCase() === event.channelId,
        );

        this._insertSettlement.run(
          event.blockNumber,
          blockTs,
          event.txHash,
          event.logIndex,
          event.channelId,
          agentId,
          event.seller,
          event.buyer,
          event.delta.toString(),
          event.cumulativeAmount.toString(),
          event.platformFee.toString(),
          matched ? matched.inputTokens.toString() : '0',
          matched ? matched.outputTokens.toString() : '0',
          matched ? matched.requestCount.toString() : '0',
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

  /**
   * Returns a ranked leaderboard.
   *
   * @param role    'seller' groups by agent_id, 'buyer' groups by buyer address
   * @param period  'day' | 'month' | 'all'
   * @param date    Reference date for the period window (defaults to now).
   *                For 'day': that calendar day (UTC). For 'month': that calendar month (UTC).
   * @param limit   Max entries to return (default 50)
   */
  getLeaderboard(
    role: LeaderboardRole,
    period: LeaderboardPeriod,
    date?: Date,
    limit = 50,
  ): LeaderboardEntry[] {
    const ref = date ?? new Date();

    let rows: LeaderboardRow[];
    if (period === 'all') {
      rows = role === 'seller'
        ? this._leaderboardSellerAll.all(limit)
        : this._leaderboardBuyerAll.all(limit);
    } else {
      const { from, to } = periodBounds(period, ref);
      rows = role === 'seller'
        ? this._leaderboardSeller.all(from, to, limit)
        : this._leaderboardBuyer.all(from, to, limit);
    }

    return rows.map((r) => ({
      id: r.id,
      totalRevenue: String(r.total_revenue),
      totalFees: String(r.total_fees),
      totalInputTokens: String(r.total_input_tokens),
      totalOutputTokens: String(r.total_output_tokens),
      totalRequests: String(r.total_requests),
      settlementCount: r.settlement_count,
    }));
  }

  /** Closes the underlying DB handle. */
  close(): void {
    this.db.close();
  }
}

/** Returns inclusive-start / exclusive-end unix timestamps for the given period. */
function periodBounds(period: 'day' | 'month', ref: Date): { from: number; to: number } {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  const d = ref.getUTCDate();
  if (period === 'day') {
    const from = Date.UTC(y, m, d) / 1000;
    const to = Date.UTC(y, m, d + 1) / 1000;
    return { from, to };
  }
  // month
  const from = Date.UTC(y, m, 1) / 1000;
  const to = Date.UTC(y, m + 1, 1) / 1000;
  return { from, to };
}

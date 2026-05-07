import Database from 'better-sqlite3';
import type { DecodedMetadataRecorded, DecodedChannelEvent } from '@antseed/node';

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

/** Aggregated activity over a fixed time window (e.g. last 24h, 7d, 30d). */
export interface TimeframeTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  uniqueBuyers: number;
}

/** Per-agent all-time stats — the building block for global rankings. */
export interface SellerAllTimeStats {
  agentId: number;
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  uniqueBuyers: number;
  firstSeenAt: number | null;
}

/** Lifetime counters per seller address derived from AntseedChannels events. */
export interface SellerChannelLifetime {
  reservedCount: number;
  settledCount: number;
  closedCount: number;
  closeRequestedCount: number;
  withdrawnCount: number;
  totalUsdcSettled: bigint;
  firstEventBlock: number | null;
  lastEventBlock: number | null;
  lastUpdatedAt: number;
}

/** Aggregated channel economics per seller address over a fixed window. */
export interface SellerUsdcWindow {
  usdcSettled: bigint;
  settleCount: number;
  closeCount: number;
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

interface SellerChannelLifetimeRow {
  reserved_count: number;
  settled_count: number;
  closed_count: number;
  close_requested_count: number;
  withdrawn_count: number;
  total_usdc_settled: string;
  first_event_block: number | null;
  last_event_block: number | null;
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
  private _selectAllSellerTotals!: Database.Statement<[], SellerTotalsRow>;
  private _countBuyers!: Database.Statement<[number], { c: number }>;
  private _countChannels!: Database.Statement<[number], { c: number }>;
  private _insertSettlementEvent!: Database.Statement<[number, number, number, number, string, string, string, string]>;
  private _selectEventsSince!: Database.Statement<[number], { agent_id: number; input_tokens: string; output_tokens: string; request_count: string; buyer: string | null }>;
  private _selectAllSellersWithId!: Database.Statement<[], { agent_id: number; total_request_count: string; total_input_tokens: string; total_output_tokens: string; settlement_count: number; first_seen_at: number | null }>;
  private _countBuyersByAgent!: Database.Statement<[], { agent_id: number; c: number }>;

  // ── Channel-events plumbing (AntseedChannels lifecycle) ────────────────
  private _insertChannelEvent!: Database.Statement<[
    number, number, number | null, string, string, string, string,
    string | null, string | null, string | null, string | null, string | null,
  ]>;
  private _selectChannelLifetime!: Database.Statement<[string], SellerChannelLifetimeRow>;
  private _upsertChannelLifetime!: Database.Statement<[
    string, number, number, number, number, number, string, number | null, number | null, number,
  ]>;
  private _selectAllChannelLifetime!: Database.Statement<[], SellerChannelLifetimeRow & { seller: string }>;
  private _selectChannelEventsSince!: Database.Statement<[number], {
    seller: string; event_type: string; delta_usdc: string | null;
  }>;

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

      -- Per-event log used to compute "last 24h / 7d / 30d" rollups. One row
      -- per MetadataRecorded event, only inserted when the indexer was able
      -- to fetch the block timestamp (i.e. production runs with rpcUrl set;
      -- unit tests that pass no timestamps produce no rows here, which is
      -- intentional). All-time totals continue to live in seller_metadata_totals.
      CREATE TABLE IF NOT EXISTS seller_settlement_events (
        block_number INTEGER NOT NULL,
        log_index INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        block_timestamp INTEGER NOT NULL,
        input_tokens TEXT NOT NULL,
        output_tokens TEXT NOT NULL,
        request_count TEXT NOT NULL,
        buyer TEXT,
        PRIMARY KEY (block_number, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_settlement_events_agent_ts
        ON seller_settlement_events(agent_id, block_timestamp);
      CREATE INDEX IF NOT EXISTS idx_settlement_events_ts
        ON seller_settlement_events(block_timestamp);

      -- ── AntseedChannels lifecycle ─────────────────────────────────
      -- Per-event log for windowed economic queries (USDC settled in last
      -- 24h/7d/30d). One row per Channels event we care about. Keys mirror
      -- seller_settlement_events: (block, logIndex) is globally unique within
      -- a contract's logs and INSERT OR IGNORE protects against re-runs of an
      -- already-applied range. block_timestamp may be null for tests that don't
      -- pass timestamps; rows without it are excluded from windowed reads.
      CREATE TABLE IF NOT EXISTS channel_events (
        block_number INTEGER NOT NULL,
        log_index INTEGER NOT NULL,
        block_timestamp INTEGER,
        event_type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        buyer TEXT NOT NULL,
        seller TEXT NOT NULL,
        delta_usdc TEXT,
        total_settled TEXT,
        settled_amount TEXT,
        refund TEXT,
        max_amount TEXT,
        PRIMARY KEY (block_number, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_events_seller_ts
        ON channel_events(seller, block_timestamp);
      CREATE INDEX IF NOT EXISTS idx_channel_events_seller_type
        ON channel_events(seller, event_type);

      -- Pre-aggregated lifetime counters per seller address. Updated inside
      -- applyChannelBatch so the all-time read in /stats is one cheap table
      -- scan instead of streaming the full event log on every request.
      CREATE TABLE IF NOT EXISTS seller_channel_lifetime (
        seller TEXT PRIMARY KEY,
        reserved_count INTEGER NOT NULL DEFAULT 0,
        settled_count INTEGER NOT NULL DEFAULT 0,
        closed_count INTEGER NOT NULL DEFAULT 0,
        close_requested_count INTEGER NOT NULL DEFAULT 0,
        withdrawn_count INTEGER NOT NULL DEFAULT 0,
        total_usdc_settled TEXT NOT NULL DEFAULT '0',
        first_event_block INTEGER,
        last_event_block INTEGER,
        last_updated_at INTEGER NOT NULL
      );
    `);

    // Defensive backfill for deployments created before `buyer` was tracked.
    // Older rows keep buyer = NULL and are excluded from windowed uniqueBuyers
    // counts; new events fill it in.
    const eventCols = this.db
      .prepare(`SELECT name FROM pragma_table_info('seller_settlement_events')`)
      .all() as Array<{ name: string }>;
    if (!eventCols.some((c) => c.name === 'buyer')) {
      this.db.exec(`ALTER TABLE seller_settlement_events ADD COLUMN buyer TEXT`);
    }

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

    // INSERT OR IGNORE is defensive — (block_number, log_index) is globally
    // unique within a single contract's logs, but if a previous tick rolled
    // back partway and re-fetched the same range, we don't want to fail the
    // re-application; the row is identical anyway.
    this._insertSettlementEvent = this.db.prepare(
      `INSERT OR IGNORE INTO seller_settlement_events
         (block_number, log_index, agent_id, block_timestamp,
          input_tokens, output_tokens, request_count, buyer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectEventsSince = this.db.prepare(
      'SELECT agent_id, input_tokens, output_tokens, request_count, buyer FROM seller_settlement_events WHERE block_timestamp >= ?',
    );

    this._selectAllSellersWithId = this.db.prepare(
      'SELECT agent_id, total_request_count, total_input_tokens, total_output_tokens, settlement_count, first_seen_at FROM seller_metadata_totals',
    );

    this._countBuyersByAgent = this.db.prepare(
      'SELECT agent_id, COUNT(*) AS c FROM seller_buyer_totals GROUP BY agent_id',
    );

    // ── Channel events ──────────────────────────────────────────
    this._insertChannelEvent = this.db.prepare(
      `INSERT OR IGNORE INTO channel_events
         (block_number, log_index, block_timestamp, event_type, channel_id, buyer, seller,
          delta_usdc, total_settled, settled_amount, refund, max_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectChannelLifetime = this.db.prepare(
      `SELECT reserved_count, settled_count, closed_count, close_requested_count,
              withdrawn_count, total_usdc_settled, first_event_block, last_event_block,
              last_updated_at
       FROM seller_channel_lifetime WHERE seller = ?`,
    );

    this._upsertChannelLifetime = this.db.prepare(
      `INSERT OR REPLACE INTO seller_channel_lifetime
         (seller, reserved_count, settled_count, closed_count, close_requested_count,
          withdrawn_count, total_usdc_settled, first_event_block, last_event_block, last_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this._selectAllChannelLifetime = this.db.prepare(
      `SELECT seller, reserved_count, settled_count, closed_count, close_requested_count,
              withdrawn_count, total_usdc_settled, first_event_block, last_event_block,
              last_updated_at
       FROM seller_channel_lifetime`,
    );

    this._selectChannelEventsSince = this.db.prepare(
      `SELECT seller, event_type, delta_usdc
       FROM channel_events
       WHERE block_timestamp IS NOT NULL AND block_timestamp >= ?`,
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

        // ── seller_settlement_events ─────────────────────────────────
        // Only recorded when we know the on-chain wall-clock for the block.
        // Without a timestamp the row would be excluded from every windowed
        // query anyway, so we skip the write entirely.
        if (eventTimestamp !== null) {
          this._insertSettlementEvent.run(
            event.blockNumber,
            event.logIndex,
            agentId,
            eventTimestamp,
            event.inputTokens.toString(),
            event.outputTokens.toString(),
            event.requestCount.toString(),
            buyer,
          );
        }
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
   * Returns all-time per-agent stats keyed by agentId. Used by the rankings
   * endpoint to sort sellers by lifetime activity (mostUsed.allTime,
   * topVolume.allTime, mostReach, risingStars). Two SQL reads — the metadata
   * roll-up + a GROUP BY on the buyer table — joined in JS by agentId.
   */
  getAllSellerStats(): Map<number, SellerAllTimeStats> {
    const buyerCounts = new Map<number, number>();
    for (const row of this._countBuyersByAgent.all()) {
      buyerCounts.set(row.agent_id, row.c);
    }

    const result = new Map<number, SellerAllTimeStats>();
    for (const row of this._selectAllSellersWithId.all()) {
      result.set(row.agent_id, {
        agentId: row.agent_id,
        totalRequests: BigInt(row.total_request_count),
        totalInputTokens: BigInt(row.total_input_tokens),
        totalOutputTokens: BigInt(row.total_output_tokens),
        settlementCount: row.settlement_count,
        uniqueBuyers: buyerCounts.get(row.agent_id) ?? 0,
        firstSeenAt: row.first_seen_at,
      });
    }
    return result;
  }

  /**
   * Returns per-seller activity for events at or after `cutoffSeconds` (unix
   * epoch seconds). Sums are accumulated in BigInt to preserve full precision
   * for large token counts; SQL SUM on TEXT-encoded bigints would either
   * overflow INT64 or lose precision via REAL.
   *
   * Returns an empty Map if the events table has no matching rows (e.g. fresh
   * deploy before any events flow in, or unit tests that don't pass block
   * timestamps).
   */
  getSellerTotalsSince(cutoffSeconds: number): Map<number, TimeframeTotals> {
    const result = new Map<number, TimeframeTotals>();
    // Track distinct buyers per agent in JS — settling per-window DISTINCT in
    // SQL would need a second query; the row count we iterate here is small.
    const buyersByAgent = new Map<number, Set<string>>();
    for (const row of this._selectEventsSince.iterate(cutoffSeconds)) {
      const existing = result.get(row.agent_id);
      if (existing) {
        existing.totalRequests += BigInt(row.request_count);
        existing.totalInputTokens += BigInt(row.input_tokens);
        existing.totalOutputTokens += BigInt(row.output_tokens);
        existing.settlementCount += 1;
      } else {
        result.set(row.agent_id, {
          totalRequests: BigInt(row.request_count),
          totalInputTokens: BigInt(row.input_tokens),
          totalOutputTokens: BigInt(row.output_tokens),
          settlementCount: 1,
          uniqueBuyers: 0,
        });
      }
      if (row.buyer) {
        let set = buyersByAgent.get(row.agent_id);
        if (!set) {
          set = new Set<string>();
          buyersByAgent.set(row.agent_id, set);
        }
        set.add(row.buyer);
      }
    }
    for (const [agentId, set] of buyersByAgent) {
      const totals = result.get(agentId);
      if (totals) totals.uniqueBuyers = set.size;
    }
    return result;
  }

  /**
   * Atomic transaction for AntseedChannels lifecycle events:
   *   1. Append each event to channel_events (raw log).
   *   2. Bump per-seller counters in seller_channel_lifetime; sum delta_usdc
   *      onto total_usdc_settled for `settled` events.
   *   3. Advance indexer_checkpoint for (chainId, contractAddress).
   *
   * Events MUST be sorted ascending by (blockNumber, logIndex). last_event_block
   * advances to the last event's block; first_event_block is set on first insert
   * and never overwritten.
   *
   * Address resolution to agentId happens at read time in server.ts — this
   * write path stores raw seller addresses to keep the index path RPC-free.
   */
  applyChannelBatch(
    chainId: string,
    contractAddress: string,
    events: DecodedChannelEvent[],
    newCheckpoint: number,
    blockTimestamps?: Map<number, number>,
    newCheckpointTimestamp?: number | null,
  ): void {
    this.db.transaction(() => {
      for (const event of events) {
        const seller = event.seller.toLowerCase();
        const buyer = event.buyer.toLowerCase();
        const channelId = event.channelId.toLowerCase();
        const ts = blockTimestamps?.get(event.blockNumber) ?? null;

        // Per-event row — discriminate by event.type for the type-specific
        // economic fields. The wide-table-with-nulls shape is intentional:
        // five event types with mostly disjoint payloads, queried by seller
        // + window. A normalized split across five tables would make
        // windowed cross-type reads (e.g. "seller's settlements + closes
        // in 7d") need multiple scans.
        let delta: string | null = null;
        let totalSettled: string | null = null;
        let settledAmount: string | null = null;
        let refund: string | null = null;
        let maxAmount: string | null = null;
        switch (event.type) {
          case 'reserved':
            maxAmount = event.maxAmount.toString();
            break;
          case 'settled':
            delta = event.delta.toString();
            totalSettled = event.totalSettled.toString();
            break;
          case 'closed':
            settledAmount = event.settledAmount.toString();
            refund = event.refund.toString();
            break;
          case 'closeRequested':
            // gracePeriodEnd is intentionally not stored — neither v1 reads
            // nor reliability scoring use it. Block timestamp + buyer/seller
            // are the load-bearing fields.
            break;
          case 'withdrawn':
            refund = event.refund.toString();
            break;
        }

        this._insertChannelEvent.run(
          event.blockNumber,
          event.logIndex,
          ts,
          event.type,
          channelId,
          buyer,
          seller,
          delta,
          totalSettled,
          settledAmount,
          refund,
          maxAmount,
        );

        // ── seller_channel_lifetime — pre-aggregated counters ──────
        const existing = this._selectChannelLifetime.get(seller);
        const reservedCount = (existing?.reserved_count ?? 0) + (event.type === 'reserved' ? 1 : 0);
        const settledCount = (existing?.settled_count ?? 0) + (event.type === 'settled' ? 1 : 0);
        const closedCount = (existing?.closed_count ?? 0) + (event.type === 'closed' ? 1 : 0);
        const closeRequestedCount =
          (existing?.close_requested_count ?? 0) + (event.type === 'closeRequested' ? 1 : 0);
        const withdrawnCount =
          (existing?.withdrawn_count ?? 0) + (event.type === 'withdrawn' ? 1 : 0);
        const prevUsdc = existing ? BigInt(existing.total_usdc_settled) : 0n;
        const addedUsdc = event.type === 'settled' ? event.delta : 0n;
        const totalUsdc = prevUsdc + addedUsdc;
        const firstBlock = existing?.first_event_block ?? event.blockNumber;
        const lastBlock = event.blockNumber;
        const now = Math.floor(Date.now() / 1000);

        this._upsertChannelLifetime.run(
          seller,
          reservedCount,
          settledCount,
          closedCount,
          closeRequestedCount,
          withdrawnCount,
          totalUsdc.toString(),
          firstBlock,
          lastBlock,
          now,
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
   * Returns lifetime channel counters for every seller address that has ever
   * been seen in a Channels event. Single SELECT — used to build the
   * `topRevenue` ranking and per-peer `channelLifecycle` enrichment.
   */
  getAllSellerChannelLifetime(): Map<string, SellerChannelLifetime> {
    const result = new Map<string, SellerChannelLifetime>();
    for (const row of this._selectAllChannelLifetime.all()) {
      result.set(row.seller, {
        reservedCount: row.reserved_count,
        settledCount: row.settled_count,
        closedCount: row.closed_count,
        closeRequestedCount: row.close_requested_count,
        withdrawnCount: row.withdrawn_count,
        totalUsdcSettled: BigInt(row.total_usdc_settled),
        firstEventBlock: row.first_event_block,
        lastEventBlock: row.last_event_block,
        lastUpdatedAt: row.last_updated_at,
      });
    }
    return result;
  }

  /**
   * Returns per-seller windowed channel economics for events at or after
   * `cutoffSeconds`. Mirrors `getSellerTotalsSince` — TEXT-encoded uint128 deltas
   * accumulated as BigInt in JS for full precision.
   */
  getSellerUsdcSince(cutoffSeconds: number): Map<string, SellerUsdcWindow> {
    const result = new Map<string, SellerUsdcWindow>();
    for (const row of this._selectChannelEventsSince.iterate(cutoffSeconds)) {
      let entry = result.get(row.seller);
      if (!entry) {
        entry = { usdcSettled: 0n, settleCount: 0, closeCount: 0 };
        result.set(row.seller, entry);
      }
      if (row.event_type === 'settled') {
        entry.settleCount += 1;
        if (row.delta_usdc) entry.usdcSettled += BigInt(row.delta_usdc);
      } else if (row.event_type === 'closed') {
        entry.closeCount += 1;
      }
    }
    return result;
  }

  /** Closes the underlying DB handle. */
  close(): void {
    this.db.close();
  }
}

import Database from 'better-sqlite3';
import type { DecodedMetadataRecorded } from '@antseed/node';

export interface SellerTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  settlementCount: number;
  firstSettledBlock: number;
  lastSettledBlock: number;
  uniqueBuyers: number;
  uniqueChannels: number;
  avgRequestsPerChannel: number;
  avgRequestsPerBuyer: number;
  lastUpdatedAt: number;
}

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  /** Creates tables if missing. Idempotent. */
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
        PRIMARY KEY (chain_id, contract_address)
      );
    `);
  }

  /** Returns last indexed block for (chainId, contractAddress), or null if no checkpoint. */
  getCheckpoint(chainId: string, contractAddress: string): number | null {
    const row = this.db
      .prepare<[string, string], { last_block: number }>(
        'SELECT last_block FROM indexer_checkpoint WHERE chain_id = ? AND contract_address = ?',
      )
      .get(chainId, contractAddress.toLowerCase());

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
  ): void {
    const selectSeller = this.db.prepare<[number], {
      total_input_tokens: string;
      total_output_tokens: string;
      total_request_count: string;
      settlement_count: number;
      first_settled_block: number | null;
    }>(
      'SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block FROM seller_metadata_totals WHERE agent_id = ?',
    );

    const upsertSeller = this.db.prepare<[number, string, string, string, number, number, number, number]>(
      `INSERT OR REPLACE INTO seller_metadata_totals
         (agent_id, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block, last_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const selectBuyer = this.db.prepare<[number, string], {
      total_input_tokens: string;
      total_output_tokens: string;
      total_request_count: string;
      settlement_count: number;
      first_settled_block: number;
    }>(
      'SELECT total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block FROM seller_buyer_totals WHERE agent_id = ? AND buyer = ?',
    );

    const upsertBuyer = this.db.prepare<[number, string, string, string, string, number, number, number]>(
      `INSERT OR REPLACE INTO seller_buyer_totals
         (agent_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const selectChannel = this.db.prepare<[number, string], {
      buyer: string;
      total_input_tokens: string;
      total_output_tokens: string;
      total_request_count: string;
      settlement_count: number;
      first_settled_block: number;
    }>(
      'SELECT buyer, total_input_tokens, total_output_tokens, total_request_count, settlement_count, first_settled_block FROM seller_channel_totals WHERE agent_id = ? AND channel_id = ?',
    );

    const upsertChannel = this.db.prepare<[number, string, string, string, string, string, number, number, number]>(
      `INSERT OR REPLACE INTO seller_channel_totals
         (agent_id, channel_id, buyer, total_input_tokens, total_output_tokens, total_request_count,
          settlement_count, first_settled_block, last_settled_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const upsertCheckpoint = this.db.prepare<[string, string, number]>(
      `INSERT INTO indexer_checkpoint (chain_id, contract_address, last_block)
       VALUES (?, ?, ?)
       ON CONFLICT(chain_id, contract_address) DO UPDATE SET last_block = excluded.last_block`,
    );

    this.db.transaction(() => {
      for (const event of events) {
        const agentId = Number(event.agentId);
        const buyer = event.buyer.toLowerCase();
        const channelId = event.channelId.toLowerCase();
        const now = Math.floor(Date.now() / 1000);

        // ── seller_metadata_totals ───────────────────────────────────
        const existingSeller = selectSeller.get(agentId);
        const prevSellerInput = existingSeller ? BigInt(existingSeller.total_input_tokens) : 0n;
        const prevSellerOutput = existingSeller ? BigInt(existingSeller.total_output_tokens) : 0n;
        const prevSellerCount = existingSeller ? BigInt(existingSeller.total_request_count) : 0n;
        const prevSellerSettlements = existingSeller?.settlement_count ?? 0;
        const prevSellerFirstBlock = existingSeller?.first_settled_block ?? null;

        upsertSeller.run(
          agentId,
          (prevSellerInput + event.inputTokens).toString(),
          (prevSellerOutput + event.outputTokens).toString(),
          (prevSellerCount + event.requestCount).toString(),
          prevSellerSettlements + 1,
          prevSellerFirstBlock ?? event.blockNumber,
          event.blockNumber,
          now,
        );

        // ── seller_buyer_totals ──────────────────────────────────────
        const existingBuyer = selectBuyer.get(agentId, buyer);
        const prevBuyerInput = existingBuyer ? BigInt(existingBuyer.total_input_tokens) : 0n;
        const prevBuyerOutput = existingBuyer ? BigInt(existingBuyer.total_output_tokens) : 0n;
        const prevBuyerCount = existingBuyer ? BigInt(existingBuyer.total_request_count) : 0n;
        const prevBuyerSettlements = existingBuyer?.settlement_count ?? 0;
        const prevBuyerFirstBlock = existingBuyer?.first_settled_block ?? event.blockNumber;

        upsertBuyer.run(
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
        const existingChannel = selectChannel.get(agentId, channelId);
        const prevChannelInput = existingChannel ? BigInt(existingChannel.total_input_tokens) : 0n;
        const prevChannelOutput = existingChannel ? BigInt(existingChannel.total_output_tokens) : 0n;
        const prevChannelCount = existingChannel ? BigInt(existingChannel.total_request_count) : 0n;
        const prevChannelSettlements = existingChannel?.settlement_count ?? 0;
        const prevChannelFirstBlock = existingChannel?.first_settled_block ?? event.blockNumber;

        upsertChannel.run(
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

      upsertCheckpoint.run(chainId, contractAddress.toLowerCase(), newCheckpoint);
    })();
  }

  /** Returns cumulative totals for a single agentId, or null if never seen. */
  getSellerTotals(agentId: number): SellerTotals | null {
    const row = this.db
      .prepare<[number], {
        total_request_count: string;
        total_input_tokens: string;
        total_output_tokens: string;
        settlement_count: number;
        first_settled_block: number | null;
        last_settled_block: number | null;
        last_updated_at: number;
      }>(
        'SELECT total_request_count, total_input_tokens, total_output_tokens, settlement_count, first_settled_block, last_settled_block, last_updated_at FROM seller_metadata_totals WHERE agent_id = ?',
      )
      .get(agentId);

    if (row === undefined) return null;

    const uniqueBuyers = (
      this.db
        .prepare<[number], { c: number }>(
          'SELECT COUNT(*) AS c FROM seller_buyer_totals WHERE agent_id = ?',
        )
        .get(agentId) ?? { c: 0 }
    ).c;

    const uniqueChannels = (
      this.db
        .prepare<[number], { c: number }>(
          'SELECT COUNT(*) AS c FROM seller_channel_totals WHERE agent_id = ?',
        )
        .get(agentId) ?? { c: 0 }
    ).c;

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
      uniqueBuyers,
      uniqueChannels,
      avgRequestsPerChannel,
      avgRequestsPerBuyer,
      lastUpdatedAt: row.last_updated_at,
    };
  }

  /** Closes the underlying DB handle. */
  close(): void {
    this.db.close();
  }
}

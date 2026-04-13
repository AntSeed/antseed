import Database from 'better-sqlite3';
import type { DecodedMetadataRecorded } from '@antseed/node';

export interface SellerTotals {
  totalRequests: bigint;
  totalInputTokens: bigint;
  totalOutputTokens: bigint;
  lastUpdatedAt: number; // unix seconds
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
        last_updated_at INTEGER NOT NULL
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
   *   1. For each event, upsert seller_metadata_totals (add deltas to existing row).
   *   2. Advance indexer_checkpoint.last_block = newCheckpoint for this (chainId, contractAddress).
   * If any step throws, the transaction is rolled back — next tick re-fetches the same range.
   */
  applyBatch(
    chainId: string,
    contractAddress: string,
    events: DecodedMetadataRecorded[],
    newCheckpoint: number,
  ): void {
    const selectRow = this.db.prepare<[number], {
      total_input_tokens: string;
      total_output_tokens: string;
      total_request_count: string;
    }>(
      'SELECT total_input_tokens, total_output_tokens, total_request_count FROM seller_metadata_totals WHERE agent_id = ?',
    );

    const upsertRow = this.db.prepare<[number, string, string, string, number]>(
      `INSERT OR REPLACE INTO seller_metadata_totals
         (agent_id, total_input_tokens, total_output_tokens, total_request_count, last_updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const upsertCheckpoint = this.db.prepare<[string, string, number]>(
      `INSERT INTO indexer_checkpoint (chain_id, contract_address, last_block)
       VALUES (?, ?, ?)
       ON CONFLICT(chain_id, contract_address) DO UPDATE SET last_block = excluded.last_block`,
    );

    this.db.transaction(() => {
      for (const event of events) {
        const agentId = Number(event.agentId);
        const now = Math.floor(Date.now() / 1000);

        const existing = selectRow.get(agentId);

        const prevInput = existing ? BigInt(existing.total_input_tokens) : 0n;
        const prevOutput = existing ? BigInt(existing.total_output_tokens) : 0n;
        const prevCount = existing ? BigInt(existing.total_request_count) : 0n;

        const newInput = prevInput + event.inputTokens;
        const newOutput = prevOutput + event.outputTokens;
        const newCount = prevCount + event.requestCount;

        upsertRow.run(agentId, newInput.toString(), newOutput.toString(), newCount.toString(), now);
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
        last_updated_at: number;
      }>(
        'SELECT total_request_count, total_input_tokens, total_output_tokens, last_updated_at FROM seller_metadata_totals WHERE agent_id = ?',
      )
      .get(agentId);

    if (row === undefined) return null;

    return {
      totalRequests: BigInt(row.total_request_count),
      totalInputTokens: BigInt(row.total_input_tokens),
      totalOutputTokens: BigInt(row.total_output_tokens),
      lastUpdatedAt: row.last_updated_at,
    };
  }

  /** Closes the underlying DB handle. */
  close(): void {
    this.db.close();
  }
}

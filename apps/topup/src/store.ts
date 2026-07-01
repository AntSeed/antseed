import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type TopupState =
  | 'settling'
  | 'settled'
  | 'depositing'
  | 'deposited'
  | 'refunding'
  | 'refunded'
  | 'failed'
  | 'needs_review';

export interface TopupRow {
  id: string;
  state: TopupState;
  buyer: string;
  payer: string;
  network: string;
  /** Amount the payer signed (USDC base units, decimal string). */
  grossAmount: string;
  /** Amount actually credited to the relayer after facilitator fees. */
  netAmount: string | null;
  authNonce: string;
  authValidBefore: number;
  signature: string;
  /** Original payload/requirements so an interrupted settlement can be retried. */
  payloadJson: string;
  requirementsJson: string;
  /** Block floor for recovery log scans. */
  startBlock: number;
  settleTx: string | null;
  settleBlock: number | null;
  depositTx: string | null;
  refundTx: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type TopupInsert = Omit<
  TopupRow,
  'netAmount' | 'settleTx' | 'settleBlock' | 'depositTx' | 'refundTx' | 'error' | 'createdAt' | 'updatedAt'
>;

export type TopupPatch = Partial<
  Pick<TopupRow, 'state' | 'netAmount' | 'settleTx' | 'settleBlock' | 'depositTx' | 'refundTx' | 'error'>
>;

interface DbRow {
  id: string;
  state: string;
  buyer: string;
  payer: string;
  network: string;
  gross_amount: string;
  net_amount: string | null;
  auth_nonce: string;
  auth_valid_before: number;
  signature: string;
  payload_json: string;
  requirements_json: string;
  start_block: number;
  settle_tx: string | null;
  settle_block: number | null;
  deposit_tx: string | null;
  refund_tx: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const PATCH_COLUMNS: Record<keyof TopupPatch, string> = {
  state: 'state',
  netAmount: 'net_amount',
  settleTx: 'settle_tx',
  settleBlock: 'settle_block',
  depositTx: 'deposit_tx',
  refundTx: 'refund_tx',
  error: 'error',
};

function toRow(row: DbRow): TopupRow {
  return {
    id: row.id,
    state: row.state as TopupState,
    buyer: row.buyer,
    payer: row.payer,
    network: row.network,
    grossAmount: row.gross_amount,
    netAmount: row.net_amount,
    authNonce: row.auth_nonce,
    authValidBefore: row.auth_valid_before,
    signature: row.signature,
    payloadJson: row.payload_json,
    requirementsJson: row.requirements_json,
    startBlock: row.start_block,
    settleTx: row.settle_tx,
    settleBlock: row.settle_block,
    depositTx: row.deposit_tx,
    refundTx: row.refund_tx,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TopupStore {
  private readonly _db: Database.Database;

  /** @param file SQLite path, or ':memory:' for tests. */
  constructor(file: string) {
    if (file !== ':memory:') {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    this._db = new Database(file);
    this._db.pragma('journal_mode = WAL');
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS topups (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        buyer TEXT NOT NULL,
        payer TEXT NOT NULL,
        network TEXT NOT NULL,
        gross_amount TEXT NOT NULL,
        net_amount TEXT,
        auth_nonce TEXT NOT NULL,
        auth_valid_before INTEGER NOT NULL,
        signature TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        requirements_json TEXT NOT NULL,
        start_block INTEGER NOT NULL,
        settle_tx TEXT,
        settle_block INTEGER,
        deposit_tx TEXT,
        refund_tx TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_topups_state ON topups(state);
    `);
  }

  insert(row: TopupInsert): TopupRow {
    const now = Date.now();
    this._db.prepare(`
      INSERT INTO topups (
        id, state, buyer, payer, network, gross_amount, auth_nonce, auth_valid_before,
        signature, payload_json, requirements_json, start_block, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.state, row.buyer, row.payer, row.network, row.grossAmount,
      row.authNonce, row.authValidBefore, row.signature, row.payloadJson,
      row.requirementsJson, row.startBlock, now, now,
    );
    return this.get(row.id)!;
  }

  get(id: string): TopupRow | null {
    const row = this._db.prepare('SELECT * FROM topups WHERE id = ?').get(id) as DbRow | undefined;
    return row ? toRow(row) : null;
  }

  update(id: string, patch: TopupPatch): TopupRow {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof TopupPatch, string]>) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key]);
      }
    }
    sets.push('updated_at = ?');
    values.push(Date.now(), id);
    const result = this._db.prepare(`UPDATE topups SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) throw new Error(`topup ${id} not found`);
    return this.get(id)!;
  }

  listByStates(states: TopupState[]): TopupRow[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    const rows = this._db
      .prepare(`SELECT * FROM topups WHERE state IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...states) as DbRow[];
    return rows.map(toRow);
  }

  close(): void {
    this._db.close();
  }
}

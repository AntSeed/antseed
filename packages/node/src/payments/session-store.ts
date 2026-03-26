import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_STATUS = {
  ACTIVE: 'active',
  SETTLED: 'settled',
  TIMEOUT: 'timeout',
  GHOST: 'ghost',
} as const;

export interface StoredSession {
  sessionId: string;
  peerId: string;
  role: 'buyer' | 'seller';
  sellerEvmAddr: string;
  buyerEvmAddr: string;
  nonce: number;
  authMax: string;          // bigint stored as string
  deadline: number;
  previousSessionId: string;
  previousConsumption: string; // bigint as string
  tokensDelivered: string;    // bigint as string
  requestCount: number;
  reservedAt: number;
  settledAt: number | null;
  settledAmount: string | null; // bigint as string
  status: 'active' | 'settled' | 'timeout' | 'ghost';
  latestBuyerSig: string | null;
  latestMetadataAuthSig: string | null;
  latestMetadata: string | null;       // hex-encoded
  createdAt: number;
  updatedAt: number;
}

export interface StoredReceipt {
  id?: number;
  sessionId: string;
  runningTotal: string;       // bigint as string
  requestCount: number;
  responseHash: string;
  sellerSig: string;
  buyerAckSig: string | null;
  createdAt: number;
}

export class SessionStore {
  private _db: Database.Database;

  // ── Cached prepared statements (compiled once, reused every call) ──
  /** Cached transaction function for updateDeliveredAndInsertReceipt (compiled once). */
  private readonly _updateDeliveredAndInsertReceiptTxn: (
    sessionId: string,
    tokens: string,
    requestCount: number,
    receipt: Omit<StoredReceipt, 'id'>,
  ) => void;

  private readonly _stmts: {
    upsert: Database.Statement;
    getById: Database.Statement;
    getActiveByPeer: Database.Statement;
    getLatestByPeer: Database.Statement;
    updateStatusWithAmount: Database.Statement;
    updateStatus: Database.Statement;
    updateTokens: Database.Statement;
    getMaxNonce: Database.Statement;
    listAll: Database.Statement;
    getTimedOut: Database.Statement;
    insertReceipt: Database.Statement;
    getReceipts: Database.Statement;
    updateReceiptAck: Database.Statement;
    getActiveSessions: Database.Statement;
  };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this._db = new Database(join(dataDir, 'sessions.db'));
    this._db.pragma('journal_mode = WAL');
    this._createTables();
    this._stmts = this._prepareStatements();
    this._updateDeliveredAndInsertReceiptTxn = this._db.transaction(
      (sessionId: string, tokens: string, requestCount: number, receipt: Omit<StoredReceipt, 'id'>) => {
        this.updateTokensDelivered(sessionId, tokens, requestCount);
        this.insertReceipt(receipt);
      },
    );
  }

  private _createTables(): void {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS payment_sessions (
        session_id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        role TEXT NOT NULL,
        seller_evm_addr TEXT NOT NULL,
        buyer_evm_addr TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        auth_max TEXT NOT NULL,
        deadline INTEGER NOT NULL,
        previous_session_id TEXT NOT NULL,
        previous_consumption TEXT NOT NULL,
        tokens_delivered TEXT NOT NULL DEFAULT '0',
        request_count INTEGER NOT NULL DEFAULT 0,
        reserved_at INTEGER NOT NULL,
        settled_at INTEGER,
        settled_amount TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        latest_buyer_sig TEXT,
        latest_metadata_auth_sig TEXT,
        latest_metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_peer_role_status ON payment_sessions(peer_id, role, status);
      CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON payment_sessions(status, updated_at);

      CREATE TABLE IF NOT EXISTS payment_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        running_total TEXT NOT NULL,
        request_count INTEGER NOT NULL,
        response_hash TEXT NOT NULL,
        seller_sig TEXT NOT NULL,
        buyer_ack_sig TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES payment_sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_receipts_session ON payment_receipts(session_id);
    `);
  }

  private _prepareStatements() {
    return {
      upsert: this._db.prepare(`
        INSERT INTO payment_sessions (
          session_id, peer_id, role, seller_evm_addr, buyer_evm_addr,
          nonce, auth_max, deadline, previous_session_id, previous_consumption,
          tokens_delivered, request_count, reserved_at, settled_at, settled_amount,
          status, latest_buyer_sig, latest_metadata_auth_sig, latest_metadata,
          created_at, updated_at
        ) VALUES (
          @sessionId, @peerId, @role, @sellerEvmAddr, @buyerEvmAddr,
          @nonce, @authMax, @deadline, @previousSessionId, @previousConsumption,
          @tokensDelivered, @requestCount, @reservedAt, @settledAt, @settledAmount,
          @status, @latestBuyerSig, @latestMetadataAuthSig, @latestMetadata,
          @createdAt, @updatedAt
        )
        ON CONFLICT(session_id) DO UPDATE SET
          auth_max = @authMax,
          tokens_delivered = @tokensDelivered,
          request_count = @requestCount,
          settled_at = @settledAt,
          settled_amount = @settledAmount,
          status = @status,
          latest_buyer_sig = @latestBuyerSig,
          latest_metadata_auth_sig = @latestMetadataAuthSig,
          latest_metadata = @latestMetadata,
          updated_at = @updatedAt
      `),
      getById: this._db.prepare(
        'SELECT * FROM payment_sessions WHERE session_id = ?',
      ),
      getActiveByPeer: this._db.prepare(
        'SELECT * FROM payment_sessions WHERE peer_id = ? AND role = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      ),
      getLatestByPeer: this._db.prepare(
        'SELECT * FROM payment_sessions WHERE peer_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1',
      ),
      updateStatusWithAmount: this._db.prepare(
        'UPDATE payment_sessions SET status = ?, settled_at = ?, settled_amount = ?, updated_at = ? WHERE session_id = ?',
      ),
      updateStatus: this._db.prepare(
        'UPDATE payment_sessions SET status = ?, updated_at = ? WHERE session_id = ?',
      ),
      updateTokens: this._db.prepare(
        'UPDATE payment_sessions SET tokens_delivered = ?, request_count = ?, updated_at = ? WHERE session_id = ?',
      ),
      getMaxNonce: this._db.prepare(
        'SELECT MAX(nonce) as max_nonce FROM payment_sessions WHERE role = ?',
      ),
      listAll: this._db.prepare(
        'SELECT * FROM payment_sessions ORDER BY updated_at DESC LIMIT ?',
      ),
      getTimedOut: this._db.prepare(
        'SELECT * FROM payment_sessions WHERE status = ? AND updated_at < ? ORDER BY updated_at LIMIT 100',
      ),
      insertReceipt: this._db.prepare(`
        INSERT INTO payment_receipts (
          session_id, running_total, request_count, response_hash,
          seller_sig, buyer_ack_sig, created_at
        ) VALUES (
          @sessionId, @runningTotal, @requestCount, @responseHash,
          @sellerSig, @buyerAckSig, @createdAt
        )
      `),
      getReceipts: this._db.prepare(
        'SELECT * FROM payment_receipts WHERE session_id = ? ORDER BY created_at',
      ),
      updateReceiptAck: this._db.prepare(
        'UPDATE payment_receipts SET buyer_ack_sig = ? WHERE session_id = ? AND running_total = ? AND request_count = ?',
      ),
      getActiveSessions: this._db.prepare(
        'SELECT * FROM payment_sessions WHERE role = ? AND status = ? ORDER BY created_at DESC',
      ),
    };
  }

  // ── Session CRUD ──────────────────────────────────────────────

  upsertSession(session: StoredSession): void {
    this._stmts.upsert.run({
      sessionId: session.sessionId,
      peerId: session.peerId,
      role: session.role,
      sellerEvmAddr: session.sellerEvmAddr,
      buyerEvmAddr: session.buyerEvmAddr,
      nonce: session.nonce,
      authMax: session.authMax,
      deadline: session.deadline,
      previousSessionId: session.previousSessionId,
      previousConsumption: session.previousConsumption,
      tokensDelivered: session.tokensDelivered,
      requestCount: session.requestCount,
      reservedAt: session.reservedAt,
      settledAt: session.settledAt,
      settledAmount: session.settledAmount,
      status: session.status,
      latestBuyerSig: session.latestBuyerSig ?? null,
      latestMetadataAuthSig: session.latestMetadataAuthSig ?? null,
      latestMetadata: session.latestMetadata ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  }

  getSession(sessionId: string): StoredSession | null {
    const row = this._stmts.getById.get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  getActiveSessionByPeer(peerId: string, role: string): StoredSession | null {
    const row = this._stmts.getActiveByPeer.get(peerId, role, SESSION_STATUS.ACTIVE) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  getLatestSession(peerId: string, role: string): StoredSession | null {
    const row = this._stmts.getLatestByPeer.get(peerId, role) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  updateSessionStatus(sessionId: string, status: string, settledAmount?: string): void {
    const now = Date.now();
    if (settledAmount !== undefined) {
      this._stmts.updateStatusWithAmount.run(status, now, settledAmount, now, sessionId);
    } else {
      this._stmts.updateStatus.run(status, now, sessionId);
    }
  }

  updateTokensDelivered(sessionId: string, tokens: string, requestCount: number): void {
    this._stmts.updateTokens.run(tokens, requestCount, Date.now(), sessionId);
  }

  getMaxNonce(role: string): number {
    const row = this._stmts.getMaxNonce.get(role) as { max_nonce: number | null } | undefined;
    return row?.max_nonce ?? 0;
  }

  /** List all sessions ordered by most recent first. */
  listAllSessions(limit = 100): StoredSession[] {
    const rows = this._stmts.listAll.all(limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Get all active sessions for a given role (buyer or seller). */
  getActiveSessions(role: string): StoredSession[] {
    const rows = this._stmts.getActiveSessions.all(role, SESSION_STATUS.ACTIVE) as SessionRow[];
    return rows.map(rowToSession);
  }

  // ── Timeout queries ───────────────────────────────────────────

  getTimedOutSessions(timeoutSeconds: number): StoredSession[] {
    const cutoff = Date.now() - timeoutSeconds * 1000;
    const rows = this._stmts.getTimedOut.all(SESSION_STATUS.ACTIVE, cutoff) as SessionRow[];
    return rows.map(rowToSession);
  }

  // ── Receipt CRUD ──────────────────────────────────────────────

  insertReceipt(receipt: Omit<StoredReceipt, 'id'>): void {
    this._stmts.insertReceipt.run({
      sessionId: receipt.sessionId,
      runningTotal: receipt.runningTotal,
      requestCount: receipt.requestCount,
      responseHash: receipt.responseHash,
      sellerSig: receipt.sellerSig,
      buyerAckSig: receipt.buyerAckSig,
      createdAt: receipt.createdAt,
    });
  }

  getReceipts(sessionId: string): StoredReceipt[] {
    const rows = this._stmts.getReceipts.all(sessionId) as ReceiptRow[];
    return rows.map(rowToReceipt);
  }

  /** Atomically update tokens delivered and insert receipt in a single transaction. */
  updateDeliveredAndInsertReceipt(
    sessionId: string,
    tokens: string,
    requestCount: number,
    receipt: Omit<StoredReceipt, 'id'>,
  ): void {
    this._updateDeliveredAndInsertReceiptTxn(sessionId, tokens, requestCount, receipt);
  }

  /** Update receipt ack directly by composite key (no load-all-then-filter). */
  updateReceiptAck(sessionId: string, runningTotal: string, requestCount: number, buyerAckSig: string): void {
    this._stmts.updateReceiptAck.run(buyerAckSig, sessionId, runningTotal, requestCount);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    this._db.close();
  }
}

// ── Row types ─────────────────────────────────────────────────

interface SessionRow {
  session_id: string;
  peer_id: string;
  role: string;
  seller_evm_addr: string;
  buyer_evm_addr: string;
  nonce: number;
  auth_max: string;
  deadline: number;
  previous_session_id: string;
  previous_consumption: string;
  tokens_delivered: string;
  request_count: number;
  reserved_at: number;
  settled_at: number | null;
  settled_amount: string | null;
  status: string;
  latest_buyer_sig: string | null;
  latest_metadata_auth_sig: string | null;
  latest_metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface ReceiptRow {
  id: number;
  session_id: string;
  running_total: string;
  request_count: number;
  response_hash: string;
  seller_sig: string;
  buyer_ack_sig: string | null;
  created_at: number;
}

function rowToSession(row: SessionRow): StoredSession {
  return {
    sessionId: row.session_id,
    peerId: row.peer_id,
    role: row.role as 'buyer' | 'seller',
    sellerEvmAddr: row.seller_evm_addr,
    buyerEvmAddr: row.buyer_evm_addr,
    nonce: row.nonce,
    authMax: row.auth_max,
    deadline: row.deadline,
    previousSessionId: row.previous_session_id,
    previousConsumption: row.previous_consumption,
    tokensDelivered: row.tokens_delivered,
    requestCount: row.request_count,
    reservedAt: row.reserved_at,
    settledAt: row.settled_at,
    settledAmount: row.settled_amount,
    status: row.status as StoredSession['status'],
    latestBuyerSig: row.latest_buyer_sig,
    latestMetadataAuthSig: row.latest_metadata_auth_sig,
    latestMetadata: row.latest_metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReceipt(row: ReceiptRow): StoredReceipt {
  return {
    id: row.id,
    sessionId: row.session_id,
    runningTotal: row.running_total,
    requestCount: row.request_count,
    responseHash: row.response_hash,
    sellerSig: row.seller_sig,
    buyerAckSig: row.buyer_ack_sig,
    createdAt: row.created_at,
  };
}

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '../storage/migrate.js';
import { channelMigrations } from '../storage/migrations/channels/index.js';

export const CHANNEL_STATUS = {
  ACTIVE: 'active',
  SETTLED: 'settled',
  TIMEOUT: 'timeout',
  GHOST: 'ghost',
} as const;

export interface StoredChannel {
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
  latestSpendingAuthSig: string | null;
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

export class ChannelStore {
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
    getActiveByPeerAndBuyer: Database.Statement;
    getLatestByPeer: Database.Statement;
    getLatestByPeerAndBuyer: Database.Statement;
    updateStatusWithAmount: Database.Statement;
    updateStatus: Database.Statement;
    updateTokens: Database.Statement;
    getMaxNonce: Database.Statement;
    listAll: Database.Statement;
    getTimedOut: Database.Statement;
    insertReceipt: Database.Statement;
    getReceipts: Database.Statement;
    updateReceiptAck: Database.Statement;
    getActiveChannels: Database.Statement;
    getActiveChannelsByBuyer: Database.Statement;
    getTotalsByPeerAndBuyer: Database.Statement;
  };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this._db = new Database(join(dataDir, 'sessions.db'));
    this._db.pragma('journal_mode = WAL');
    runMigrations(this._db, channelMigrations);
    this._stmts = this._prepareStatements();
    this._updateDeliveredAndInsertReceiptTxn = this._db.transaction(
      (sessionId: string, tokens: string, requestCount: number, receipt: Omit<StoredReceipt, 'id'>) => {
        this.updateTokensDelivered(sessionId, tokens, requestCount);
        this.insertReceipt(receipt);
      },
    );
  }

  private _prepareStatements() {
    return {
      upsert: this._db.prepare(`
        INSERT INTO payment_channels (
          session_id, peer_id, role, seller_evm_addr, buyer_evm_addr,
          nonce, auth_max, deadline, previous_session_id, previous_consumption,
          tokens_delivered, request_count, reserved_at, settled_at, settled_amount,
          status, latest_buyer_sig, latest_metadata_auth_sig, latest_metadata,
          created_at, updated_at
        ) VALUES (
          @sessionId, @peerId, @role, @sellerEvmAddr, @buyerEvmAddr,
          @nonce, @authMax, @deadline, @previousSessionId, @previousConsumption,
          @tokensDelivered, @requestCount, @reservedAt, @settledAt, @settledAmount,
          @status, @latestBuyerSig, @latestSpendingAuthSig, @latestMetadata,
          @createdAt, @updatedAt
        )
        ON CONFLICT(session_id) DO UPDATE SET
          auth_max = @authMax,
          previous_consumption = @previousConsumption,
          tokens_delivered = @tokensDelivered,
          request_count = @requestCount,
          settled_at = @settledAt,
          settled_amount = @settledAmount,
          status = @status,
          latest_buyer_sig = @latestBuyerSig,
          latest_metadata_auth_sig = @latestSpendingAuthSig,
          latest_metadata = @latestMetadata,
          updated_at = @updatedAt
      `),
      getById: this._db.prepare(
        'SELECT * FROM payment_channels WHERE session_id = ?',
      ),
      getActiveByPeer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      ),
      getActiveByPeerAndBuyer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? AND buyer_evm_addr = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      ),
      getLatestByPeer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1',
      ),
      getLatestByPeerAndBuyer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE peer_id = ? AND role = ? AND buyer_evm_addr = ? ORDER BY created_at DESC LIMIT 1',
      ),
      updateStatusWithAmount: this._db.prepare(
        'UPDATE payment_channels SET status = ?, settled_at = ?, settled_amount = ?, updated_at = ? WHERE session_id = ?',
      ),
      updateStatus: this._db.prepare(
        'UPDATE payment_channels SET status = ?, updated_at = ? WHERE session_id = ?',
      ),
      updateTokens: this._db.prepare(
        'UPDATE payment_channels SET tokens_delivered = ?, request_count = ?, updated_at = ? WHERE session_id = ?',
      ),
      getMaxNonce: this._db.prepare(
        'SELECT MAX(nonce) as max_nonce FROM payment_channels WHERE role = ?',
      ),
      listAll: this._db.prepare(
        'SELECT * FROM payment_channels ORDER BY updated_at DESC LIMIT ?',
      ),
      getTimedOut: this._db.prepare(
        'SELECT * FROM payment_channels WHERE status = ? AND updated_at < ? ORDER BY updated_at LIMIT 100',
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
      getActiveChannels: this._db.prepare(
        'SELECT * FROM payment_channels WHERE role = ? AND status = ? ORDER BY created_at DESC',
      ),
      getActiveChannelsByBuyer: this._db.prepare(
        'SELECT * FROM payment_channels WHERE role = ? AND buyer_evm_addr = ? AND status = ? ORDER BY created_at DESC',
      ),
      getTotalsByPeerAndBuyer: this._db.prepare(`
        SELECT
          COUNT(*) as total_sessions,
          COALESCE(SUM(request_count), 0) as total_requests,
          COALESCE(SUM(CAST(tokens_delivered AS INTEGER)), 0) as total_input_tokens,
          COALESCE(SUM(CAST(previous_consumption AS INTEGER)), 0) as total_output_tokens,
          COALESCE(SUM(CAST(auth_max AS INTEGER)), 0) as total_authorized,
          MIN(reserved_at) as first_session_at
        FROM payment_channels
        WHERE peer_id = ? AND role = ? AND buyer_evm_addr = ?
      `),
    };
  }

  // ── Channel CRUD ──────────────────────────────────────────────

  upsertChannel(channel: StoredChannel): void {
    this._stmts.upsert.run({
      sessionId: channel.sessionId,
      peerId: channel.peerId,
      role: channel.role,
      sellerEvmAddr: channel.sellerEvmAddr,
      buyerEvmAddr: channel.buyerEvmAddr,
      nonce: channel.nonce,
      authMax: channel.authMax,
      deadline: channel.deadline,
      previousSessionId: channel.previousSessionId,
      previousConsumption: channel.previousConsumption,
      tokensDelivered: channel.tokensDelivered,
      requestCount: channel.requestCount,
      reservedAt: channel.reservedAt,
      settledAt: channel.settledAt,
      settledAmount: channel.settledAmount,
      status: channel.status,
      latestBuyerSig: channel.latestBuyerSig ?? null,
      latestSpendingAuthSig: channel.latestSpendingAuthSig ?? null,
      latestMetadata: channel.latestMetadata ?? null,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    });
  }

  getChannel(sessionId: string): StoredChannel | null {
    const row = this._stmts.getById.get(sessionId) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getActiveChannelByPeer(peerId: string, role: string): StoredChannel | null {
    const row = this._stmts.getActiveByPeer.get(peerId, role, CHANNEL_STATUS.ACTIVE) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getActiveChannelByPeerAndBuyer(peerId: string, role: string, buyerEvmAddr: string): StoredChannel | null {
    const row = this._stmts.getActiveByPeerAndBuyer.get(
      peerId,
      role,
      buyerEvmAddr,
      CHANNEL_STATUS.ACTIVE,
    ) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getLatestChannel(peerId: string, role: string): StoredChannel | null {
    const row = this._stmts.getLatestByPeer.get(peerId, role) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getLatestChannelByPeerAndBuyer(peerId: string, role: string, buyerEvmAddr: string): StoredChannel | null {
    const row = this._stmts.getLatestByPeerAndBuyer.get(peerId, role, buyerEvmAddr) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  updateChannelStatus(sessionId: string, status: string, settledAmount?: string): void {
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

  /** List all channels ordered by most recent first. */
  listAllChannels(limit = 100): StoredChannel[] {
    const rows = this._stmts.listAll.all(limit) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  /** Get all active channels for a given role (buyer or seller). */
  getActiveChannels(role: string): StoredChannel[] {
    const rows = this._stmts.getActiveChannels.all(role, CHANNEL_STATUS.ACTIVE) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  getActiveChannelsByBuyer(role: string, buyerEvmAddr: string): StoredChannel[] {
    const rows = this._stmts.getActiveChannelsByBuyer.all(role, buyerEvmAddr, CHANNEL_STATUS.ACTIVE) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  /** All channels for a given buyer (any status), ordered by most recent first. */
  getAllChannelsByBuyer(role: string, buyerEvmAddr: string): StoredChannel[] {
    const rows = this._db
      .prepare(
        'SELECT * FROM payment_channels WHERE role = ? AND buyer_evm_addr = ? ORDER BY created_at DESC',
      )
      .all(role, buyerEvmAddr) as ChannelRow[];
    return rows.map(rowToChannel);
  }

  /** Aggregate totals across all channels for a given peer and role. */
  getTotalsByPeer(peerId: string, role: string): {
    totalSessions: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalAuthorizedUsdc: bigint;
    firstSessionAt: number | null;
  } {
    const row = this._db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(request_count), 0) as total_requests,
        COALESCE(SUM(CAST(tokens_delivered AS INTEGER)), 0) as total_input_tokens,
        COALESCE(SUM(CAST(previous_consumption AS INTEGER)), 0) as total_output_tokens,
        COALESCE(SUM(CAST(auth_max AS INTEGER)), 0) as total_authorized,
        MIN(reserved_at) as first_session_at
      FROM payment_channels
      WHERE peer_id = ? AND role = ?
    `).get(peerId, role) as {
      total_sessions: number;
      total_requests: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_authorized: number;
      first_session_at: number | null;
    };
    return {
      totalSessions: row.total_sessions,
      totalRequests: row.total_requests,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalAuthorizedUsdc: BigInt(row.total_authorized),
      firstSessionAt: row.first_session_at,
    };
  }

  getTotalsByPeerAndBuyer(peerId: string, role: string, buyerEvmAddr: string): {
    totalSessions: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalAuthorizedUsdc: bigint;
    firstSessionAt: number | null;
  } {
    const row = this._stmts.getTotalsByPeerAndBuyer.get(peerId, role, buyerEvmAddr) as {
      total_sessions: number;
      total_requests: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_authorized: number;
      first_session_at: number | null;
    };
    return {
      totalSessions: row.total_sessions,
      totalRequests: row.total_requests,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalAuthorizedUsdc: BigInt(row.total_authorized),
      firstSessionAt: row.first_session_at,
    };
  }

  // ── Timeout queries ───────────────────────────────────────────

  getTimedOutChannels(timeoutSeconds: number): StoredChannel[] {
    const cutoff = Date.now() - timeoutSeconds * 1000;
    const rows = this._stmts.getTimedOut.all(CHANNEL_STATUS.ACTIVE, cutoff) as ChannelRow[];
    return rows.map(rowToChannel);
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

interface ChannelRow {
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

function rowToChannel(row: ChannelRow): StoredChannel {
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
    status: row.status as StoredChannel['status'],
    latestBuyerSig: row.latest_buyer_sig,
    latestSpendingAuthSig: row.latest_metadata_auth_sig,
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

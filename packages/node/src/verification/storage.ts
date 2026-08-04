import Database from 'better-sqlite3';
import { runMigrations } from '../storage/migrate.js';
import { verificationMigrations } from '../storage/migrations/verification/index.js';
import type { ResponseAuthPayload } from '../types/protocol.js';

export interface StoredResponseAuth extends ResponseAuthPayload {
  receivedAt: number;
  verified: boolean;
  verificationError: string | null;
}

export class ResponseAuthStorage {
  private readonly db: Database.Database;
  private readonly insertStatement: Database.Statement;
  private readonly getStatement: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db, verificationMigrations);
    this.insertStatement = this.db.prepare(`
      INSERT INTO response_auths (
        request_id, version, channel_id, buyer_peer_id, seller_peer_id,
        advertised_service, provider, status_code, request_hash, response_hash,
        response_started_at, response_completed_at, signature,
        received_at, verified, verification_error
      ) VALUES (
        @requestId, @version, @channelId, @buyerPeerId, @sellerPeerId,
        @advertisedService, @provider, @statusCode, @requestHash, @responseHash,
        @responseStartedAt, @responseCompletedAt, @signature,
        @receivedAt, @verified, @verificationError
      )
      ON CONFLICT(request_id) DO UPDATE SET
        version = excluded.version,
        channel_id = excluded.channel_id,
        buyer_peer_id = excluded.buyer_peer_id,
        seller_peer_id = excluded.seller_peer_id,
        advertised_service = excluded.advertised_service,
        provider = excluded.provider,
        status_code = excluded.status_code,
        request_hash = excluded.request_hash,
        response_hash = excluded.response_hash,
        response_started_at = excluded.response_started_at,
        response_completed_at = excluded.response_completed_at,
        signature = excluded.signature,
        received_at = excluded.received_at,
        verified = excluded.verified,
        verification_error = excluded.verification_error
    `);
    this.getStatement = this.db.prepare('SELECT * FROM response_auths WHERE request_id = ?');
  }

  insertResponseAuth(record: StoredResponseAuth): void {
    this.insertStatement.run({ ...record, channelId: record.channelId ?? null, verified: record.verified ? 1 : 0 });
  }

  getResponseAuth(requestId: string): StoredResponseAuth | null {
    const row = this.getStatement.get(requestId) as ResponseAuthRow | undefined;
    return row ? rowToResponseAuth(row) : null;
  }

  close(): void {
    this.db.close();
  }
}

interface ResponseAuthRow {
  request_id: string;
  version: number;
  channel_id: string | null;
  buyer_peer_id: string;
  seller_peer_id: string;
  advertised_service: string;
  provider: string;
  status_code: number;
  request_hash: string;
  response_hash: string;
  response_started_at: number;
  response_completed_at: number;
  signature: string;
  received_at: number;
  verified: number;
  verification_error: string | null;
}

function rowToResponseAuth(row: ResponseAuthRow): StoredResponseAuth {
  return {
    version: row.version as 1,
    requestId: row.request_id,
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    buyerPeerId: row.buyer_peer_id,
    sellerPeerId: row.seller_peer_id,
    advertisedService: row.advertised_service,
    provider: row.provider,
    statusCode: row.status_code,
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    responseStartedAt: row.response_started_at,
    responseCompletedAt: row.response_completed_at,
    signature: row.signature,
    receivedAt: row.received_at,
    verified: row.verified === 1,
    verificationError: row.verification_error,
  };
}

import Database from 'better-sqlite3';
import { runMigrations } from '../storage/migrate.js';
import { resourceMigrations } from '../storage/migrations/resources/index.js';
import type { SerializedHttpResponse } from '../types/http.js';

const OWNER_RETENTION_MS = 30 * 24 * 60 * 60_000;
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface ResourceOwnerRecord {
  protocol: string;
  resourceId: string;
  buyerPeerId: string;
  provider: string;
  service: string;
}

export interface IdempotentCreateRecord {
  requestHash: string;
  resourceId: string;
  response: Pick<SerializedHttpResponse, 'statusCode' | 'headers' | 'body'>;
}

interface IdempotencyRow {
  request_hash: string;
  resource_id: string;
  status_code: number;
  headers_json: string;
  body: Buffer;
}

/**
 * Seller-side record of which buyer created each stateful upstream resource
 * (for example a video job), plus replayable accepted create responses keyed
 * by the buyer's idempotency key.
 */
export class ResourceOwnershipStore {
  private readonly _db: Database.Database;
  private readonly _getOwner: Database.Statement;
  private readonly _insertOwner: Database.Statement;
  private readonly _getIdempotent: Database.Statement;
  private readonly _insertIdempotent: Database.Statement;

  constructor(dbPath: string, private readonly _now: () => number = Date.now) {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    runMigrations(this._db, resourceMigrations);
    this._getOwner = this._db.prepare('SELECT buyer_peer_id FROM resource_owners WHERE protocol = ? AND resource_id = ?');
    this._insertOwner = this._db.prepare(`
      INSERT INTO resource_owners (protocol, resource_id, buyer_peer_id, provider, service, created_at)
      VALUES (@protocol, @resourceId, @buyerPeerId, @provider, @service, @createdAt)
      ON CONFLICT(protocol, resource_id) DO NOTHING
    `);
    this._getIdempotent = this._db.prepare(`
      SELECT request_hash, resource_id, status_code, headers_json, body FROM resource_idempotency
      WHERE buyer_peer_id = ? AND protocol = ? AND idempotency_key = ?
    `);
    this._insertIdempotent = this._db.prepare(`
      INSERT INTO resource_idempotency (
        buyer_peer_id, protocol, idempotency_key, request_hash, resource_id,
        status_code, headers_json, body, created_at
      ) VALUES (
        @buyerPeerId, @protocol, @idempotencyKey, @requestHash, @resourceId,
        @statusCode, @headersJson, @body, @createdAt
      )
      ON CONFLICT(buyer_peer_id, protocol, idempotency_key) DO NOTHING
    `);
    this.prune();
  }

  prune(): void {
    const now = this._now();
    this._db.prepare('DELETE FROM resource_owners WHERE created_at < ?').run(now - OWNER_RETENTION_MS);
    this._db.prepare('DELETE FROM resource_idempotency WHERE created_at < ?').run(now - IDEMPOTENCY_RETENTION_MS);
  }

  getOwner(protocol: string, resourceId: string): string | null {
    const row = this._getOwner.get(protocol, resourceId) as { buyer_peer_id: string } | undefined;
    return row?.buyer_peer_id ?? null;
  }

  getIdempotentCreate(buyerPeerId: string, protocol: string, idempotencyKey: string): IdempotentCreateRecord | null {
    const row = this._getIdempotent.get(buyerPeerId, protocol, idempotencyKey) as IdempotencyRow | undefined;
    if (!row) return null;
    return {
      requestHash: row.request_hash,
      resourceId: row.resource_id,
      response: {
        statusCode: row.status_code,
        headers: JSON.parse(row.headers_json) as Record<string, string>,
        body: new Uint8Array(row.body),
      },
    };
  }

  /** Atomically records the resource owner and, when keyed, the replayable create response. */
  recordAcceptedCreate(
    owner: ResourceOwnerRecord,
    idempotency?: { key: string; requestHash: string; response: Pick<SerializedHttpResponse, 'statusCode' | 'headers' | 'body'> },
  ): void {
    const createdAt = this._now();
    this._db.transaction(() => {
      this._insertOwner.run({ ...owner, createdAt });
      if (idempotency) {
        this._insertIdempotent.run({
          buyerPeerId: owner.buyerPeerId,
          protocol: owner.protocol,
          idempotencyKey: idempotency.key,
          requestHash: idempotency.requestHash,
          resourceId: owner.resourceId,
          statusCode: idempotency.response.statusCode,
          headersJson: JSON.stringify(idempotency.response.headers),
          body: Buffer.from(idempotency.response.body),
          createdAt,
        });
      }
    })();
  }

  close(): void {
    this._db.close();
  }
}

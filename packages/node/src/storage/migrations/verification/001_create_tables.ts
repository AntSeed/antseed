import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 1,
  name: 'create_response_auths',
  up: (db) => {
    db.exec(`
      CREATE TABLE response_auths (
        request_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        channel_id TEXT,
        buyer_peer_id TEXT NOT NULL,
        seller_peer_id TEXT NOT NULL,
        advertised_service TEXT NOT NULL,
        provider TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        request_hash TEXT NOT NULL,
        response_hash TEXT NOT NULL,
        response_started_at INTEGER NOT NULL,
        response_completed_at INTEGER NOT NULL,
        signature TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        verified INTEGER NOT NULL,
        verification_error TEXT
      )
    `);
  },
};

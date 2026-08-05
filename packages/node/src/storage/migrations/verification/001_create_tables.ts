import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 1,
  name: 'create_verification_tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS response_auths (
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
      );

      CREATE INDEX IF NOT EXISTS idx_response_auths_seller ON response_auths(seller_peer_id);
      CREATE INDEX IF NOT EXISTS idx_response_auths_service ON response_auths(advertised_service);
      CREATE INDEX IF NOT EXISTS idx_response_auths_received ON response_auths(received_at);
    `);
  },
};

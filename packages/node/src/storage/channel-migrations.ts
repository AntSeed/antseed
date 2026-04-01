import type { Migration } from './migrate.js';

export const channelMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_payment_channels_and_receipts',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_channels (
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

        CREATE INDEX IF NOT EXISTS idx_channels_peer_role_status ON payment_channels(peer_id, role, status);
        CREATE INDEX IF NOT EXISTS idx_channels_status_updated ON payment_channels(status, updated_at);

        CREATE TABLE IF NOT EXISTS payment_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          running_total TEXT NOT NULL,
          request_count INTEGER NOT NULL,
          response_hash TEXT NOT NULL,
          seller_sig TEXT NOT NULL,
          buyer_ack_sig TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES payment_channels(session_id)
        );

        CREATE INDEX IF NOT EXISTS idx_receipts_session ON payment_receipts(session_id);
      `);
    },
  },
];

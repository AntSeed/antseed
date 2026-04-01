import type { Migration } from './migrate.js';

export const meteringMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_metering_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS metering_events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          provider TEXT NOT NULL,
          seller_peer_id TEXT NOT NULL,
          buyer_peer_id TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          token_method TEXT NOT NULL,
          token_confidence TEXT NOT NULL,
          latency_ms INTEGER NOT NULL,
          status_code INTEGER NOT NULL,
          was_streaming INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_events_session ON metering_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON metering_events(timestamp);

        CREATE TABLE IF NOT EXISTS usage_receipts (
          receipt_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          provider TEXT NOT NULL,
          seller_peer_id TEXT NOT NULL,
          buyer_peer_id TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          token_method TEXT NOT NULL,
          token_confidence TEXT NOT NULL,
          unit_price_cents_per_thousand_tokens INTEGER NOT NULL,
          cost_cents INTEGER NOT NULL,
          signature TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_receipts_session ON usage_receipts(session_id);
        CREATE INDEX IF NOT EXISTS idx_receipts_timestamp ON usage_receipts(timestamp);

        CREATE TABLE IF NOT EXISTS receipt_verifications (
          receipt_id TEXT PRIMARY KEY,
          signature_valid INTEGER NOT NULL,
          buyer_input_tokens INTEGER NOT NULL,
          buyer_output_tokens INTEGER NOT NULL,
          buyer_total_tokens INTEGER NOT NULL,
          seller_total_tokens INTEGER NOT NULL,
          token_difference INTEGER NOT NULL,
          percentage_difference REAL NOT NULL,
          disputed INTEGER NOT NULL,
          verified_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          seller_peer_id TEXT NOT NULL,
          buyer_peer_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          total_requests INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          total_cost_cents INTEGER NOT NULL,
          avg_latency_ms REAL NOT NULL,
          peer_switches INTEGER NOT NULL,
          disputed_receipts INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
      `);
    },
  },
];

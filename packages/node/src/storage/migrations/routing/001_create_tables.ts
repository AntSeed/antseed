import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 1,
  name: 'create_routing_decisions_table',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        actual_model TEXT NOT NULL,
        actual_peer TEXT NOT NULL,
        actual_prompt_tokens INTEGER NOT NULL,
        actual_cached_tokens INTEGER NOT NULL,
        actual_completion_tokens INTEGER NOT NULL,
        actual_usdc_paid REAL,
        predicted_cost_usd REAL,
        predicted_input_tokens INTEGER,
        predicted_cached_input_tokens INTEGER,
        predicted_output_tokens INTEGER,
        cqt INTEGER,
        routing_latency_ms INTEGER,
        baseline_prices TEXT NOT NULL,
        conversation_key TEXT,
        considered_candidates TEXT NOT NULL,
        input_message_preview TEXT,
        cost_source TEXT NOT NULL DEFAULT 'estimate',
        router_metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_routing_decisions_at_ms ON routing_decisions(at_ms);
      CREATE INDEX IF NOT EXISTS idx_routing_decisions_conversation_key ON routing_decisions(conversation_key);
    `);
  },
};

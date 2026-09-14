import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 2,
  name: 'optional_router_telemetry',
  up: (db) => {
    db.exec(`
      CREATE TABLE routing_decisions_v2 (
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
      INSERT INTO routing_decisions_v2 (
        id, at_ms, actual_model, actual_peer, actual_prompt_tokens, actual_cached_tokens,
        actual_completion_tokens, actual_usdc_paid, predicted_cost_usd, predicted_input_tokens,
        predicted_cached_input_tokens, predicted_output_tokens, cqt, routing_latency_ms,
        baseline_prices, conversation_key, considered_candidates, input_message_preview
      ) SELECT id, at_ms, actual_model, actual_peer, actual_prompt_tokens, actual_cached_tokens,
        actual_completion_tokens, actual_usdc_paid, predicted_cost_usd, predicted_input_tokens,
        predicted_cached_input_tokens, predicted_output_tokens, cqt, routing_latency_ms,
        baseline_prices, conversation_key, considered_candidates, input_message_preview
        FROM routing_decisions;
      DROP TABLE routing_decisions;
      ALTER TABLE routing_decisions_v2 RENAME TO routing_decisions;
      CREATE INDEX idx_routing_decisions_at_ms ON routing_decisions(at_ms);
      CREATE INDEX idx_routing_decisions_conversation_key ON routing_decisions(conversation_key);
    `);
  },
};

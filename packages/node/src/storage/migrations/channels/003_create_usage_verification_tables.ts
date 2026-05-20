import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 3,
  name: 'create_usage_verification_tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_verification_snapshots (
        channel_id TEXT NOT NULL,
        service_key TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        service_name TEXT NOT NULL,
        epoch TEXT NOT NULL,
        buyer_evm_addr TEXT NOT NULL,
        seller_evm_addr TEXT NOT NULL,
        seller_agent_id TEXT NOT NULL,
        cumulative_input_tokens TEXT NOT NULL DEFAULT '0',
        cumulative_cached_input_tokens TEXT NOT NULL DEFAULT '0',
        cumulative_fresh_input_tokens TEXT NOT NULL DEFAULT '0',
        cumulative_output_tokens TEXT NOT NULL DEFAULT '0',
        cumulative_request_count TEXT NOT NULL DEFAULT '0',
        cumulative_cost_usdc TEXT NOT NULL DEFAULT '0',
        payment_cumulative_amount TEXT NOT NULL DEFAULT '0',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, service_key, epoch)
      );

      CREATE TABLE IF NOT EXISTS usage_verification_attestations (
        claim_hash TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        service_key TEXT NOT NULL,
        epoch TEXT NOT NULL,
        claim_json TEXT NOT NULL,
        buyer_reveal_hash TEXT,
        seller_reveal_hash TEXT,
        buyer_nonce TEXT,
        seller_nonce TEXT,
        buyer_sig TEXT,
        seller_sig TEXT,
        commit_tx_hash TEXT,
        reveal_tx_hash TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_verification_attestations_status
        ON usage_verification_attestations(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_usage_verification_attestations_channel
        ON usage_verification_attestations(channel_id, service_key, epoch);
    `);
  },
};

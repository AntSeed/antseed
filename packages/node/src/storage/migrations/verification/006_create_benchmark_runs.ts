import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 6,
  name: 'create_benchmark_runs',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS benchmark_runs (
        run_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('planned', 'preparing', 'running', 'completed', 'failed')),
        mode TEXT NOT NULL CHECK (mode IN ('observe')),
        service TEXT NOT NULL,
        epoch TEXT,
        reference_id TEXT,
        certification_hash TEXT,
        query_profile_hash TEXT,
        probe_count INTEGER NOT NULL CHECK (probe_count > 0),
        max_total_usdc TEXT NOT NULL,
        spent_usdc TEXT NOT NULL DEFAULT '0',
        discovered_count INTEGER NOT NULL DEFAULT 0,
        eligible_count INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        reference_path TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_benchmark_runs_state
        ON benchmark_runs(state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_benchmark_runs_service_epoch
        ON benchmark_runs(service, epoch, created_at);

      CREATE TABLE IF NOT EXISTS benchmark_targets (
        run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        peer_id TEXT NOT NULL,
        agent_id TEXT,
        display_name TEXT,
        public_address TEXT,
        advertised_service TEXT NOT NULL,
        eligibility TEXT NOT NULL CHECK (eligibility IN ('eligible', 'ineligible')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        eligibility_reason TEXT,
        audit_id TEXT,
        seller_charge_usdc TEXT NOT NULL DEFAULT '0',
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, peer_id),
        UNIQUE (run_id, ordinal),
        FOREIGN KEY (run_id) REFERENCES benchmark_runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_benchmark_targets_state
        ON benchmark_targets(run_id, state, ordinal);

      CREATE TABLE IF NOT EXISTS direct_audit_exchanges (
        audit_id TEXT NOT NULL,
        batch_index INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
        request_id TEXT,
        exchange_json TEXT,
        seller_charge_usdc TEXT NOT NULL DEFAULT '0',
        started_at INTEGER,
        completed_at INTEGER,
        failure_reason TEXT,
        PRIMARY KEY (audit_id, batch_index),
        FOREIGN KEY (audit_id) REFERENCES direct_audits(audit_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_direct_audit_exchanges_state
        ON direct_audit_exchanges(audit_id, state, batch_index);
    `);
  },
};

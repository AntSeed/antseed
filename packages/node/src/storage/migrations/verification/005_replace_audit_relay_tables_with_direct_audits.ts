import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 5,
  name: 'replace_audit_relay_tables_with_direct_audits',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS direct_audits (
        audit_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'attested', 'failed')),
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automatic')),
        epoch TEXT,
        verifier_address TEXT,
        agent_id TEXT,
        target_peer_id TEXT NOT NULL,
        target_service TEXT NOT NULL,
        target_service_hash TEXT,
        reference_id TEXT,
        query_profile_hash TEXT,
        probe_count INTEGER NOT NULL DEFAULT 0 CHECK (probe_count >= 0),
        authenticated_probe_count INTEGER NOT NULL DEFAULT 0 CHECK (authenticated_probe_count >= 0),
        statistical_power REAL,
        verdict INTEGER,
        model_share_bps INTEGER,
        metrics_json TEXT,
        evidence_path TEXT,
        evidence_hash TEXT,
        evidence_uri TEXT,
        attestation_tx_hash TEXT,
        credited INTEGER CHECK (credited IN (0, 1)),
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failure_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_direct_audits_state
        ON direct_audits(state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_direct_audits_target
        ON direct_audits(agent_id, target_service_hash, created_at);
      CREATE INDEX IF NOT EXISTS idx_direct_audits_epoch
        ON direct_audits(epoch, verifier_address, state);

      CREATE TABLE IF NOT EXISTS direct_audit_probes (
        audit_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        probe_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'selected' CHECK (status IN ('selected', 'succeeded', 'failed')),
        request_id TEXT,
        request_hash TEXT,
        response_hash TEXT,
        response_auth_json TEXT,
        payment_json TEXT,
        timing_json TEXT,
        matched INTEGER CHECK (matched IN (0, 1)),
        exposure_counted_at INTEGER,
        failure_reason TEXT,
        PRIMARY KEY (audit_id, ordinal),
        UNIQUE (audit_id, probe_id),
        FOREIGN KEY (audit_id) REFERENCES direct_audits(audit_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_direct_audit_probes_status
        ON direct_audit_probes(audit_id, status, ordinal);

      INSERT OR IGNORE INTO direct_audits (
        audit_id, state, source, epoch, verifier_address, agent_id,
        target_peer_id, target_service, target_service_hash, reference_id,
        query_profile_hash, probe_count, evidence_hash, evidence_uri,
        attestation_tx_hash, created_at, updated_at, failure_reason
      )
      SELECT
        audit_id,
        CASE
          WHEN state = 'attested' THEN 'attested'
          WHEN state = 'failed' THEN 'failed'
          WHEN state IN ('awaiting-attestation', 'attesting') THEN 'completed'
          ELSE 'pending'
        END,
        source,
        epoch,
        verifier_address,
        agent_id,
        target_peer_id,
        lower(trim(target_service)),
        target_service_hash,
        reference_id,
        query_profile_hash,
        COALESCE(probe_count, 0),
        evidence_hash,
        evidence_uri,
        attestation_tx_hash,
        created_at,
        updated_at,
        failure_reason
      FROM audit_plans;

      INSERT OR IGNORE INTO direct_audit_probes (
        audit_id, ordinal, probe_id, status, exposure_counted_at
      )
      SELECT audit_id, ordinal, probe_id, 'selected', exposure_counted_at
      FROM audit_probe_selections;

      DROP TABLE IF EXISTS audit_round_members;
      DROP TABLE IF EXISTS audit_rounds;
      DROP TABLE IF EXISTS audit_probe_selections;
      DROP TABLE IF EXISTS audit_job_charges;
      DROP TABLE IF EXISTS relay_entitlements;
      DROP TABLE IF EXISTS settlement_usage_events;
      DROP TABLE IF EXISTS settlement_service_totals;
      DROP TABLE IF EXISTS settlement_index_cursors;
      DROP TABLE IF EXISTS audit_jobs;
      DROP TABLE IF EXISTS audit_plans;
    `);
  },
};

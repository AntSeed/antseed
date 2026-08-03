import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 2,
  name: 'create_audit_relay_tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_plans (
        audit_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'preparing-reference', 'planned', 'committing', 'committed',
          'executing', 'awaiting-attestation', 'attesting', 'attested', 'failed'
        )),
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automatic')),
        epoch TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 86400000,
        chain_id TEXT,
        registry_address TEXT,
        treasury_address TEXT,
        verifier_address TEXT,
        agent_id TEXT,
        target_peer_id TEXT NOT NULL,
        target_service TEXT NOT NULL,
        target_service_hash TEXT,
        target_salt TEXT,
        target_commitment TEXT,
        probe_root TEXT,
        audit_job_root TEXT,
        reference_id TEXT,
        query_profile_hash TEXT,
        verifier_config_hash TEXT,
        probe_count INTEGER,
        job_count INTEGER,
        required_relay_count INTEGER,
        job_timeout_ms INTEGER NOT NULL DEFAULT 120000,
        payout_per_job_usdc TEXT,
        reserved_budget_usdc TEXT,
        commit_tx_hash TEXT,
        attestation_tx_hash TEXT,
        evidence_hash TEXT,
        evidence_uri TEXT,
        evidence_state TEXT NOT NULL DEFAULT 'none' CHECK (evidence_state IN ('none', 'local', 'published')),
        execute_after INTEGER,
        execute_before INTEGER,
        force_claim_available_at INTEGER,
        force_claim_deadline INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failure_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_plans_state ON audit_plans(state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_audit_plans_target ON audit_plans(agent_id, target_service_hash, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_plans_epoch_target ON audit_plans(epoch, agent_id, target_service_hash, state);

      CREATE TABLE IF NOT EXISTS audit_jobs (
        audit_id TEXT NOT NULL,
        job_index INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('planned', 'due', 'assigned', 'dispatched', 'succeeded', 'failed')),
        scheduled_at INTEGER NOT NULL,
        relay_peer_id TEXT,
        relay_buyer_address TEXT,
        assignment_attempt INTEGER NOT NULL DEFAULT 0 CHECK (assignment_attempt >= 0 AND assignment_attempt < 3),
        assignment_signature TEXT,
        assignment_state TEXT NOT NULL DEFAULT 'unassigned' CHECK (assignment_state IN ('unassigned', 'assigned', 'rejected', 'accepted')),
        assigned_at INTEGER,
        last_dispatch_at INTEGER,
        seller_peer_id TEXT NOT NULL,
        service TEXT NOT NULL,
        service_hash TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        job_salt TEXT NOT NULL,
        execute_after INTEGER NOT NULL,
        execute_before INTEGER NOT NULL,
        request_bytes BLOB NOT NULL,
        positional_proof_json TEXT NOT NULL,
        response_bytes BLOB,
        response_auth_payload BLOB,
        seller_charge_usdc TEXT,
        payment_metadata_json TEXT,
        dispatched_at INTEGER,
        completed_at INTEGER,
        failure_kind TEXT,
        failure_message TEXT,
        entitlement_persisted_at INTEGER,
        PRIMARY KEY (audit_id, job_index),
        UNIQUE (audit_id, request_hash),
        FOREIGN KEY (audit_id) REFERENCES audit_plans(audit_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_audit_jobs_due ON audit_jobs(state, scheduled_at, execute_before);
      CREATE INDEX IF NOT EXISTS idx_audit_jobs_relay_state ON audit_jobs(relay_peer_id, state, execute_before);
      CREATE INDEX IF NOT EXISTS idx_audit_jobs_request_hash ON audit_jobs(request_hash);

      CREATE TABLE IF NOT EXISTS audit_job_charges (
        audit_id TEXT NOT NULL,
        job_index INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        service_hash TEXT NOT NULL,
        cumulative_amount_usdc TEXT NOT NULL,
        charge_usdc TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (audit_id, job_index),
        FOREIGN KEY (audit_id, job_index) REFERENCES audit_jobs(audit_id, job_index) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_audit_job_charges_channel
        ON audit_job_charges(channel_id, service_hash, cumulative_amount_usdc);

      CREATE TABLE IF NOT EXISTS relay_entitlements (
        audit_id TEXT NOT NULL,
        job_index INTEGER NOT NULL,
        relay_peer_id TEXT NOT NULL,
        relay_buyer_address TEXT NOT NULL,
        registry_address TEXT NOT NULL,
        treasury_address TEXT NOT NULL,
        job_json TEXT NOT NULL,
        positional_proof_json TEXT NOT NULL,
        assignment_json TEXT NOT NULL,
        verifier_signature TEXT NOT NULL,
        response_bytes BLOB NOT NULL,
        response_auth_payload BLOB NOT NULL,
        payout_usdc TEXT NOT NULL,
        seller_charge_usdc TEXT NOT NULL,
        payment_metadata_json TEXT NOT NULL,
        force_claim_available_at INTEGER NOT NULL,
        force_claim_deadline INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'awaiting-attestation', 'paid', 'challenge-available', 'expired'
        )),
        claim_tx_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (audit_id, job_index)
      );

      CREATE INDEX IF NOT EXISTS idx_relay_entitlements_state ON relay_entitlements(state, force_claim_available_at);

      CREATE TABLE IF NOT EXISTS settlement_index_cursors (
        chain_id TEXT NOT NULL,
        channels_address TEXT NOT NULL,
        finalized_block INTEGER NOT NULL,
        finalized_block_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, channels_address)
      );

      CREATE TABLE IF NOT EXISTS settlement_service_totals (
        chain_id TEXT NOT NULL,
        channels_address TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seller_peer_id TEXT NOT NULL,
        service TEXT NOT NULL,
        cumulative_service_usdc TEXT NOT NULL,
        cumulative_channel_usdc TEXT NOT NULL,
        last_block_number INTEGER NOT NULL,
        last_log_index INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, channels_address, channel_id, service)
      );

      CREATE TABLE IF NOT EXISTS settlement_usage_events (
        chain_id TEXT NOT NULL,
        channels_address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        settled_at INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seller_peer_id TEXT NOT NULL,
        service TEXT NOT NULL,
        cumulative_service_usdc TEXT NOT NULL,
        service_delta_usdc TEXT NOT NULL,
        cumulative_channel_usdc TEXT NOT NULL,
        channel_delta_usdc TEXT NOT NULL,
        audit_charge_usdc TEXT NOT NULL,
        organic_service_delta_usdc TEXT NOT NULL,
        PRIMARY KEY (chain_id, channels_address, tx_hash, log_index, service)
      );

      CREATE INDEX IF NOT EXISTS idx_settlement_usage_agent ON settlement_usage_events(agent_id, settled_at, service);
    `);
  },
};

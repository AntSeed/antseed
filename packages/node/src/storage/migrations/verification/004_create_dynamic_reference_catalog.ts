import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 4,
  name: 'create_dynamic_reference_catalog',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS certified_kbf_probes (
        service TEXT NOT NULL,
        certification_hash TEXT NOT NULL,
        probe_id TEXT NOT NULL,
        probe_json TEXT NOT NULL,
        certification_json TEXT NOT NULL,
        query_profile_json TEXT NOT NULL,
        source_id TEXT NOT NULL,
        trust TEXT NOT NULL CHECK (trust IN ('smoke', 'trusted')),
        certified_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        healthy INTEGER NOT NULL DEFAULT 1 CHECK (healthy IN (0, 1)),
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (service, certification_hash, probe_id)
      );

      CREATE INDEX IF NOT EXISTS idx_certified_kbf_probes_eligible
        ON certified_kbf_probes(service, certification_hash, healthy, expires_at);

      CREATE TABLE IF NOT EXISTS certified_kbf_imports (
        reference_id TEXT PRIMARY KEY,
        certification_hash TEXT NOT NULL,
        imported_probe_count INTEGER NOT NULL,
        imported_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_rounds (
        round_id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        endpoint_hash TEXT NOT NULL,
        epoch TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'preparing', 'ready', 'committing', 'committed',
          'executing', 'complete', 'backoff', 'failed'
        )),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        target_count INTEGER NOT NULL DEFAULT 0,
        generated_probe_count INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_rounds_state
        ON audit_rounds(state, next_retry_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_audit_rounds_service_epoch
        ON audit_rounds(service, epoch, created_at);

      CREATE TABLE IF NOT EXISTS audit_round_members (
        round_id TEXT NOT NULL,
        audit_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'prepared', 'committed', 'failed')),
        reference_id TEXT,
        probe_count INTEGER,
        cached_probe_count INTEGER NOT NULL DEFAULT 0,
        generated_probe_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (round_id, audit_id),
        UNIQUE (audit_id),
        FOREIGN KEY (round_id) REFERENCES audit_rounds(round_id) ON DELETE CASCADE,
        FOREIGN KEY (audit_id) REFERENCES audit_plans(audit_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_audit_round_members_state
        ON audit_round_members(round_id, state, updated_at);

      CREATE TABLE probe_exposures_v4 (
        agent_id TEXT NOT NULL,
        service TEXT NOT NULL,
        probe_id TEXT NOT NULL,
        exposure_count INTEGER NOT NULL DEFAULT 1 CHECK (exposure_count >= 1),
        last_audit_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, service, probe_id)
      );

      INSERT INTO probe_exposures_v4 (
        agent_id, service, probe_id, exposure_count, last_audit_id, updated_at
      )
      SELECT agent_id, lower(trim(service)), probe_id, 1, MAX(last_audit_id), MAX(updated_at)
      FROM probe_exposures
      GROUP BY agent_id, lower(trim(service)), probe_id;

      DROP TABLE probe_exposures;
      ALTER TABLE probe_exposures_v4 RENAME TO probe_exposures;

      CREATE INDEX IF NOT EXISTS idx_probe_exposures_target
        ON probe_exposures(agent_id, service, updated_at);
    `);
  },
};

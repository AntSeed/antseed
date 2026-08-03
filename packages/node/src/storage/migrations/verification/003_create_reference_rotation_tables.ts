import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 3,
  name: 'create_reference_rotation_tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reference_builds (
        service TEXT NOT NULL,
        endpoint_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('missing', 'building', 'ready', 'backoff', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        request_count INTEGER NOT NULL DEFAULT 0,
        reference_id TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (service, endpoint_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_reference_builds_state
        ON reference_builds(state, next_retry_at, updated_at);

      CREATE TABLE IF NOT EXISTS audit_probe_selections (
        audit_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        job_index INTEGER NOT NULL,
        probe_id TEXT NOT NULL,
        exposure_counted_at INTEGER,
        PRIMARY KEY (audit_id, ordinal),
        UNIQUE (audit_id, probe_id),
        FOREIGN KEY (audit_id) REFERENCES audit_plans(audit_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_audit_probe_job
        ON audit_probe_selections(audit_id, job_index, exposure_counted_at);

      CREATE TABLE IF NOT EXISTS probe_exposures (
        agent_id TEXT NOT NULL,
        service TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        probe_id TEXT NOT NULL,
        exposure_count INTEGER NOT NULL DEFAULT 0 CHECK (exposure_count >= 0),
        last_audit_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, service, reference_id, probe_id)
      );

      CREATE INDEX IF NOT EXISTS idx_probe_exposures_target
        ON probe_exposures(agent_id, service, reference_id, exposure_count);
    `);
  },
};

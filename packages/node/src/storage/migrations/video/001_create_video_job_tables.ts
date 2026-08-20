import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 1,
  name: 'create_video_job_tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS video_generations (
        id TEXT PRIMARY KEY,
        buyer_peer_id TEXT NOT NULL,
        seller_peer_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        service_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        upstream_job_id TEXT,
        status TEXT NOT NULL,
        native_status TEXT,
        progress INTEGER,
        quote_json TEXT NOT NULL,
        execution_status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        error_json TEXT,
        poll_attempt INTEGER NOT NULL DEFAULT 0,
        next_poll_at INTEGER,
        worker_lease_until INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        expires_at INTEGER NOT NULL,
        UNIQUE (buyer_peer_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_video_generations_poll
        ON video_generations(status, next_poll_at);
      CREATE INDEX IF NOT EXISTS idx_video_generations_buyer
        ON video_generations(buyer_peer_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS video_artifacts (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        provider_artifact_id TEXT,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        duration_seconds REAL,
        width INTEGER,
        height INTEGER,
        fps REAL,
        has_audio INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (generation_id) REFERENCES video_generations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS video_input_assets (
        id TEXT PRIMARY KEY,
        buyer_peer_id TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS video_generation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (generation_id) REFERENCES video_generations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS video_idempotency_keys (
        buyer_peer_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (buyer_peer_id, idempotency_key),
        FOREIGN KEY (generation_id) REFERENCES video_generations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS video_pending_milestone_auths (
        generation_id TEXT NOT NULL,
        milestone_id TEXT NOT NULL,
        auth_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        promoted_at INTEGER,
        PRIMARY KEY (generation_id, milestone_id),
        FOREIGN KEY (generation_id) REFERENCES video_generations(id) ON DELETE CASCADE
      );
    `);
  },
};

import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 8,
  name: 'create_traffic_share_snapshots',
  up: (db) => {
    const directAuditColumns = db.pragma('table_info(direct_audits)') as Array<{ name: string }>;
    if (!directAuditColumns.some((column) => column.name === 'seller_address')) {
      db.exec('ALTER TABLE direct_audits ADD COLUMN seller_address TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS traffic_share_snapshots (
        audit_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        epoch TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        window_ended_at INTEGER NOT NULL,
        indexed_block INTEGER NOT NULL,
        seller_address TEXT NOT NULL,
        service_hash TEXT NOT NULL,
        service_volume_usdc TEXT NOT NULL,
        seller_volume_usdc TEXT NOT NULL,
        model_share_bps INTEGER NOT NULL CHECK (model_share_bps >= 0 AND model_share_bps <= 10000),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (audit_id) REFERENCES direct_audits(audit_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_traffic_share_snapshots_seller_epoch
        ON traffic_share_snapshots(seller_address, epoch, indexed_block);
    `);
  },
};

import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 2,
  name: 'add_auth_sig_columns',
  up: (db) => {
    const cols = db.pragma('table_info(payment_channels)') as Array<{ name: string }>;
    const existing = new Set(cols.map(c => c.name));

    if (!existing.has('latest_buyer_sig')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN latest_buyer_sig TEXT');
    }
    if (!existing.has('latest_metadata_auth_sig')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN latest_metadata_auth_sig TEXT');
    }
    if (!existing.has('latest_metadata')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN latest_metadata TEXT');
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_channels_status_updated ON payment_channels(status, updated_at)');
  },
};

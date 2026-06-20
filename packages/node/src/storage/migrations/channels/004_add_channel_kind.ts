import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 4,
  name: 'add_channel_kind',
  up: (db) => {
    const cols = db.pragma('table_info(payment_channels)') as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));

    if (!existing.has('channel_kind')) {
      db.exec("ALTER TABLE payment_channels ADD COLUMN channel_kind TEXT NOT NULL DEFAULT 'paid'");
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_channels_peer_role_kind_status
        ON payment_channels(peer_id, role, channel_kind, status);
    `);
  },
};

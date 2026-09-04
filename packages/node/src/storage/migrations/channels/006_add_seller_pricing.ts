import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 6,
  name: 'add_seller_pricing',
  up: (db) => {
    const columns = db.pragma('table_info(payment_channels)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'seller_pricing_json')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN seller_pricing_json TEXT');
    }
  },
};

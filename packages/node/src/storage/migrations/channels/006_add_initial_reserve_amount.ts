import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 6,
  name: 'add_initial_reserve_amount',
  up: (db) => {
    const columns = db.pragma('table_info(payment_channels)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'initial_reserve_amount')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN initial_reserve_amount TEXT');
    }
  },
};

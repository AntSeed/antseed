import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 7,
  name: 'add_access_billing',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS access_agreements (
        scope TEXT PRIMARY KEY,
        agreement_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_purchases (
        scope TEXT NOT NULL,
        authorized_at_ms INTEGER NOT NULL,
        purchase_json TEXT NOT NULL,
        PRIMARY KEY (scope, authorized_at_ms)
      );
    `);
  },
};

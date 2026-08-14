import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 2,
  name: 'add_response_auth_preimages',
  up: (db) => {
    const columns = new Set(
      (db.pragma('table_info(response_auths)') as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has('request_preimage')) {
      db.exec('ALTER TABLE response_auths ADD COLUMN request_preimage BLOB');
    }
    if (!columns.has('response_preimage')) {
      db.exec('ALTER TABLE response_auths ADD COLUMN response_preimage BLOB');
    }
  },
};

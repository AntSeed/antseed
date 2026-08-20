import type { Migration } from '../../migrate.js';

export const migration: Migration = {
  version: 2,
  name: 'add_video_payment_channel',
  up: (db) => {
    db.exec('ALTER TABLE video_generations ADD COLUMN payment_channel_id TEXT');
  },
};

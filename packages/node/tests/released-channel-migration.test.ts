import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/storage/migrate.js';
import { channelMigrations } from '../src/storage/migrations/channels/index.js';

describe('published channel schema upgrade', () => {
  it('preserves v5 payment records and signatures while applying the additive v6 and v7 migrations', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, channelMigrations.filter((migration) => migration.version <= 5));
      db.prepare(`INSERT INTO payment_channels (
        session_id, peer_id, role, seller_evm_addr, buyer_evm_addr, nonce, auth_max,
        deadline, previous_session_id, previous_consumption, tokens_delivered,
        request_count, reserved_at, created_at, updated_at, latest_buyer_sig, channel_kind
      ) VALUES ('session', 'peer', 'buyer', 'seller', 'buyer', 1, '5000', 100,
        '', '0', '10', 1, 1, 1, 1, 'signed-authorization', 'paid')`).run();
      db.prepare(`INSERT INTO payment_receipts (
        session_id, running_total, request_count, response_hash, seller_sig, buyer_ack_sig, created_at
      ) VALUES ('session', '5000', 1, 'hash', 'seller-signature', 'buyer-signature', 1)`).run();
      db.prepare(`INSERT INTO payment_channel_service_totals (
        session_id, service_id, cumulative_amount, cumulative_input_tokens,
        cumulative_cached_input_tokens, cumulative_output_tokens, cumulative_request_count,
        updated_at, cumulative_output_images
      ) VALUES ('session', 'image', '5000', '0', '0', '0', '1', 1, '1')`).run();
      const channel = db.prepare('SELECT * FROM payment_channels').get();
      const receipts = db.prepare('SELECT * FROM payment_receipts').all();
      const totals = db.prepare('SELECT * FROM payment_channel_service_totals').all();
      const applied = db.prepare('SELECT * FROM schema_version ORDER BY version').all();

      runMigrations(db, channelMigrations);
      expect(db.prepare('SELECT * FROM payment_channels').get()).toEqual({
        ...channel as Record<string, unknown>,
        reserve_salt: null, initial_reserve_amount: null, reserve_max_amount: null,
        latest_reserve_auth_sig: null, latest_reserve_deadline: null,
        reserve_auth_pending: null, confirmed_reserve_amount: null,
      });
      expect(db.prepare('SELECT * FROM payment_receipts').all()).toEqual(receipts);
      expect(db.prepare('SELECT * FROM payment_channel_service_totals').all()).toEqual(totals);
      expect(db.prepare('SELECT * FROM schema_version WHERE version <= 5 ORDER BY version').all()).toEqual(applied);
      db.prepare("UPDATE payment_channels SET reserve_salt = 'salt', latest_reserve_auth_sig = 'reserve-signature'").run();
      runMigrations(db, channelMigrations);
      expect(db.prepare('SELECT reserve_salt, latest_reserve_auth_sig FROM payment_channels').get()).toEqual({
        reserve_salt: 'salt', latest_reserve_auth_sig: 'reserve-signature',
      });
      expect(db.prepare('SELECT version FROM schema_version ORDER BY version').all()).toEqual(
        [1, 2, 3, 4, 5, 6, 7].map((version) => ({ version })),
      );
    } finally {
      db.close();
    }
  });
});

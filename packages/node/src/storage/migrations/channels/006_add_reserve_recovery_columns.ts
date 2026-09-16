import type { Migration } from '../../migrate.js';

/**
 * `StoredChannel`'s reserve-recovery fields (reserveSalt, reserveMaxAmount,
 * reserveAuthPending, etc. -- used to replay an unconfirmed ReserveAuth
 * instead of retiring and rebootstrapping a channel, see
 * BuyerPaymentManager.canReplayReserveAuth/resendReserveAuth) were added to
 * the TypeScript interface for browser-storage recovery but never given
 * sqlite columns, so this backend's rowToChannel/upsertChannel silently
 * never read or wrote them at all -- canReplayReserveAuth is unreachable
 * for any CLI/node buyer, every reserve-auth-recovery branch always falls
 * through to a full retire-and-rebootstrap instead.
 */
export const migration: Migration = {
  version: 6,
  name: 'add_reserve_recovery_columns',
  up: (db) => {
    const cols = db.pragma('table_info(payment_channels)') as Array<{ name: string }>;
    const existing = new Set(cols.map(c => c.name));

    if (!existing.has('reserve_salt')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN reserve_salt TEXT');
    }
    if (!existing.has('initial_reserve_amount')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN initial_reserve_amount TEXT');
    }
    if (!existing.has('reserve_max_amount')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN reserve_max_amount TEXT');
    }
    if (!existing.has('latest_reserve_auth_sig')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN latest_reserve_auth_sig TEXT');
    }
    if (!existing.has('latest_reserve_deadline')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN latest_reserve_deadline INTEGER');
    }
    if (!existing.has('reserve_auth_pending')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN reserve_auth_pending INTEGER');
    }
    if (!existing.has('confirmed_reserve_amount')) {
      db.exec('ALTER TABLE payment_channels ADD COLUMN confirmed_reserve_amount TEXT');
    }
  },
};

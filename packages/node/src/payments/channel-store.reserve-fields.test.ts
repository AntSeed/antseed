import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelStore, CHANNEL_ROLE, CHANNEL_STATUS, CHANNEL_KIND } from './channel-store.js';
import type { StoredChannel } from '@antseed/buyer-core/channel-store-types';

/**
 * StoredChannel's reserve-recovery fields (reserveSalt, reserveMaxAmount,
 * reserveAuthPending, etc.) were never given sqlite columns, so
 * BuyerPaymentManager.canReplayReserveAuth was unreachable for any
 * sqlite-backed (CLI/node) buyer -- a channel's reserve-auth-recovery state
 * was silently dropped on every read, both fresh and after any update.
 */
describe('ChannelStore reserve-recovery fields', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeChannel(overrides: Partial<StoredChannel> = {}): StoredChannel {
    const now = 1_700_000_000_000;
    return {
      sessionId: '0x' + 'ab'.repeat(32),
      peerId: 'peer-1',
      role: CHANNEL_ROLE.BUYER,
      channelKind: CHANNEL_KIND.PAID,
      sellerEvmAddr: '0x' + '11'.repeat(20),
      buyerEvmAddr: '0x' + '22'.repeat(20),
      nonce: 0,
      authMax: '0',
      deadline: 1_700_003_600,
      previousSessionId: '0x' + '0'.repeat(64),
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: CHANNEL_STATUS.ACTIVE,
      latestBuyerSig: null,
      latestSpendingAuthSig: null,
      latestMetadata: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it('round-trips reserve-recovery fields through insert', () => {
    dir = mkdtempSync(join(tmpdir(), 'channel-store-reserve-'));
    const store = new ChannelStore(dir);
    const channel = makeChannel({
      reserveSalt: '0x' + 'cc'.repeat(32),
      initialReserveAmount: '590000',
      reserveMaxAmount: '590000',
      latestReserveAuthSig: '0x' + 'dd'.repeat(65),
      latestReserveDeadline: 1_700_003_600,
      reserveAuthPending: true,
      confirmedReserveAmount: '0',
    });
    store.upsertChannel(channel);

    const read = store.getChannel(channel.sessionId);
    expect(read).not.toBeNull();
    expect(read!.reserveSalt).toBe(channel.reserveSalt);
    expect(read!.initialReserveAmount).toBe('590000');
    expect(read!.reserveMaxAmount).toBe('590000');
    expect(read!.latestReserveAuthSig).toBe(channel.latestReserveAuthSig);
    expect(read!.latestReserveDeadline).toBe(1_700_003_600);
    expect(read!.reserveAuthPending).toBe(true);
    expect(read!.confirmedReserveAmount).toBe('0');
  });

  it('persists updates to reserve-recovery fields, not just the initial insert', () => {
    dir = mkdtempSync(join(tmpdir(), 'channel-store-reserve-'));
    const store = new ChannelStore(dir);
    const channel = makeChannel({
      reserveSalt: '0x' + 'cc'.repeat(32),
      initialReserveAmount: '590000',
      reserveMaxAmount: '590000',
      latestReserveAuthSig: '0x' + 'dd'.repeat(65),
      latestReserveDeadline: 1_700_003_600,
      reserveAuthPending: true,
      confirmedReserveAmount: '0',
    });
    store.upsertChannel(channel);

    // Simulate a top-up confirming the reserve and raising the ceiling --
    // same sessionId, an UPDATE via the ON CONFLICT path, not a fresh INSERT.
    store.upsertChannel({
      ...channel,
      reserveMaxAmount: '1590000',
      confirmedReserveAmount: '1590000',
      reserveAuthPending: false,
      updatedAt: channel.updatedAt + 1000,
    });

    const read = store.getChannel(channel.sessionId);
    expect(read!.reserveMaxAmount).toBe('1590000');
    expect(read!.confirmedReserveAmount).toBe('1590000');
    expect(read!.reserveAuthPending).toBe(false);
    // Fields untouched by the update retain their original insert value.
    expect(read!.reserveSalt).toBe(channel.reserveSalt);
    expect(read!.initialReserveAmount).toBe('590000');
  });

  it('hydrates a still-pending reserve auth from a restart, so canReplayReserveAuth is reachable', () => {
    dir = mkdtempSync(join(tmpdir(), 'channel-store-reserve-'));
    const channel = makeChannel({
      reserveSalt: '0x' + 'cc'.repeat(32),
      initialReserveAmount: '590000',
      reserveMaxAmount: '590000',
      latestReserveAuthSig: '0x' + 'dd'.repeat(65),
      latestReserveDeadline: 1_700_003_600,
      reserveAuthPending: true,
      confirmedReserveAmount: '0',
    });
    {
      const store = new ChannelStore(dir);
      store.upsertChannel(channel);
    }
    // Reopen against the same on-disk file -- a fresh process would do this.
    const reopened = new ChannelStore(dir);
    const active = reopened.getActiveChannelsByBuyer(CHANNEL_ROLE.BUYER, channel.buyerEvmAddr);
    expect(active).toHaveLength(1);
    expect(active[0].reserveAuthPending).toBe(true);
    expect(active[0].reserveSalt).toBe(channel.reserveSalt);
    expect(active[0].reserveMaxAmount).toBe('590000');
  });
});

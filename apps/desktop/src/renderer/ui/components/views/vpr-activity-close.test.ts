import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DesktopBridge } from '../../../types/bridge';
import {
  channelLockedBaseUnits,
  channelCloseAction,
  compareChannelsByLockedAmount,
  cooperativeCloseRejectionMessage,
  formatChannelLockedAmount,
  isFundedCurrentChannel,
  isCurrentChannelStatus,
  requestSellerAssistedClose,
} from './vpr-activity-close';

test('channelLockedBaseUnits subtracts settled spend from the channel reserve', () => {
  assert.equal(channelLockedBaseUnits({ reserveMax: '5000000', settledUsdc: '700000' }), 4_300_000n);
  assert.equal(channelLockedBaseUnits({ reserveMax: '5000000', settledUsdc: '5000000' }), 0n);
  assert.equal(channelLockedBaseUnits({ reserveMax: '5000000', settledUsdc: '6000000' }), 0n);
  assert.equal(channelLockedBaseUnits({ reserveMax: 'invalid', settledUsdc: '0' }), 0n);
});

test('formatChannelLockedAmount distinguishes zero and sub-cent reserves', () => {
  assert.equal(formatChannelLockedAmount({ reserveMax: '619815', settledUsdc: '619815' }), 'No funds locked');
  assert.equal(formatChannelLockedAmount({ reserveMax: '9000', settledUsdc: '0' }), '<$0.01 locked');
  assert.equal(formatChannelLockedAmount({ reserveMax: '5000000', settledUsdc: '700000' }), '$4.30 locked');
});

test('compareChannelsByLockedAmount sorts highest locked amount first', () => {
  const channels = [
    { reserveMax: '2000000', settledUsdc: '0', reservedAt: 3 },
    { reserveMax: '5000000', settledUsdc: '700000', reservedAt: 1 },
    { reserveMax: '2000000', settledUsdc: '0', reservedAt: 5 },
  ].sort(compareChannelsByLockedAmount);

  assert.deepEqual(channels.map((channel) => channel.reservedAt), [1, 5, 3]);
});

test('channelCloseAction exposes seller close only for supported active channels', () => {
  assert.equal(channelCloseAction('active', true), 'seller-and-on-chain');
  assert.equal(channelCloseAction('open', true), 'seller-and-on-chain');
  assert.equal(channelCloseAction('active', false), 'on-chain');
  assert.equal(channelCloseAction('active', true, true), 'on-chain');
  assert.equal(channelCloseAction('closing', true), 'none');
  assert.equal(channelCloseAction('withdrawable', true), 'withdraw');
});

test('isCurrentChannelStatus keeps only channels that still hold funds', () => {
  for (const status of ['active', 'open', 'closing', 'withdrawable']) {
    assert.equal(isCurrentChannelStatus(status), true);
  }
  for (const status of ['settled', 'timedout', 'timeout', 'closed', 'unknown']) {
    assert.equal(isCurrentChannelStatus(status), false);
  }
});

test('isFundedCurrentChannel hides open channels with no remaining lock', () => {
  assert.equal(isFundedCurrentChannel({ status: 'active', reserveMax: '5000000', settledUsdc: '700000' }), true);
  assert.equal(isFundedCurrentChannel({ status: 'active', reserveMax: '5000000', settledUsdc: '5000000' }), false);
  assert.equal(isFundedCurrentChannel({ status: 'settled', reserveMax: '5000000', settledUsdc: '0' }), false);
});

test('cooperativeCloseRejectionMessage maps actionable rejection codes', () => {
  const base = { version: 1 as const, channelId: 'channel-1', status: 'rejected' as const };
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'busy' }), /processing a request/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'pending_auth' }), /payment authorization/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'no_channel' }), /refresh Activity/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'invalid_auth' }), /on-chain close/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'close_failed' }), /on-chain close/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'unsupported' }), /does not support/i);
});

test('requestSellerAssistedClose refreshes balances and channels after success', async () => {
  const credits = vi.fn(async () => {});
  const summary = vi.fn(async () => {});
  const bridge: DesktopBridge = {
    paymentsRequestCooperativeClose: vi.fn(async () => ({
      ok: true,
      result: { version: 1, channelId: 'channel-1', status: 'closed' },
      error: null,
    })),
  };

  const feedback = await requestSellerAssistedClose('peer-1', bridge, { credits, summary });

  assert.equal(feedback.tone, 'success');
  assert.equal(credits.mock.calls.length, 1);
  assert.equal(summary.mock.calls.length, 1);
});

test('requestSellerAssistedClose preserves success when refreshes fail', async () => {
  const credits = vi.fn(async () => { throw new Error('credits unavailable'); });
  const summary = vi.fn(async () => { throw new Error('summary unavailable'); });
  const bridge: DesktopBridge = {
    paymentsRequestCooperativeClose: vi.fn(async () => ({
      ok: true,
      result: { version: 1, channelId: 'channel-1', status: 'closed' },
      error: null,
    })),
  };

  const feedback = await requestSellerAssistedClose('peer-1', bridge, { credits, summary });

  assert.equal(feedback.tone, 'success');
  assert.equal(feedback.message, 'Seller closed the channel.');
  assert.equal(credits.mock.calls.length, 1);
  assert.equal(summary.mock.calls.length, 1);
});

test('requestSellerAssistedClose keeps rejection local and does not refresh', async () => {
  const credits = vi.fn(async () => {});
  const summary = vi.fn(async () => {});
  const bridge: DesktopBridge = {
    paymentsRequestCooperativeClose: vi.fn(async () => ({
      ok: true,
      result: { version: 1, channelId: 'channel-1', status: 'rejected', code: 'busy' },
      error: null,
    })),
  };

  const feedback = await requestSellerAssistedClose('peer-1', bridge, { credits, summary });

  assert.equal(feedback.tone, 'error');
  assert.equal(credits.mock.calls.length, 0);
  assert.equal(summary.mock.calls.length, 0);
});

test('requestSellerAssistedClose reports transport failures without refreshing', async () => {
  const credits = vi.fn(async () => {});
  const summary = vi.fn(async () => {});
  const bridge: DesktopBridge = {
    paymentsRequestCooperativeClose: vi.fn(async () => ({
      ok: false,
      result: null,
      error: 'Seller is offline.',
    })),
  };

  const feedback = await requestSellerAssistedClose('peer-1', bridge, { credits, summary });

  assert.match(feedback.message, /channel is unchanged/i);
  assert.equal(credits.mock.calls.length, 0);
  assert.equal(summary.mock.calls.length, 0);
});

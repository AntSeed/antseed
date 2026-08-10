import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DesktopBridge } from '../../../types/bridge';
import {
  channelCloseAction,
  cooperativeCloseRejectionMessage,
  requestSellerAssistedClose,
} from './vpr-activity-close';

test('channelCloseAction exposes seller close only for supported active channels', () => {
  assert.equal(channelCloseAction('active', true), 'seller-and-on-chain');
  assert.equal(channelCloseAction('open', true), 'seller-and-on-chain');
  assert.equal(channelCloseAction('active', false), 'on-chain');
  assert.equal(channelCloseAction('closing', true), 'none');
  assert.equal(channelCloseAction('withdrawable', true), 'withdraw');
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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredChannel } from '@antseed/node';
import {
  CHANNEL_CLOSE_GRACE_PERIOD_SECONDS,
  resolveBuyerChannelById,
  secondsUntilChannelWithdrawReady,
} from './channel-withdraw.js';

function channel(sessionId: string): StoredChannel {
  return {
    sessionId,
    peerId: 'peer',
    role: 'buyer',
    sellerEvmAddr: '0x' + '11'.repeat(20),
    buyerEvmAddr: '0x' + '22'.repeat(20),
    nonce: 0,
    authMax: '1000000',
    previousConsumption: '0',
    tokensDelivered: '0',
    deadline: 0,
    previousSessionId: '',
    requestCount: 0,
    reservedAt: 0,
    settledAt: null,
    settledAmount: null,
    status: 'active',
    latestBuyerSig: null,
    latestSpendingAuthSig: null,
    latestMetadata: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

test('resolveBuyerChannelById accepts exact ids and unique prefixes', () => {
  const first = channel('0x' + 'aa'.repeat(32));
  const second = channel('0x' + 'bb'.repeat(32));

  assert.equal(resolveBuyerChannelById([first, second], first.sessionId), first);
  assert.equal(resolveBuyerChannelById([first, second], '0xaaaa'), first);
});

test('resolveBuyerChannelById rejects ambiguous prefixes', () => {
  const first = channel('0xaaaa' + '11'.repeat(30));
  const second = channel('0xaaaa' + '22'.repeat(30));

  assert.throws(
    () => resolveBuyerChannelById([first, second], '0xaaaa'),
    /ambiguous/i,
  );
});

test('secondsUntilChannelWithdrawReady tracks 15 minute timeout grace period', () => {
  assert.equal(
    secondsUntilChannelWithdrawReady(0n, 100),
    CHANNEL_CLOSE_GRACE_PERIOD_SECONDS,
  );
  assert.equal(
    secondsUntilChannelWithdrawReady(100n, 100 + CHANNEL_CLOSE_GRACE_PERIOD_SECONDS - 1),
    1,
  );
  assert.equal(
    secondsUntilChannelWithdrawReady(100n, 100 + CHANNEL_CLOSE_GRACE_PERIOD_SECONDS),
    0,
  );
});

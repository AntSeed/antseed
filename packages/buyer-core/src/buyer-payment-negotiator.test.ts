import { describe, expect, it, vi } from 'vitest';
import { encodeBase64, toUtf8Bytes } from 'ethers';
import { BuyerPaymentNegotiator } from './buyer-payment-negotiator.js';
import type { BuyerConnection, BuyerPeerView } from './interfaces.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';

describe('BuyerPaymentNegotiator', () => {
  it('decodes a browser-compatible external spending auth header', async () => {
    const payload = {
      channelId: `0x${'1'.repeat(64)}`,
      cumulativeAmount: '1000',
      metadataHash: `0x${'2'.repeat(64)}`,
      metadata: '0x00',
      spendingAuthSig: '0x1234',
    };
    const headerValue = encodeBase64(toUtf8Bytes(JSON.stringify(payload)));
    const sendSpendingAuth = vi.fn();
    const emit = vi.fn();
    const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
    const internals = negotiator as unknown as {
      getOrCreatePaymentMux: () => { sendSpendingAuth: typeof sendSpendingAuth };
      _resolveSellerAddr: () => Promise<string>;
      _channelStore: null;
      _waitForLockConfirmation: () => Promise<void>;
      _lockedPeers: Set<string>;
      _emit: { emit: typeof emit };
    };
    internals.getOrCreatePaymentMux = () => ({ sendSpendingAuth });
    internals._resolveSellerAddr = async () => `0x${'3'.repeat(40)}`;
    internals._channelStore = null;
    internals._waitForLockConfirmation = async () => {};
    internals._lockedPeers = new Set();
    internals._emit = { emit };

    const peer: BuyerPeerView = { peerId: toPeerId('4'.repeat(40)) };
    const connection = {
      state: ConnectionState.Connected,
      send: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as BuyerConnection;
    await negotiator.applyExternalSpendingAuth(peer, connection, headerValue);

    expect(sendSpendingAuth).toHaveBeenCalledWith(payload);
    expect(emit).toHaveBeenCalledWith('payment:signed', {
      peerId: peer.peerId,
      sellerEvmAddr: `0x${'3'.repeat(40)}`,
      amount: payload.cumulativeAmount,
    });
  });
});

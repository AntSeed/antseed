import { describe, expect, it, vi } from 'vitest';
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
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const headerValue = btoa(Array.from(payloadBytes, (byte) => String.fromCharCode(byte)).join(''));
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

  it('persists and flushes the signed auth before transmitting it', async () => {
    const payload = {
      channelId: `0x${'1'.repeat(64)}`,
      cumulativeAmount: '1000',
      metadataHash: `0x${'2'.repeat(64)}`,
      metadata: '0x00',
      spendingAuthSig: '0x1234',
    };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const headerValue = btoa(Array.from(payloadBytes, (byte) => String.fromCharCode(byte)).join(''));

    const events: string[] = [];
    const upsertChannel = vi.fn((channel: { latestSpendingAuthSig: string | null; latestMetadata: string | null }) => {
      events.push('upsert');
      return channel;
    });
    // Async flush that only settles on a later macrotask: if the negotiator
    // transmitted without awaiting the durability barrier, 'send' would be
    // recorded before 'flush:end'.
    const flush = vi.fn(() => {
      events.push('flush:start');
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          events.push('flush:end');
          resolve();
        }, 10);
      });
    });
    const sendSpendingAuth = vi.fn(() => {
      events.push('send');
    });

    const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
    const internals = negotiator as unknown as {
      getOrCreatePaymentMux: () => { sendSpendingAuth: typeof sendSpendingAuth };
      _resolveSellerAddr: () => Promise<string>;
      _channelStore: { upsertChannel: typeof upsertChannel; flush: typeof flush };
      _identity: { wallet: { address: string } };
      _waitForLockConfirmation: () => Promise<void>;
      _lockedPeers: Set<string>;
      _emit: { emit: ReturnType<typeof vi.fn> };
    };
    internals.getOrCreatePaymentMux = () => ({ sendSpendingAuth });
    internals._resolveSellerAddr = async () => `0x${'3'.repeat(40)}`;
    internals._channelStore = { upsertChannel, flush };
    internals._identity = { wallet: { address: `0x${'4'.repeat(40)}` } };
    internals._waitForLockConfirmation = async () => {};
    internals._lockedPeers = new Set();
    internals._emit = { emit: vi.fn() };

    const peer: BuyerPeerView = { peerId: toPeerId('4'.repeat(40)) };
    const connection = {
      state: ConnectionState.Connected,
      send: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as BuyerConnection;
    await negotiator.applyExternalSpendingAuth(peer, connection, headerValue);

    // The signed authorization must be durably persisted before the seller
    // can ever see it — a crash after transmit must not lose the signature.
    expect(events).toEqual(['upsert', 'flush:start', 'flush:end', 'send']);
    expect(upsertChannel).toHaveBeenCalledWith(expect.objectContaining({
      latestSpendingAuthSig: payload.spendingAuthSig,
      latestMetadata: payload.metadata,
    }));
  });
});

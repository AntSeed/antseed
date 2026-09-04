import { describe, expect, it, vi } from 'vitest';
import { BuyerPaymentNegotiator } from './buyer-payment-negotiator.js';
import type { BuyerConnection, BuyerPeerView } from './interfaces.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';

describe('BuyerPaymentNegotiator', () => {
  it('rejects changed discovery prices before authorizing payment', async () => {
    const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
    Object.assign(negotiator, { _lockedPeers: new Set(), _bpm: { getActiveSession: () => null } });
    const peer: BuyerPeerView = {
      peerId: toPeerId('4'.repeat(40)),
      providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
    };
    const response = {
      requestId: 'request', statusCode: 402, headers: {},
      body: new TextEncoder().encode(JSON.stringify({
        minBudgetPerRequest: '100', suggestedAmount: '1000',
        providerPricing: { openai: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 } } },
      })),
    };
    await expect(negotiator.handle402(response, peer, {} as BuyerConnection, { requestId: 'request', method: 'POST', path: '/', headers: {}, body: new Uint8Array() }))
      .rejects.toMatchObject({ code: 'peer-pricing-changed' });
  });

  it('uses agreed session prices even when the newly selected route advertises different rates', () => {
    const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
    const trackRequestBilling = vi.fn();
    const agreed = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
    Object.assign(negotiator, { _bpm: { getSessionPricing: () => agreed, trackRequestBilling } });
    negotiator.trackRequestBillingContext({ requestId: 'request', method: 'POST', path: '/v1/chat/completions', headers: {}, body: new Uint8Array() }, 'model', {
      sellerPeerId: '4'.repeat(40), provider: 'openai', service: 'model', serviceApiProtocol: 'openai-chat-completions', tokenPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
    });
    expect(trackRequestBilling).toHaveBeenCalledWith('request', expect.objectContaining({ tokenPricing: agreed }));
  });
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
    const adoptPersistedAuthorization = vi.fn(() => {
      events.push('adopt');
    });

    const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
    const internals = negotiator as unknown as {
      getOrCreatePaymentMux: () => { sendSpendingAuth: typeof sendSpendingAuth };
      _resolveSellerAddr: () => Promise<string>;
      _channelStore: { upsertChannel: typeof upsertChannel; flush: typeof flush };
      _bpm: { adoptPersistedAuthorization: typeof adoptPersistedAuthorization };
      _identity: { wallet: { address: string } };
      _waitForLockConfirmation: () => Promise<void>;
      _lockedPeers: Set<string>;
      _emit: { emit: ReturnType<typeof vi.fn> };
    };
    internals.getOrCreatePaymentMux = () => ({ sendSpendingAuth });
    internals._resolveSellerAddr = async () => `0x${'3'.repeat(40)}`;
    internals._channelStore = { upsertChannel, flush };
    internals._bpm = { adoptPersistedAuthorization };
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
    expect(events).toEqual(['upsert', 'flush:start', 'flush:end', 'adopt', 'send']);
    expect(upsertChannel).toHaveBeenCalledWith(expect.objectContaining({
      latestSpendingAuthSig: payload.spendingAuthSig,
      latestMetadata: payload.metadata,
    }));
    expect(upsertChannel.mock.calls[0]?.[0]).not.toHaveProperty('reserveAuthPending');
    expect(adoptPersistedAuthorization).toHaveBeenCalledWith(upsertChannel.mock.calls[0]?.[0]);
  });
});

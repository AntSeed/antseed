import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator } from '../src/payments/buyer-payment-negotiator.js';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import { DepositsClient } from '../src/payments/evm/deposits-client.js';
import type { ChannelsClient } from '../src/payments/evm/channels-client.js';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { createPerCallBillingModel } from '../src/types/billing.js';
import { ConnectionState } from '../src/types/connection.js';
import { toPeerId, type PeerInfo } from '../src/types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';

const encoder = new TextEncoder();
const sellerPeerId = toPeerId('b'.repeat(40));

describe('bounded routing payment recovery', () => {
  let directory: string;
  let store: ChannelStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'routing-recovery-'));
    store = new ChannelStore(directory);
    vi.spyOn(DepositsClient.prototype, 'getBuyerBalance').mockResolvedValue({
      available: 1_000_000n, reserved: 0n, lastActivityAt: 0n,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function setup(kind: 'per_call' | 'tokens', reserve = 100_000n) {
    const wallet = Wallet.createRandom();
    const identity = { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), wallet };
    const manager = new BuyerPaymentManager(identity, {
      rpcUrl: 'http://127.0.0.1:8545', depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: '0x' + 'cc'.repeat(20), usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20), chainId: 31337,
      defaultAuthDurationSecs: 3600, maxPerRequestUsdc: 100_000n, maxReserveAmountUsdc: reserve,
      dataDir: directory,
    }, store);
    const pricing = kind === 'per_call'
      ? { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
      : { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
    const finish = manager.beginRoutingRequest({
      sellerPeerId, requestId: 'classification', parentRequestId: 'inference', service: 'classifier',
      maxAdditionalAuthorizationUsdc: 5000n, signal: new AbortController().signal, maxPricing: pricing,
      ...(kind === 'per_call' ? { perCallAmountUsdc: 5000n } : {}),
    });
    const connection = { state: ConnectionState.Open, send: vi.fn(), on: vi.fn(), off: vi.fn() };
    const paymentMux = new PaymentMux(connection);
    const channelId = await manager.authorizeSpending(sellerPeerId, paymentMux, 1n, pricing);
    await manager.handleAuthAck(sellerPeerId, { channelId });
    const channels = { getSession: vi.fn().mockResolvedValue({
      buyer: wallet.address, seller: '0x' + sellerPeerId, deposit: reserve, settled: 0n,
      metadataHash: '0x' + '00'.repeat(32), deadline: 0n, settledAt: 0n, closeRequestedAt: 0n, status: 1,
    }) } as unknown as ChannelsClient;
    const negotiator = new BuyerPaymentNegotiator(identity, manager, null, channels, store, {}, { emit: vi.fn() });
    vi.spyOn(negotiator, 'getOrCreatePaymentMux').mockReturnValue(paymentMux);
    const sendAuth = vi.spyOn(paymentMux, 'sendSpendingAuth').mockImplementation(() => {
      void manager.handleAuthAck(sellerPeerId, { channelId });
    });
    const request: SerializedHttpRequest = {
      requestId: 'classification', method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'x-antseed-provider': 'openai' },
      body: encoder.encode(JSON.stringify({ model: 'classifier', messages: [{ role: 'user', content: 'classify' }] })),
    };
    const peer: PeerInfo = {
      peerId: sellerPeerId, lastSeen: Date.now(), providers: ['openai'],
      providerPricing: { openai: { defaults: pricing, services: {} } },
      ...(kind === 'per_call' ? { providerServiceUnitBillingModels: { openai: { services: {
        classifier: { 'openai-chat-completions': createPerCallBillingModel('5000') },
      } } } } : {}),
    };
    const classification: SerializedHttpResponse = {
      requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify({ choices: [{ message: { content: '{"route":"fast"}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 } })),
    };
    const paymentRequired: SerializedHttpResponse = {
      requestId: request.requestId, statusCode: 402, headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify({ error: 'payment_required', minBudgetPerRequest: '10000', suggestedAmount: '100000' })),
    };
    const responses = [paymentRequired, classification];
    const dispatchedAmounts: bigint[] = [];
    const proxyMux = {
      sendProxyRequest: vi.fn((_request: SerializedHttpRequest, onResponse: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void) => {
        dispatchedAmounts.push(manager.getCumulativeAmount(sellerPeerId));
        onResponse(responses.shift()!, { streamingStart: false });
      }),
      cancelProxyRequest: vi.fn(),
    };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: identity.peerId, negotiator, verificationStorage: null, verificationSampler: null,
      getConnection: async () => connection, getMux: () => proxyMux as any,
      getVerificationMux: () => ({} as any), registerPaymentMux: vi.fn(),
    });
    const options = { routingAuthorization: {
      parentRequestId: 'inference', maxAdditionalAuthorizationUsdc: '5000',
      ...(kind === 'per_call' ? { billing: { kind: 'per_call' as const, amountMicroUsdc: '5000' }, validateResponse: () => true } : {}),
    } };
    return { manager, negotiator, connection, handler, peer, request, options, classification, paymentRequired,
      sendAuth, dispatchedAmounts, responses, finish };
  }

  it.each(['per_call', 'tokens'] as const)('recovers a base 402 without prepaying a scoped %s request', async (kind) => {
    const state = await setup(kind);
    const extend = vi.spyOn(state.manager, 'extendCurrentSpendingAuth');
    const response = await state.handler.sendRequest(state.peer, state.request, undefined, state.options);
    expect(response).toEqual(state.classification);
    expect(state.dispatchedAmounts).toEqual([0n, 0n]);
    expect(extend).not.toHaveBeenCalled();
    expect(state.sendAuth.mock.calls.map(([payload]) => payload.cumulativeAmount))
      .toEqual(['0', kind === 'per_call' ? '5000' : '140']);
    expect(state.manager.getCumulativeAmount(sellerPeerId)).toBe(kind === 'per_call' ? 5000n : 140n);
    state.finish();
  });

  it.each(['per_call', 'tokens'] as const)('replays the previously paid %s authorization without consuming the next grant', async (kind) => {
    const state = await setup(kind);
    await state.handler.sendRequest(state.peer, state.request, undefined, state.options);
    state.finish();
    const finish = state.manager.beginRoutingRequest({
      sellerPeerId, requestId: 'classification-2', parentRequestId: 'inference', service: 'classifier',
      maxAdditionalAuthorizationUsdc: 5000n, signal: new AbortController().signal,
      ...(kind === 'per_call' ? { perCallAmountUsdc: 5000n } : {}),
    });
    state.responses.push({ ...state.paymentRequired, requestId: 'classification-2' },
      { ...state.classification, requestId: 'classification-2' });
    const response = await state.handler.sendRequest(state.peer,
      { ...state.request, requestId: 'classification-2' }, undefined, state.options);
    const cost = kind === 'per_call' ? 5000n : 140n;
    expect(response.statusCode).toBe(200);
    expect(state.dispatchedAmounts).toEqual([0n, 0n, cost, cost]);
    expect(state.sendAuth.mock.calls[2]![0]).toEqual(state.sendAuth.mock.calls[1]![0]);
    expect(state.manager.getCumulativeAmount(sellerPeerId)).toBe(cost * 2n);
    finish();
  });

  it.each([
    { failure: 'rpc', retry: true }, { failure: 'balance', retry: true },
    { failure: 'rpc', retry: false }, { failure: 'balance', retry: false },
  ])('returns a paid classification when reserve maintenance encounters $failure (retry=$retry)', async ({ failure, retry }) => {
    const state = await setup('per_call', 6000n);
    if (!retry) {
      await state.negotiator.handle402(state.responses.shift()!, state.peer, state.connection, state.request);
      state.sendAuth.mockClear();
    }
    const balance = vi.spyOn(state.manager, 'getBalance');
    if (failure === 'rpc') balance.mockRejectedValue(new Error('RPC unavailable'));
    else balance.mockResolvedValue({ available: 0n, reserved: 6000n });
    const topUp = vi.spyOn(state.manager, 'topUpReserve');
    const response = await state.handler.sendRequest(state.peer, state.request, undefined, state.options);
    expect(response).toEqual(state.classification);
    expect(topUp).toHaveBeenCalledOnce();
    const expectedAmounts = retry ? ['0', '5000'] : ['5000'];
    if (failure === 'rpc') expectedAmounts.push('5000');
    expect(state.sendAuth.mock.calls.map(([payload]) => payload.cumulativeAmount)).toEqual(expectedAmounts);
    expect(state.manager.getReserveCeiling(sellerPeerId)).toBe(failure === 'rpc' ? 12000n : 6000n);
    expect(state.manager.hasPendingReserveAuth(sellerPeerId)).toBe(failure === 'rpc');
    expect(state.manager.getCumulativeAmount(sellerPeerId)).toBe(5000n);
    await state.negotiator.sendPostResponseAuth(state.peer, state.connection);
    expect(state.sendAuth).toHaveBeenCalledTimes(expectedAmounts.length);
    expect(topUp).toHaveBeenCalledOnce();
    state.finish();
  });

  it.each(['sign', 'send'])('still rejects when post-response auth %s fails', async (failure) => {
    const state = await setup('per_call', 6000n);
    const error = new Error(`${failure} failed`);
    const topUp = vi.spyOn(state.manager, 'topUpReserve');
    if (failure === 'sign') vi.spyOn(state.manager, 'signPerRequestAuth').mockRejectedValue(error);
    else state.sendAuth.mockImplementation((payload) => {
      if (payload.cumulativeAmount !== '0') throw error;
      void state.manager.handleAuthAck(sellerPeerId, { channelId: payload.channelId });
    });
    await expect(state.handler.sendRequest(state.peer, state.request, undefined, state.options)).rejects.toBe(error);
    expect(topUp).not.toHaveBeenCalled();
    state.finish();
  });
});

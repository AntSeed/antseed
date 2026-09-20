import { describe, expect, it, vi } from 'vitest';
import { createRoutingServiceMetadata } from '@antseed/protocol';
import { captureUnitBillingContext } from '../src/billing/unit.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { SellerPaymentManager } from '../src/payments/seller-payment-manager.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import type { UnitBillingModelV1 } from '../src/types/billing.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import { MessageType, PAYMENT_CODE_CHANNEL_EXHAUSTED } from '../src/types/protocol.js';
import type { ServiceApiProtocol } from '../src/types/service-api.js';
import { VerificationMux } from '../src/verification/verification-mux.js';

const perCallModel: UnitBillingModelV1 = {
  version: 1,
  components: [{ unit: 'successful_requests', priceUsd: 0.005 }],
};
const imageModel: UnitBillingModelV1 = {
  version: 1,
  components: [{ unit: 'output_images', priceUsd: 0.04 }],
};
const buyerPeerId = '22'.repeat(20);

function makeHarness(model: UnitBillingModelV1, remainingReserve: bigint, images = false) {
  const protocol: ServiceApiProtocol = images ? 'openai-images' : 'openai-chat-completions';
  const request: SerializedHttpRequest = {
    requestId: 'req-reserve-estimate',
    method: 'POST',
    path: images ? '/v1/images/generations' : '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'test-model', ...(images ? { n: 2 } : {}) })),
  };
  const handleRequest = vi.fn(async (incoming: SerializedHttpRequest) => ({
    requestId: incoming.requestId,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(images
      ? { data: [{ b64_json: 'first' }, { b64_json: 'second' }] }
      : { choices: [{ message: { role: 'assistant', content: 'ok' } }] })),
  }));
  const provider: Provider = {
    name: 'test-provider',
    services: ['test-model'],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    serviceApiProtocols: { 'test-model': [protocol] },
    serviceUnitBillingModels: { 'test-model': { [protocol]: model } },
    maxConcurrency: 1,
    handleRequest,
    getCapacity: () => ({ current: 0, max: 1 }),
  };
  let spent = 4_000n;
  const reserveMax = spent + remainingReserve;
  const sellerPaymentManager = {
    hasSession: () => true,
    getChannelByPeer: () => ({ sessionId: 'session-1', authMax: reserveMax.toString() }),
    waitForPendingAuths: vi.fn(async () => {}),
    getAcceptedCumulative: () => 4_000n,
    getCumulativeSpend: () => spent,
    getEffectiveReserveMax: () => reserveMax,
    isChannelBlocked: () => false,
    hasClosingChannel: () => false,
    getPaymentRequirements: () => ({ minBudgetPerRequest: '5000', suggestedAmount: '1000000' }),
    settleSession: vi.fn(async () => {}),
    beginBillableRequest: vi.fn(),
    endBillableRequest: vi.fn(),
    recordSpend: vi.fn((_sessionId: string, cost: bigint) => { spent += cost; }),
  };
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [provider],
    sellerPaymentManager: sellerPaymentManager as unknown as SellerPaymentManager,
    reserveEstimateOverdraftUsdc: 0n,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit: () => false,
  });
  const conn = {
    send: vi.fn(),
    hasRemoteCapability: () => false,
  } as unknown as PeerConnection;
  const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() };
  const { mux } = handler.handleConnection(
    conn, buyerPeerId, paymentMux as unknown as PaymentMux, new VerificationMux(conn),
  );
  const sendProxyResponse = vi.spyOn(mux, 'sendProxyResponse');
  const requestBilling = captureUnitBillingContext({
    sellerPeerId: 'seller',
    provider: provider.name,
    service: 'test-model',
    serviceApiProtocol: protocol,
    request,
  });

  return {
    handler, requestBilling, handleRequest, sellerPaymentManager, paymentMux, provider, request,
    async serve() {
      await mux.handleFrame({
        type: MessageType.HttpRequest,
        messageId: 1,
        payload: encodeHttpRequest(request),
      });
      expect(sendProxyResponse).toHaveBeenCalledOnce();
      const frame = vi.mocked(conn.send).mock.calls[0]![0];
      return decodeHttpResponse(decodeFrame(frame)!.message.payload);
    },
  };
}

describe('seller reserve estimates', () => {
  it.each(['stale-schema', 'invalid-preferences', 'alternate-path', 'wrong-method', 'uppercase-path-stale-schema'])('rejects routing %s before billing or provider dispatch', async (reason) => {
    const harness = makeHarness(perCallModel, 10000n);
    const metadata = createRoutingServiceMetadata({ type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' } } });
    harness.provider.serviceApiProtocols = { 'test-model': ['antseed-routing'] };
    harness.provider.serviceRouting = { 'test-model': metadata };
    harness.request.path = reason === 'alternate-path' ? '/v1/chat/completions'
      : reason === 'uppercase-path-stale-schema' ? '/V1/ROUTE' : '/v1/route';
    if (reason === 'wrong-method') harness.request.method = 'GET';
    harness.request.body = new TextEncoder().encode(JSON.stringify({
      version: 1, service: 'test-model', preferencesSchemaHash: reason.includes('stale-schema') ? 'stale' : metadata.preferencesSchemaHash,
      request: { path: '/v1/chat/completions', body: {} },
      candidates: [{ serviceId: 'model-a', peerId: buyerPeerId, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }],
      preferences: reason === 'invalid-preferences' ? { enabled: 'true' } : {},
    }));
    const response = await harness.serve();
    expect(response.statusCode).toBe(400);
    expect(harness.handleRequest).not.toHaveBeenCalled();
    expect(harness.sellerPaymentManager.beginBillableRequest).not.toHaveBeenCalled();
    expect(harness.sellerPaymentManager.recordSpend).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendNeedAuth).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
  });

  it('estimates one per-call fee from captured request usage', () => {
    const { handler, requestBilling } = makeHarness(perCallModel, 1_000n);

    expect(requestBilling.requestUsage.units.successful_requests).toBe(1);
    expect(handler['_estimateUnitRequestCostUsdc'](requestBilling, perCallModel)).toEqual({
      cost: 5_000n, inputTokens: 0, maxOutputTokens: 0,
    });
  });

  it('rejects before forwarding when remaining reserve is 1000 and the per-call fee is 5000', async () => {
    const harness = makeHarness(perCallModel, 1_000n);
    const response = await harness.serve();

    expect(response.statusCode).toBe(402);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toMatchObject({
      code: PAYMENT_CODE_CHANNEL_EXHAUSTED,
      requiredCumulativeAmount: '4000',
      estimatedRequestCost: '5000',
      remainingLockedReserve: '1000',
    });
    expect(harness.handleRequest).not.toHaveBeenCalled();
    expect(harness.sellerPaymentManager.beginBillableRequest).not.toHaveBeenCalled();
    expect(harness.sellerPaymentManager.recordSpend).not.toHaveBeenCalled();
    expect(harness.sellerPaymentManager.settleSession).toHaveBeenCalledWith(buyerPeerId);
    expect(harness.paymentMux.sendNeedAuth).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).toHaveBeenCalledWith(expect.objectContaining({
      code: PAYMENT_CODE_CHANNEL_EXHAUSTED,
      requiredCumulativeAmount: '4000',
    }));
  });

  it.each([5_000n, 10_000n])('serves a per-call request with %s remaining reserve', async (remainingReserve) => {
    const harness = makeHarness(perCallModel, remainingReserve);
    const response = await harness.serve();

    expect(response.statusCode).toBe(200);
    expect(harness.handleRequest).toHaveBeenCalledOnce();
    expect(harness.sellerPaymentManager.recordSpend).toHaveBeenCalledWith('session-1', 5_000n);
    expect(harness.sellerPaymentManager.settleSession).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
    expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({
      lastRequestCost: '5000',
      billingUsage: { version: 1, units: { successful_requests: '1' } },
    }));
  });

  it('preserves image count estimates and serves images with sufficient reserve', async () => {
    const harness = makeHarness(imageModel, 80_000n, true);

    expect(harness.handler['_estimateUnitRequestCostUsdc'](harness.requestBilling, imageModel)).toEqual({
      cost: 80_000n, inputTokens: 0, maxOutputTokens: 0,
    });
    expect((await harness.serve()).statusCode).toBe(200);
    expect(harness.sellerPaymentManager.recordSpend).toHaveBeenCalledWith('session-1', 80_000n);
    expect(harness.paymentMux.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({
      lastRequestCost: '80000',
      billingUsage: { version: 1, units: { output_images: '2' } },
    }));
  });

  it('estimates only the per-call fee for an image request billed per call', async () => {
    const harness = makeHarness(perCallModel, 5_000n, true);

    expect(harness.requestBilling.requestUsage.units.output_images).toBe(2);
    expect(harness.handler['_estimateUnitRequestCostUsdc'](harness.requestBilling, perCallModel).cost).toBe(5_000n);
    expect((await harness.serve()).statusCode).toBe(200);
    expect(harness.sellerPaymentManager.recordSpend).toHaveBeenCalledWith('session-1', 5_000n);
  });
});

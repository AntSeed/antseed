import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler, stripPeerControlledResponseHeaders } from '../src/buyer-request-handler.js';
import { ConnectionState } from '../src/types/connection.js';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '../src/types/http.js';
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from '../src/types/http.js';
import type { PeerInfo } from '../src/types/peer.js';
import { FIXED_FEE_CONTRACT_HEADER, FIXED_FEE_PRICE_HEADER } from '@antseed/protocol/fixed-fee';

describe('explicit fixed-fee buyer requests', () => {
  const offer = { provider: 'levanto', service: 'levanto-route', contract: 'levanto-routing-v1', priceMicroUsdc: '1000' };
  const peer = { peerId: 'a'.repeat(40) } as PeerInfo;
  const request = {
    requestId: 'fixed', method: 'POST', path: '/_antseed/route',
    headers: { 'x-antseed-provider': offer.provider, [FIXED_FEE_CONTRACT_HEADER]: offer.contract, [FIXED_FEE_PRICE_HEADER]: offer.priceMicroUsdc },
    body: new TextEncoder().encode(JSON.stringify({ service: offer.service, v: 1, cqt: 5, inputMessage: 'Help', promptTokens: 1, expectedCachedTokens: [], constraints: {} })),
  };
  const validResponse = { v: 1, router: 'levanto', ranked: [{ model: 'model-a', peer: 'b'.repeat(40), estimate: { costUsd: 0.01, inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 }, price: { inUsdPerM: 1, outUsdPerM: 2, cachedInUsdPerM: 0 } }] };
  function setup(responses = [{ statusCode: 200, body: validResponse as unknown }], enabled = true) {
    const bpm = { trackFixedFeeRequest: vi.fn(), observeFixedFeeResponse: vi.fn(), authorizeFixedFeeResponse: vi.fn(async () => {}) };
    const negotiator = { bpm, getOrCreatePaymentMux: vi.fn(() => ({})), negotiateFixedFeePayment: vi.fn(async () => true), handle402: vi.fn(), estimateCostFromResponse: vi.fn(), trackRequestService: vi.fn() };
    const mux = { cancelProxyRequest: vi.fn(), sendProxyRequest: vi.fn((req, onResponse) => {
      const response = responses.shift()!;
      onResponse({ requestId: req.requestId, statusCode: response.statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(response.body)) }, { streamingStart: false });
    }) };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: 'b'.repeat(40), negotiator: enabled ? negotiator as any : null,
      verificationStorage: null, verificationSampler: null,
      getConnection: async () => ({ state: ConnectionState.Open }) as any, getMux: () => mux as any,
      getVerificationMux: () => ({} as any), registerPaymentMux: vi.fn(),
    });
    const acceptResponse = vi.fn((response: SerializedHttpResponse) => JSON.stringify(JSON.parse(new TextDecoder().decode(response.body))) === JSON.stringify(validResponse));
    return { handler, bpm, negotiator, mux, acceptResponse, send: (signal?: AbortSignal) => handler.sendRequest(peer, request, undefined, { fixedFee: offer, signal, acceptResponse }) };
  }
  it('validates delivery and authorizes without token estimates', async () => {
    const harness = setup();
    expect((await harness.send()).statusCode).toBe(200);
    expect(harness.bpm.observeFixedFeeResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', true);
    expect(harness.bpm.authorizeFixedFeeResponse).toHaveBeenCalledOnce();
    expect(harness.negotiator.estimateCostFromResponse).not.toHaveBeenCalled();
  });
  it('executes a non-Levanto contract through the same request and payment path', async () => {
    const state = setup([{ statusCode: 200, body: { summary: 'Done' } }]);
    const summaryOffer = { provider: 'summarizer', service: 'summary', contract: 'summary-v1', priceMicroUsdc: '1000' };
    const response = await state.handler.sendRequest(peer, {
      ...request, path: '/summary',
      headers: { 'content-type': 'application/json', 'x-antseed-provider': summaryOffer.provider,
        [FIXED_FEE_CONTRACT_HEADER]: summaryOffer.contract, [FIXED_FEE_PRICE_HEADER]: summaryOffer.priceMicroUsdc },
      body: new TextEncoder().encode(JSON.stringify({ service: 'summary', text: 'Hello' })),
    }, undefined, {
      fixedFee: summaryOffer,
      acceptResponse: response => JSON.parse(new TextDecoder().decode(response.body)).summary === 'Done',
    });
    expect(response.statusCode).toBe(200);
    expect(state.bpm.trackFixedFeeRequest).toHaveBeenCalledWith(peer.peerId, 'fixed', summaryOffer);
    expect(state.bpm.authorizeFixedFeeResponse).toHaveBeenCalledOnce();
  });
  it('isolates validator mutations and rejects non-boolean asynchronous acceptance', async () => {
    const state = setup();
    state.acceptResponse.mockImplementation(response => {
      response.body.fill(0);
      response.statusCode = 500;
      return true;
    });
    expect((await state.send()).statusCode).toBe(200);
    const asynchronous = setup();
    asynchronous.acceptResponse.mockImplementation(() => Promise.resolve(true) as unknown as boolean);
    await expect(asynchronous.send()).rejects.toThrow('not accepted');
    expect(asynchronous.bpm.authorizeFixedFeeResponse).not.toHaveBeenCalled();
  });
  it('requires an acceptance callback and respects cancellation during validation', async () => {
    const missing = setup();
    await expect(missing.handler.sendRequest(peer, request, undefined, { fixedFee: offer })).rejects.toThrow('response acceptance');
    expect(missing.mux.sendProxyRequest).not.toHaveBeenCalled();
    const state = setup();
    const abort = new AbortController();
    state.acceptResponse.mockImplementation(() => { abort.abort(); return true; });
    await expect(state.send(abort.signal)).rejects.toThrow('not accepted');
    expect(state.bpm.observeFixedFeeResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', false);
    expect(state.bpm.authorizeFixedFeeResponse).not.toHaveBeenCalled();
  });
  it('retries only initial payment negotiation, not upstream errors', async () => {
    const harness = setup([{ statusCode: 402, body: {} }, { statusCode: 200, body: validResponse }]);
    expect((await harness.send()).statusCode).toBe(200);
    expect(harness.mux.sendProxyRequest).toHaveBeenCalledTimes(2);
    expect(harness.negotiator.handle402).not.toHaveBeenCalled();
    const failed = setup([{ statusCode: 503, body: {} }]);
    expect((await failed.send()).statusCode).toBe(503);
    expect(failed.mux.sendProxyRequest).toHaveBeenCalledOnce();
    expect(failed.bpm.authorizeFixedFeeResponse).not.toHaveBeenCalled();
  });
  it('does not pay for invalid JSON schemas or day-pass responses', async () => {
    for (const body of [{}, { ...validResponse, renewalDue: true }, { ...validResponse, ranked: [] }]) {
      const harness = setup([{ statusCode: 200, body }]);
      await expect(harness.send()).rejects.toThrow();
      expect(harness.bpm.observeFixedFeeResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', false);
      expect(harness.bpm.authorizeFixedFeeResponse).not.toHaveBeenCalled();
    }
  });
  it('marks negotiation failures and cancellations unbillable', async () => {
    const harness = setup([{ statusCode: 402, body: {} }]);
    harness.negotiator.negotiateFixedFeePayment.mockRejectedValue(new Error('negotiation failed'));
    await expect(harness.send()).rejects.toThrow('negotiation failed');
    expect(harness.bpm.observeFixedFeeResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', false);
    const cancelled = setup();
    await expect(cancelled.send(AbortSignal.abort())).rejects.toThrow('aborted');
    expect(cancelled.bpm.observeFixedFeeResponse).toHaveBeenCalledWith(peer.peerId, 'fixed', false);
    expect(cancelled.mux.sendProxyRequest).not.toHaveBeenCalled();
  });
  it('requires payments and forbids streaming/external auth before dispatch', async () => {
    const disabled = setup(undefined, false);
    await expect(disabled.send()).rejects.toThrow('payments must be enabled');
    expect(disabled.mux.sendProxyRequest).not.toHaveBeenCalled();
    const harness = setup();
    await expect(harness.handler.sendRequest(peer, request, {}, { fixedFee: offer })).rejects.toThrow('non-streaming');
    await expect(harness.handler.sendRequest(peer, { ...request, headers: { ...request.headers, 'X-Antseed-Spending-Auth': 'external' } }, undefined, { fixedFee: offer })).rejects.toThrow('non-streaming');
    expect(harness.mux.sendProxyRequest).not.toHaveBeenCalled();
  });
});

describe('buyer request response sanitization', () => {
  it('strips seller-controlled fault attribution headers', () => {
    const response: SerializedHttpResponse = {
      requestId: 'req-1',
      statusCode: 503,
      headers: {
        'content-type': 'application/json',
        'X-Antseed-Fault-Attribution': 'peer',
        'x-antseed-fault-attribution': 'buyer',
      },
      body: new Uint8Array(),
    };

    const sanitized = stripPeerControlledResponseHeaders(response);

    expect(sanitized.headers).toEqual({ 'content-type': 'application/json' });
    expect(response.headers['X-Antseed-Fault-Attribution']).toBe('peer');
    expect(response.headers['x-antseed-fault-attribution']).toBe('buyer');
  });
});

function makeImageRequest(): SerializedHttpRequest {
  return {
    requestId: 'req-image-v10',
    method: 'POST',
    path: '/v1/images/generations',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      model: 'gpt-image-1',
      prompt: 'cube',
      size: '1024x1024',
      n: 1,
    })),
  };
}

describe('BuyerRequestHandler payments-inactive 402 handling', () => {
  function makeChatRequest(): SerializedHttpRequest {
    return {
      requestId: 'req-chat-402',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'llama-3', messages: [] })),
    };
  }

  function makeHandlerWithSellerResponse(statusCode: number, body: unknown): BuyerRequestHandler {
    const proxyMux = {
      sendProxyRequest: vi.fn((req: SerializedHttpRequest, onResponse: (r: SerializedHttpResponse, m: { streamingStart: boolean }) => void) => {
        onResponse({
          requestId: req.requestId,
          statusCode,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(body)),
        }, { streamingStart: false });
      }),
      cancelProxyRequest: vi.fn(),
    };
    return new BuyerRequestHandler({}, {
      localPeerId: 'b'.repeat(40),
      negotiator: null,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
      getMux: vi.fn(() => proxyMux as any),
      getVerificationMux: vi.fn(() => ({} as any)),
      registerPaymentMux: vi.fn(),
    });
  }

  const peer: PeerInfo = {
    peerId: 'a'.repeat(40) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['openai'],
  };

  it('converts a seller 402 into a buyer-fault error when payments are not running', async () => {
    const handler = makeHandlerWithSellerResponse(402, {
      error: 'payment_required',
      minBudgetPerRequest: '10000',
      suggestedAmount: '1000000',
    });

    const response = await handler.sendRequest(peer, makeChatRequest());
    expect(response.statusCode).toBe(503);
    expect(response.headers['x-antseed-fault-attribution']).toBe('buyer');
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    expect(parsed.error).toBe('buyer_payments_inactive');
    expect(parsed.peerId).toBe(peer.peerId);
    expect(parsed.message).toMatch(/payments are not running on this buyer/);
    expect(parsed.message).toMatch(/not a balance problem/);
  });

  it('wraps a non-payment seller error with peer guidance', async () => {
    const handler = makeHandlerWithSellerResponse(402, {
      error: 'billing_configuration_error',
      message: 'No billing tier matches this request.',
    });

    const response = await handler.sendRequest(peer, makeChatRequest());
    expect(response.statusCode).toBe(402);
    expect(response.headers['x-antseed-fault-attribution']).toBe('peer');
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      error: { type: string; message: string; peer_message: string; peer_status: number };
    };
    expect(parsed.error.type).toBe('billing_configuration_error');
    expect(parsed.error.peer_message).toBe('No billing tier matches this request.');
    expect(parsed.error.peer_status).toBe(402);
    expect(parsed.error.message).toBe([
      'Oops, peer could not complete the request.',
      'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
      'Original Response: {"message":"No billing tier matches this request.","status":402}',
    ].join('\n'));
  });

  it('buffers a streaming seller error and returns the protocol-wrapped response', async () => {
    const sellerBody = new TextEncoder().encode(JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'Insufficient balance or no resource package. Please recharge.',
      },
    }));
    const proxyMux = {
      sendProxyRequest: vi.fn((
        req: SerializedHttpRequest,
        onResponse: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
        onChunk: (chunk: SerializedHttpResponseChunk) => void,
      ) => {
        onResponse({
          requestId: req.requestId,
          statusCode: 429,
          headers: {
            'content-type': 'text/event-stream',
            [ANTSEED_STREAMING_RESPONSE_HEADER]: '1',
          },
          body: new Uint8Array(),
        }, { streamingStart: true });
        onChunk({ requestId: req.requestId, data: sellerBody, done: false });
        onChunk({ requestId: req.requestId, data: new Uint8Array(), done: true });
      }),
      cancelProxyRequest: vi.fn(),
    };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: 'b'.repeat(40),
      negotiator: null,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
      getMux: vi.fn(() => proxyMux as any),
      getVerificationMux: vi.fn(() => ({} as any)),
      registerPaymentMux: vi.fn(),
    });
    const onResponseStart = vi.fn();
    const onResponseChunk = vi.fn();

    const response = await handler.sendRequest(peer, makeChatRequest(), {
      onResponseStart,
      onResponseChunk,
    }, { pinned: true });

    expect(onResponseStart).not.toHaveBeenCalled();
    expect(onResponseChunk).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(429);
    expect(response.headers['x-antseed-fault-attribution']).toBe('peer');
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      error: { message: string; antseed_pinned: boolean; peer_message: string; peer_status: number };
    };
    expect(parsed.error.antseed_pinned).toBe(true);
    expect(parsed.error.peer_message).toBe('Insufficient balance or no resource package. Please recharge.');
    expect(parsed.error.peer_status).toBe(429);
    expect(parsed.error.message).toBe([
      'Oops, pinned peer could not complete the request.',
      'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
      'Original Response: {"message":"Insufficient balance or no resource package. Please recharge.","status":429}',
    ].join('\n'));
  });
});

describe('BuyerRequestHandler billing guards', () => {
  it('rejects paid image requests when metadata lacks a service unit billing model', async () => {
    const paymentMux = {};
    const negotiator = {
      getOrCreatePaymentMux: vi.fn(() => paymentMux),
      trackRequestBillingContext: vi.fn(),
    };
    const proxyMux = {
      cancelProxyRequest: vi.fn(),
    };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: 'b'.repeat(40),
      negotiator: negotiator as any,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: vi.fn(async () => ({ state: ConnectionState.Open }) as any),
      getMux: vi.fn(() => proxyMux as any),
      getVerificationMux: vi.fn(() => ({} as any)),
      registerPaymentMux: vi.fn(),
    });
    const peer: PeerInfo = {
      peerId: 'a'.repeat(40) as PeerInfo['peerId'],
      lastSeen: Date.now(),
      providers: ['openai'],
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          services: {
            'gpt-image-1': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          },
        },
      },
      providerServiceApiProtocols: {
        openai: {
          services: {
            'gpt-image-1': ['openai-images'],
          },
        },
      },
    };

    await expect(handler.sendRequest(peer, makeImageRequest())).rejects.toThrow(
      /without service unit billing metadata/,
    );
    expect(negotiator.trackRequestBillingContext).not.toHaveBeenCalled();
  });
});

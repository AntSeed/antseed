import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { SerializedHttpResponse } from '../src/types/http.js';
import type { PeerInfo, PeerId } from '../src/types/peer.js';

describe('BuyerRequestHandler payment mux wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates buyer payment mux before sending outbound requests when payments are enabled', async () => {
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId: 'req-payment-mux',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(0),
    };

    const conn = { state: 'open' };
    const sendProxyRequest = vi.fn((
      _: SerializedHttpRequest,
      onResponse: (response: unknown, metadata: { streamingStart: boolean }) => void,
    ) => {
      onResponse({
        requestId: request.requestId,
        statusCode: 200,
        headers: {},
        body: new Uint8Array(0),
      }, { streamingStart: false });
    });

    const getOrCreatePaymentMux = vi.fn().mockReturnValue({});
    const registerPaymentMux = vi.fn();
    const handler = new BuyerRequestHandler(
      {},
      {
        negotiator: {
          getOrCreatePaymentMux,
          preparePreRequestAuth: vi.fn(),
          sendPostResponseAuth: vi.fn(),
          estimateCostFromResponse: vi.fn(),
          parseCostHeaders: vi.fn(),
          recordResponseContent: vi.fn(),
        } as any,
        getConnection: vi.fn(async () => conn) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest,
          cancelProxyRequest: vi.fn(),
        })) as any,
        registerPaymentMux,
      },
    );

    await handler.sendRequest(peer, request);

    expect(getOrCreatePaymentMux).toHaveBeenCalledWith(peer.peerId, conn);
    expect(sendProxyRequest).toHaveBeenCalledOnce();
    expect(
      getOrCreatePaymentMux.mock.invocationCallOrder[0],
    ).toBeLessThan(sendProxyRequest.mock.invocationCallOrder[0]);
  });

  it('re-negotiates on 402 even when the peer was already locked', async () => {
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId: 'req-relock',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(0),
    };

    const conn = { state: 'open' };
    const responses: SerializedHttpResponse[] = [
      {
        requestId: request.requestId,
        statusCode: 402,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          error: 'payment_required',
          minBudgetPerRequest: '10000',
          suggestedAmount: '100000',
        })),
      },
      {
        requestId: request.requestId,
        statusCode: 200,
        headers: {},
        body: new Uint8Array(0),
      },
    ];
    const sendProxyRequest = vi.fn((
      _: SerializedHttpRequest,
      onResponse: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
    ) => {
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      onResponse(next, { streamingStart: false });
    });

    const handle402 = vi.fn(async () => ({ action: 'retry' as const }));
    const handler = new BuyerRequestHandler(
      {},
      {
        negotiator: {
          getOrCreatePaymentMux: vi.fn().mockReturnValue({}),
          preparePreRequestAuth: vi.fn(),
          handle402,
          estimateCostFromResponse: vi.fn(),
          parseCostHeaders: vi.fn(),
          recordResponseContent: vi.fn(),
        } as any,
        getConnection: vi.fn(async () => conn) as any,
        getMux: vi.fn(() => ({
          sendProxyRequest,
          cancelProxyRequest: vi.fn(),
        })) as any,
        registerPaymentMux: vi.fn(),
      },
    );

    const response = await handler.sendRequest(peer, request);

    expect(response.statusCode).toBe(200);
    expect(handle402).toHaveBeenCalledOnce();
  });
});

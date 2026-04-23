import { describe, expect, it, vi } from 'vitest';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { MessageType } from '../src/types/protocol.js';

function makeProvider(inputUsdPerMillion: number, outputUsdPerMillion: number, opts: {
  name: string;
  services: string[];
  servicePricing?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
}): Provider {
  return {
    name: opts.name,
    services: opts.services,
    pricing: {
      defaults: { inputUsdPerMillion, outputUsdPerMillion },
      ...(opts.servicePricing ? { services: opts.servicePricing } : {}),
    },
    maxConcurrency: 1,
    async handleRequest(_req) {
      return {
        requestId: 'test',
        statusCode: 200,
        headers: {},
        body: new Uint8Array(0),
      };
    },
    getCapacity() {
      return { current: 0, max: 1 };
    },
  };
}

describe('SellerRequestHandler payment pricing selection', () => {
  it('matches the requested provider and service pricing instead of using the first provider defaults', () => {
    const anthropic = makeProvider(3, 15, {
      name: 'anthropic',
      services: ['claude-sonnet'],
    });
    const openai = makeProvider(3, 15, {
      name: 'openai',
      services: ['local-test'],
      servicePricing: {
        'local-test': {
          inputUsdPerMillion: 0.05,
          outputUsdPerMillion: 0.1,
        },
      },
    });

    const handler = new SellerRequestHandler({
      providers: [anthropic, openai],
      sellerPaymentManager: null,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });

    const request: SerializedHttpRequest = {
      requestId: 'req-pricing',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'x-antseed-provider': 'openai',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'local-test',
      })),
    };

    const matched = handler.matchProvider(request);
    const pricing = matched
      ? handler.resolveProviderPricing(matched, request)
      : undefined;

    expect(matched?.name).toBe('openai');
    expect(pricing).toEqual({
      inputUsdPerMillion: 0.05,
      outputUsdPerMillion: 0.1,
    });
  });

  it('does not add a paid auth headroom for zero-cost responses', async () => {
    const provider = makeProvider(0, 0, {
      name: 'free-tier',
      services: ['local-test'],
    });
    provider.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      })),
    }));

    const sendNeedAuth = vi.fn();
    const handler = new SellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: {
        hasSession: () => true,
        getChannelByPeer: () => ({ sessionId: 'session-1', authMax: '1000000' }),
        recordSpend: vi.fn(),
        getCumulativeSpend: () => 0n,
        getAcceptedCumulative: () => 0n,
        getReserveMax: () => 1_000_000n,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '0', suggestedAmount: '0' }),
        waitForPendingAuths: async () => {},
      } as any,
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = {
      send(frame: Uint8Array) {
        sentFrames.push(frame);
      },
    } as any;
    const paymentMux = {
      sendNeedAuth,
      sendPaymentRequired: vi.fn(),
    } as any;

    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    const request: SerializedHttpRequest = {
      requestId: 'req-zero-cost',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
    };

    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest(request),
    });

    expect(sentFrames.length).toBeGreaterThan(0);
    expect(sendNeedAuth).toHaveBeenCalledOnce();
    expect(sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId,
      lastRequestCost: '0',
      currentAcceptedCumulative: '0',
      requiredCumulativeAmount: '0',
    }));
  });

  it('skips the 402 / ReserveAuth handshake when the service is free', async () => {
    const provider = makeProvider(0, 0, {
      name: 'free-tier',
      services: ['local-test'],
    });
    provider.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ ok: true })),
    }));

    const sendPaymentRequired = vi.fn();
    const sendNeedAuth = vi.fn();
    const handler = new SellerRequestHandler({
      providers: [provider],
      // No active session — this is the "first request" condition that
      // previously triggered 402 → ReserveAuth → on-chain reserve().
      sellerPaymentManager: {
        hasSession: () => false,
        getChannelByPeer: () => undefined,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '0', suggestedAmount: '0' }),
      } as any,
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = {
      send(frame: Uint8Array) {
        sentFrames.push(frame);
      },
    } as any;
    const paymentMux = {
      sendNeedAuth,
      sendPaymentRequired,
    } as any;

    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    const request: SerializedHttpRequest = {
      requestId: 'req-free-service',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
    };

    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest(request),
    });

    // Provider handled the request — not blocked by payment handshake.
    expect(provider.handleRequest).toHaveBeenCalledOnce();
    // No 402, no PaymentRequired, no NeedAuth — free services bypass the
    // channel handshake entirely so the seller never calls reserve().
    expect(sendPaymentRequired).not.toHaveBeenCalled();
    expect(sendNeedAuth).not.toHaveBeenCalled();

    const responseFrames = sentFrames
      .map((f) => decodeFrame(f))
      .filter((d) => d?.message.type === MessageType.HttpResponse);
    expect(responseFrames).toHaveLength(1);
    const response = decodeHttpResponse(responseFrames[0]!.message.payload);
    expect(response.statusCode).toBe(200);
  });

  it('stops serving once delivered spend has caught up to the last accepted auth', async () => {
    const provider = makeProvider(1, 1, {
      name: 'paid-tier',
      services: ['local-test'],
    });
    provider.handleRequest = vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ ok: true })),
    }));

    const sendPaymentRequired = vi.fn();
    const handler = new SellerRequestHandler({
      providers: [provider],
      sellerPaymentManager: {
        hasSession: () => true,
        getChannelByPeer: () => ({ sessionId: 'session-1', authMax: '1000000' }),
        recordSpend: vi.fn(),
        getCumulativeSpend: () => 2_184n,
        getAcceptedCumulative: () => 0n,
        getReserveMax: () => 1_000_000n,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '50000', suggestedAmount: '1000000' }),
        waitForPendingAuths: async () => {},
        awaitAcceptedAtLeast: async () => false,
      } as any,
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });

    const sentFrames: Uint8Array[] = [];
    const conn = {
      send(frame: Uint8Array) {
        sentFrames.push(frame);
      },
    } as any;
    const paymentMux = {
      sendNeedAuth: vi.fn(),
      sendPaymentRequired,
    } as any;

    const { mux } = handler.handleConnection(conn, 'b'.repeat(40), paymentMux);

    const request: SerializedHttpRequest = {
      requestId: 'req-exhausted-budget',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'local-test' })),
    };

    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: 1,
      payload: encodeHttpRequest(request),
    });

    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(sendPaymentRequired).toHaveBeenCalledOnce();
    expect(sentFrames).toHaveLength(1);

    const decoded = decodeFrame(sentFrames[0]!);
    expect(decoded?.message.type).toBe(MessageType.HttpResponse);
    const response = decodeHttpResponse(decoded!.message.payload);
    expect(response.statusCode).toBe(402);
  });
});

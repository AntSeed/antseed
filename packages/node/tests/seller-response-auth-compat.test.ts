import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  MessageType,
} from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { decodeResponseAuth, VerificationMux } from '../src/verification/index.js';

function makeProvider(inputUsdPerMillion = 0, outputUsdPerMillion = 0): Provider {
  return {
    name: 'test-provider',
    services: ['test-model'],
    pricing: {
      defaults: { inputUsdPerMillion, outputUsdPerMillion },
    },
    maxConcurrency: 1,
    async handleRequest(req) {
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ ok: true })),
      };
    },
    getCapacity() {
      return { current: 0, max: 1 };
    },
  };
}

function makePaymentManager(overrides: Record<string, unknown> = {}): any {
  return {
    hasSession: vi.fn(() => true),
    getChannelByPeer: vi.fn(() => ({ sessionId: 'channel-1', authMax: '1000000' })),
    getPaymentRequirements: vi.fn(() => ({ minBudgetPerRequest: '10000', suggestedAmount: '100000' })),
    waitForPendingAuths: vi.fn(async () => {}),
    getAcceptedCumulative: vi.fn(() => 0n),
    getCumulativeSpend: vi.fn(() => 0n),
    getEffectiveReserveMax: vi.fn(() => 1_000_000n),
    isChannelBlocked: vi.fn(() => false),
    awaitAcceptedAtLeast: vi.fn(async () => false),
    settleSession: vi.fn(async () => {}),
    beginBillableRequest: vi.fn(),
    endBillableRequest: vi.fn(),
    recordSpend: vi.fn(),
    ...overrides,
  };
}

async function sendRequest(input: {
  handler: SellerRequestHandler;
  conn: { send: ReturnType<typeof vi.fn>; hasRemoteCapability: (capability: string) => boolean };
  paymentMux?: { sendNeedAuth: ReturnType<typeof vi.fn>; sendPaymentRequired: ReturnType<typeof vi.fn> };
  requestId?: string;
}): Promise<ReturnType<typeof decodeFrame>[]> {
  const paymentMux = input.paymentMux ?? { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() };
  const verificationMux = new VerificationMux(input.conn as any);
  const { mux } = input.handler.handleConnection(
    input.conn as any,
    '22'.repeat(20),
    paymentMux as any,
    verificationMux,
  );

  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({
      requestId: input.requestId ?? 'req-response-auth-compat',
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'test-model' })),
    }),
  });

  return input.conn.send.mock.calls.map(([frame]) => decodeFrame(frame));
}

function makeHandler(): SellerRequestHandler {
  return new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [makeProvider()],
    sellerPaymentManager: null,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit: () => false,
  });
}

async function serveRequest(conn: {
  send: ReturnType<typeof vi.fn>;
  hasRemoteCapability: (capability: string) => boolean;
}): Promise<number[]> {
  const handler = makeHandler();
  const frames = await sendRequest({ handler, conn });
  return frames.map((frame) => frame!.message.type);
}

describe('Seller response auth compatibility', () => {
  it('does not send response auth to peers without the response-auth capability', async () => {
    const conn = {
      send: vi.fn(),
      hasRemoteCapability: vi.fn(() => false),
    };

    const frameTypes = await serveRequest(conn);

    expect(frameTypes).toContain(MessageType.HttpResponse);
    expect(frameTypes).not.toContain(MessageType.VerificationResponseAuth);
  });

  it('sends response auth to peers that advertise the response-auth capability', async () => {
    const conn = {
      send: vi.fn(),
      hasRemoteCapability: vi.fn((capability: string) => capability === CONNECTION_CAPABILITY_RESPONSE_AUTH_V1),
    };

    const frameTypes = await serveRequest(conn);

    expect(frameTypes).toContain(MessageType.HttpResponse);
    expect(frameTypes).toContain(MessageType.VerificationResponseAuth);
  });

  it('rejects paid requests when the payment manager and channel store disagree', async () => {
    const provider = makeProvider(1, 1);
    provider.handleRequest = vi.fn(provider.handleRequest);
    const sellerPaymentManager = makePaymentManager({
      getChannelByPeer: vi.fn(() => null),
    });
    const handler = new SellerRequestHandler({
      identity: identityFromPrivateKeyHex('11'.repeat(32)),
      providers: [provider],
      sellerPaymentManager,
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });
    const conn = {
      send: vi.fn(),
      hasRemoteCapability: vi.fn(() => true),
    };
    const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() };

    const frames = await sendRequest({ handler, conn, paymentMux });

    const httpFrame = frames.find((frame) => frame?.message.type === MessageType.HttpResponse)!;
    expect(decodeHttpResponse(httpFrame.message.payload).statusCode).toBe(402);
    expect(paymentMux.sendPaymentRequired).toHaveBeenCalledOnce();
    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame?.message.type === MessageType.VerificationResponseAuth)).toBe(false);
  });

  it('rejects paid requests when payment infrastructure is unavailable', async () => {
    const provider = makeProvider(1, 1);
    provider.handleRequest = vi.fn(provider.handleRequest);
    const handler = new SellerRequestHandler({
      identity: identityFromPrivateKeyHex('11'.repeat(32)),
      providers: [provider],
      sellerPaymentManager: null,
      sessionTracker: null,
      channelsClient: null,
      announcer: null,
      emit: () => false,
    });
    const conn = {
      send: vi.fn(),
      hasRemoteCapability: vi.fn(() => true),
    };

    const frames = await sendRequest({ handler, conn });

    const httpFrame = frames.find((frame) => frame?.message.type === MessageType.HttpResponse)!;
    const response = decodeHttpResponse(httpFrame.message.payload);
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(new TextDecoder().decode(response.body)).error.code).toBe('payment_unavailable');
    expect(provider.handleRequest).not.toHaveBeenCalled();
    expect(frames.some((frame) => frame?.message.type === MessageType.VerificationResponseAuth)).toBe(false);
  });

  it('binds response auth to the channel admitted before provider execution', async () => {
    const provider = makeProvider(1, 1);
    const activeChannel = { sessionId: 'channel-1', authMax: '1000000' };
    const sellerPaymentManager = makePaymentManager({
      getChannelByPeer: vi.fn()
        .mockReturnValueOnce(activeChannel)
        .mockReturnValueOnce(activeChannel)
        .mockReturnValue(null),
    });
    const handler = new SellerRequestHandler({
      identity: identityFromPrivateKeyHex('11'.repeat(32)),
      providers: [provider],
      sellerPaymentManager,
      sessionTracker: null,
      channelsClient: {} as any,
      announcer: null,
      emit: () => false,
    });
    const conn = {
      send: vi.fn(),
      hasRemoteCapability: vi.fn((capability: string) => capability === CONNECTION_CAPABILITY_RESPONSE_AUTH_V1),
    };

    const frames = await sendRequest({ handler, conn });

    const authFrame = frames.find((frame) => frame?.message.type === MessageType.VerificationResponseAuth)!;
    expect(decodeResponseAuth(authFrame.message.payload).channelId).toBe('channel-1');
    expect(sellerPaymentManager.recordSpend).toHaveBeenCalledWith('channel-1', expect.any(BigInt));
    expect(sellerPaymentManager.beginBillableRequest).toHaveBeenCalledOnce();
    expect(sellerPaymentManager.endBillableRequest).toHaveBeenCalledOnce();
  });
});

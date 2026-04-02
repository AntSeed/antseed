import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntseedNode, type NodeConfig } from '../src/node.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { SerializedHttpResponse } from '../src/types/http.js';
import type { PeerInfo } from '../src/types/peer.js';

function createNode(config: Partial<NodeConfig> = {}): AntseedNode {
  const node = new AntseedNode({
    role: 'buyer',
    ...config,
  });

  (node as any)._identity = {
    peerId: 'a'.repeat(40),
    privateKey: new Uint8Array(32),
    publicKey: new Uint8Array(32),
  };
  (node as any)._connectionManager = {};
  return node;
}

describe('AntseedNode buyer payment mux wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates buyer payment mux before sending outbound requests when payments are enabled', async () => {
    const node = createNode();
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

    (node as any)._buyerPaymentManager = {};
    (node as any)._getOrCreateConnection = vi.fn(async () => conn);
    (node as any)._getOrCreateMux = vi.fn(() => ({
      sendProxyRequest,
      cancelProxyRequest: vi.fn(),
    }));
    const getOrCreateBuyerPaymentMux = vi
      .spyOn(node as any, '_getOrCreateBuyerPaymentMux')
      .mockReturnValue({} as never);

    await (node as any)._sendRequestInternal(peer, request, undefined);

    expect(getOrCreateBuyerPaymentMux).toHaveBeenCalledWith(peer.peerId, conn);
    expect(sendProxyRequest).toHaveBeenCalledOnce();
    expect(
      getOrCreateBuyerPaymentMux.mock.invocationCallOrder[0],
    ).toBeLessThan(sendProxyRequest.mock.invocationCallOrder[0]);
  });

  it('re-negotiates on 402 even when the peer was already locked', async () => {
    const node = createNode();
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

    (node as any)._buyerPaymentManager = { cleanupSession: vi.fn() };
    (node as any)._depositsClient = { getBuyerBalance: vi.fn(async () => ({ available: 1n })) };
    (node as any)._identity.wallet = { address: '0x' + '11'.repeat(20) };
    (node as any)._buyerLockedPeers.add(peer.peerId);
    (node as any)._getOrCreateConnection = vi.fn(async () => conn);
    (node as any)._getOrCreateMux = vi.fn(() => ({
      sendProxyRequest,
      cancelProxyRequest: vi.fn(),
    }));
    vi.spyOn(node as any, '_getOrCreateBuyerPaymentMux').mockReturnValue({} as never);
    vi.spyOn(node as any, '_isManualApprovalEnabled').mockResolvedValue(false);
    const negotiatePayment = vi.spyOn(node as any, '_negotiatePayment').mockImplementation(async () => {
      expect((node as any)._buyerLockedPeers.has(peer.peerId)).toBe(false);
      expect((node as any)._buyerFirstRequestSent.has(peer.peerId)).toBe(false);
    });

    const response = await (node as any)._sendRequestInternal(peer, request, undefined);

    expect(response.statusCode).toBe(200);
    expect(negotiatePayment).toHaveBeenCalledWith(peer, conn);
    expect((node as any)._buyerPaymentManager.cleanupSession).toHaveBeenCalledWith(peer.peerId);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler, stripPeerControlledResponseHeaders } from '../src/buyer-request-handler.js';
import { ConnectionState } from '../src/types/connection.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import type { PeerInfo } from '../src/types/peer.js';

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
      error: { type: string; message: string; peer_message: string };
    };
    expect(parsed.error.type).toBe('billing_configuration_error');
    expect(parsed.error.peer_message).toBe('No billing tier matches this request.');
    expect(parsed.error.message).toMatch(/AntSeed is a peer-to-peer network/);
    expect(parsed.error.message).toMatch(/Try another peer or use Auto routing/);
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

import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler } from '../src/buyer-request-handler.js';
import { ConnectionState } from '../src/types/connection.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { PeerInfo } from '../src/types/peer.js';

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

import { describe, it, expect } from 'vitest';
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LocalRouter } from '../../plugins/router-local/src/router.js';

function makeRequest(service: string): SerializedHttpRequest {
  return {
    requestId: `req-${service}`,
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      model: service,
      messages: [{ role: 'user', content: 'Hello' }],
    })),
  };
}

function makePeer(overrides?: Partial<PeerInfo>): PeerInfo {
  return {
    peerId: 'a'.repeat(64) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['anthropic'],
    trustScore: 80,
    reputationScore: 80,
    defaultInputUsdPerMillion: 15,
    defaultOutputUsdPerMillion: 15,
    providerPricing: {
      anthropic: {
        defaults: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 15,
        },
      },
    },
    maxConcurrency: 10,
    currentLoad: 0,
    ...overrides,
  };
}

describe('pricing fallback hierarchy', () => {
  it('uses service -> provider default -> peer default fallback order and enforces input/output max checks', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 30,
          outputUsdPerMillion: 30,
        },
      },
    });

    const serviceSpecificPeer = makePeer({
      peerId: '1'.repeat(64) as PeerInfo['peerId'],
      providerPricing: {
        anthropic: {
          defaults: {
            inputUsdPerMillion: 20,
            outputUsdPerMillion: 20,
          },
          services: {
            'service-a': {
              inputUsdPerMillion: 5,
              outputUsdPerMillion: 7,
            },
          },
        },
      },
      defaultInputUsdPerMillion: 20,
      defaultOutputUsdPerMillion: 20,
    });

    const providerDefaultPeer = makePeer({
      peerId: '2'.repeat(64) as PeerInfo['peerId'],
      providerPricing: {
        anthropic: {
          defaults: {
            inputUsdPerMillion: 12,
            outputUsdPerMillion: 14,
          },
        },
      },
      defaultInputUsdPerMillion: 12,
      defaultOutputUsdPerMillion: 14,
    });

    const peerDefaultOnly = makePeer({
      peerId: '3'.repeat(64) as PeerInfo['peerId'],
      providerPricing: undefined,
      defaultInputUsdPerMillion: 10,
      defaultOutputUsdPerMillion: 11,
    });

    const outputTooHigh = makePeer({
      peerId: '4'.repeat(64) as PeerInfo['peerId'],
      providerPricing: {
        anthropic: {
          defaults: {
            inputUsdPerMillion: 10,
            outputUsdPerMillion: 80,
          },
        },
      },
      defaultInputUsdPerMillion: 10,
      defaultOutputUsdPerMillion: 80,
    });

    // service-specific
    const selectedServiceSpecific = router.selectPeer(makeRequest('service-a'), [serviceSpecificPeer]);
    expect(selectedServiceSpecific?.peerId).toBe(serviceSpecificPeer.peerId);

    // provider defaults (no service-specific entry)
    const selectedProviderDefault = router.selectPeer(makeRequest('service-b'), [providerDefaultPeer]);
    expect(selectedProviderDefault?.peerId).toBe(providerDefaultPeer.peerId);

    // peer defaults (no provider pricing map)
    const selectedPeerDefault = router.selectPeer(makeRequest('service-c'), [peerDefaultOnly]);
    expect(selectedPeerDefault?.peerId).toBe(peerDefaultOnly.peerId);

    // output max price enforcement
    const selectedRejected = router.selectPeer(makeRequest('service-b'), [outputTooHigh]);
    expect(selectedRejected).toBeNull();
  });
});

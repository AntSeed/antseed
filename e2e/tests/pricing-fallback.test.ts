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
    services: [
      { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 15 } },
    ],
    trustScore: 80,
    reputationScore: 80,
    maxConcurrency: 10,
    currentLoad: 0,
    ...overrides,
  };
}

describe('pricing fallback hierarchy', () => {
  it('uses service-specific pricing when available and enforces input/output max checks', () => {
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
      services: [
        { name: 'service-a', pricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 7 } },
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 20, outputUsdPerMillion: 20 } },
      ],
    });

    const defaultPricingPeer = makePeer({
      peerId: '2'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 12, outputUsdPerMillion: 14 } },
      ],
    });

    const singleServicePeer = makePeer({
      peerId: '3'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 11 } },
      ],
    });

    const outputTooHigh = makePeer({
      peerId: '4'.repeat(64) as PeerInfo['peerId'],
      services: [
        { name: 'claude-3-opus', pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 80 } },
      ],
    });

    // service-specific pricing
    const selectedServiceSpecific = router.selectPeer(makeRequest('service-a'), [serviceSpecificPeer]);
    expect(selectedServiceSpecific?.peerId).toBe(serviceSpecificPeer.peerId);

    // fallback to first service pricing when service not found
    const selectedDefault = router.selectPeer(makeRequest('service-b'), [defaultPricingPeer]);
    expect(selectedDefault?.peerId).toBe(defaultPricingPeer.peerId);

    // single service peer fallback
    const selectedSingle = router.selectPeer(makeRequest('service-c'), [singleServicePeer]);
    expect(selectedSingle?.peerId).toBe(singleServicePeer.peerId);

    // output max price enforcement
    const selectedRejected = router.selectPeer(makeRequest('service-b'), [outputTooHigh]);
    expect(selectedRejected).toBeNull();
  });
});

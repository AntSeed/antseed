import { describe, expect, it } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { METADATA_VERSION, SERVICE_BILLING_METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function buildMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'openai',
        services: ['kimi-2.5-social'],
        defaultPricing: {
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 8,
        },
        maxConcurrency: 10,
        currentLoad: 0,
      },
    ],
    region: 'test',
    timestamp: Date.now(),
    signature: 'b'.repeat(130),
    ...overrides,
  };
}

describe('AntseedNode publicAddress override', () => {
  it('prefers metadata publicAddress over the DHT source host', () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = (node as any)._lookupResultToPeerInfo({
      host: '34.134.97.133',
      port: 6882,
      metadata: buildMetadata({ publicAddress: '34.27.100.162:6882' }),
    });

    expect(peer.publicAddress).toBe('34.27.100.162:6882');
  });

  it('falls back to the DHT source host when metadata publicAddress is absent', () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = (node as any)._lookupResultToPeerInfo({
      host: '34.134.97.133',
      port: 6882,
      metadata: buildMetadata(),
    });

    expect(peer.publicAddress).toBe('34.134.97.133:6882');
  });

  it('maps service billing models only when v11 metadata includes them', () => {
    const node = new AntseedNode({ role: 'buyer' });
    const v10Peer = (node as any)._lookupResultToPeerInfo({
      host: '34.134.97.133',
      port: 6882,
      metadata: buildMetadata({
        providers: [
          {
            provider: 'openai',
            services: ['gpt-image-1'],
            defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
            serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
            maxConcurrency: 10,
            currentLoad: 0,
          },
        ],
      }),
    });
    const v11Peer = (node as any)._lookupResultToPeerInfo({
      host: '34.134.97.133',
      port: 6882,
      metadata: buildMetadata({
        version: SERVICE_BILLING_METADATA_VERSION,
        providers: [
          {
            provider: 'openai',
            services: ['gpt-image-1'],
            defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
            serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
            serviceBillingModels: {
              'gpt-image-1': {
                'openai-images': {
                  version: 1,
                  components: [{ meter: 'output_images', unit: 'per_unit', priceUsd: 0.04 }],
                },
              },
            },
            maxConcurrency: 10,
            currentLoad: 0,
          },
        ],
      }),
    });

    expect(v10Peer.providerServiceBillingModels).toBeUndefined();
    expect(v11Peer.providerServiceBillingModels?.openai?.services['gpt-image-1']?.['openai-images']).toEqual({
      version: 1,
      components: [{ meter: 'output_images', unit: 'per_unit', priceUsd: 0.04 }],
    });
  });
});

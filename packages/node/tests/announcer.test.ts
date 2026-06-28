import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { bytesToHex } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from '../src/types/protocol.js';

function makeBaseConfig(): AnnouncerConfig {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());

  const mockDht = {
    announce: vi.fn().mockResolvedValue(undefined),
  };

  const mockIdentity = {
    peerId,
    privateKey,
    wallet,
  };

  return {
    identity: mockIdentity,
    dht: mockDht as unknown as AnnouncerConfig['dht'],
    providers: [
      {
        provider: 'openai',
        services: ['gpt-4.1'],
        maxConcurrency: 5,
      },
    ],
    region: 'us',
    pricing: new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]),
    reannounceIntervalMs: 60_000,
    signalingPort: 0,
  };
}

describe('PeerAnnouncer sellerContract', () => {
  it('publishes sellerContract in metadata as lowercase 40-hex', async () => {
    const base = makeBaseConfig();
    const proxy = '0x' + 'bb'.repeat(20);
    const announcer = new PeerAnnouncer({
      ...base,
      sellerContract: { sellerContract: proxy },
    });

    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.sellerContract).toBe('bb'.repeat(20));
  });

  it('omits sellerContract when not configured', async () => {
    const announcer = new PeerAnnouncer(makeBaseConfig());
    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.sellerContract).toBeUndefined();
  });
});

describe('PeerAnnouncer capabilities', () => {
  it('publishes response auth support in metadata', async () => {
    const announcer = new PeerAnnouncer(makeBaseConfig());
    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.capabilities).toEqual([CONNECTION_CAPABILITY_RESPONSE_AUTH_V1]);
  });
});

describe('PeerAnnouncer metadata versions', () => {
  it('keeps v10 metadata free of billing models and exposes v11 only when configured', async () => {
    const base = makeBaseConfig();
    const announcer = new PeerAnnouncer({
      ...base,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-image-1'],
          serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
          serviceBillingModels: {
            'gpt-image-1': {
              'openai-images': {
                version: 1,
                components: [{ meter: 'output_images', unit: 'per_unit', priceUsd: 0.04 }],
              },
            },
          },
          maxConcurrency: 5,
        },
      ],
    });

    await announcer.announce();

    const defaultMetadata = announcer.getLatestMetadata();
    const v10 = announcer.getLatestMetadata(10);
    const v11 = announcer.getLatestMetadata(11);

    expect(defaultMetadata).toBe(v10);
    expect(v10?.version).toBe(10);
    expect(v10?.providers[0]?.serviceBillingModels).toBeUndefined();
    expect(v11?.version).toBe(11);
    expect(v11?.providers[0]?.serviceBillingModels?.['gpt-image-1']?.['openai-images']).toEqual({
      version: 1,
      components: [{ meter: 'output_images', unit: 'per_unit', priceUsd: 0.04 }],
    });
    expect(v11?.signature).not.toBe(v10?.signature);
  });

  it('does not synthesize v11 metadata without configured billing models', async () => {
    const announcer = new PeerAnnouncer(makeBaseConfig());
    await announcer.announce();

    expect(announcer.getLatestMetadata()?.version).toBe(10);
    expect(announcer.getLatestMetadata(11)).toBeNull();
  });
});

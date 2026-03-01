import { describe, expect, it, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { modelTopic, providerTopic, topicToInfoHash } from '../src/discovery/dht-node.js';
import { verifySignature, bytesToHex, hexToBytes } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';

async function makeConfig(): Promise<{ config: AnnouncerConfig; dht: { announce: ReturnType<typeof vi.fn> } }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));

  const dht = {
    announce: vi.fn().mockResolvedValue(undefined),
  };

  const config: AnnouncerConfig = {
    identity: {
      peerId,
      privateKey,
      publicKey,
    },
    dht: dht as unknown as AnnouncerConfig['dht'],
    providers: [
      {
        provider: 'anthropic',
        models: ['claude-sonnet'],
        maxConcurrency: 5,
      },
    ],
    region: 'us',
    pricing: new Map([
      ['anthropic', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]),
    reannounceIntervalMs: 30_000,
    signalingPort: 6882,
  };

  return { config, dht };
}

describe('PeerAnnouncer live load metadata', () => {
  it('refreshes signed metadata load without re-announcing to DHT', async () => {
    const { config, dht } = await makeConfig();
    const announcer = new PeerAnnouncer(config);

    await announcer.announce();
    const first = announcer.getLatestMetadata();
    expect(first).not.toBeNull();
    expect(first!.providers[0]!.currentLoad).toBe(0);
    expect(dht.announce).toHaveBeenCalled();

    dht.announce.mockClear();
    announcer.updateLoad('anthropic', 3);
    await announcer.refreshMetadata();

    const refreshed = announcer.getLatestMetadata();
    expect(refreshed).not.toBeNull();
    expect(refreshed!.providers[0]!.currentLoad).toBe(3);
    expect(dht.announce).not.toHaveBeenCalled();

    const valid = await verifySignature(
      hexToBytes(refreshed!.peerId),
      hexToBytes(refreshed!.signature),
      encodeMetadataForSigning(refreshed!),
    );
    expect(valid).toBe(true);
  });

  it('preserves wildcard model metadata entries when provider models are wildcard', async () => {
    const { config } = await makeConfig();
    config.providers = [
      {
        provider: 'openai',
        models: [],
        modelCategories: {
          'gpt-4.1': [' Coding ', 'coding'],
        },
        modelApiProtocols: {
          'gpt-4.1': ['openai-chat-completions', 'OPENAI-CHAT-COMPLETIONS' as any, 'invalid-protocol' as any],
        },
        maxConcurrency: 5,
      },
    ];
    config.pricing = new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]);

    const announcer = new PeerAnnouncer(config);
    await announcer.refreshMetadata();
    const refreshed = announcer.getLatestMetadata();
    expect(refreshed).not.toBeNull();
    expect(refreshed!.providers[0]!.modelCategories).toEqual({
      'gpt-4.1': ['coding'],
    });
    expect(refreshed!.providers[0]!.modelApiProtocols).toEqual({
      'gpt-4.1': ['openai-chat-completions'],
    });
  });

  it('announces deduped lowercase model topics', async () => {
    const { config, dht } = await makeConfig();
    config.providers = [
      {
        provider: 'openai',
        models: ['KIMI2.5', 'kimi2.5'],
        maxConcurrency: 5,
      },
    ];
    config.pricing = new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]);

    const announcer = new PeerAnnouncer(config);
    await announcer.announce();

    expect(dht.announce).toHaveBeenCalledTimes(3);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(providerTopic('openai')), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(modelTopic('kimi2.5')), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(providerTopic('*')), 6882);
  });
});

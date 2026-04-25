import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { ANTSEED_WILDCARD_TOPIC, peerTopic, serviceSearchTopic, serviceTopic, topicToInfoHash } from '../src/discovery/dht-node.js';
import { verifySignature, bytesToHex, hexToBytes } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';

function makeConfig(): { config: AnnouncerConfig; dht: { announce: ReturnType<typeof vi.fn> } } {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());

  const dht = {
    announce: vi.fn().mockResolvedValue(undefined),
  };

  const config: AnnouncerConfig = {
    identity: {
      peerId,
      privateKey,
      wallet,
    },
    dht: dht as unknown as AnnouncerConfig['dht'],
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-sonnet'],
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
    const { config, dht } = makeConfig();
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

    const valid = verifySignature(
      refreshed!.peerId,
      hexToBytes(refreshed!.signature),
      encodeMetadataForSigning(refreshed!),
    );
    expect(valid).toBe(true);
  });

  it('preserves wildcard service metadata entries when provider services are wildcard', async () => {
    const { config } = makeConfig();
    config.providers = [
      {
        provider: 'openai',
        services: [],
        serviceCategories: {
          'gpt-4.1': [' Coding ', 'coding'],
        },
        serviceApiProtocols: {
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
    expect(refreshed!.providers[0]!.serviceCategories).toEqual({
      'gpt-4.1': ['coding'],
    });
    expect(refreshed!.providers[0]!.serviceApiProtocols).toEqual({
      'gpt-4.1': ['openai-chat-completions'],
    });
  });

  it('announces deduped lowercase service topics, wildcard, and per-peer topic', async () => {
    const { config, dht } = makeConfig();
    config.providers = [
      {
        provider: 'openai',
        services: ['KIMI2.5', 'kimi2.5'],
        maxConcurrency: 5,
      },
    ];
    config.pricing = new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]);

    const announcer = new PeerAnnouncer(config);
    await announcer.announce();

    // canonical service topic + wildcard + per-peer topic = 3
    expect(dht.announce).toHaveBeenCalledTimes(3);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(serviceTopic('kimi2.5')), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(ANTSEED_WILDCARD_TOPIC), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(peerTopic(config.identity.peerId)), 6882);
  });

  it('announces compact service-search topic when canonical service key differs', async () => {
    const { config, dht } = makeConfig();
    config.providers = [
      {
        provider: 'openai',
        services: ['KIMI-2.5', 'kimi_2.5', 'kimi 2.5'],
        maxConcurrency: 5,
      },
    ];
    config.pricing = new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]);

    const announcer = new PeerAnnouncer(config);
    await announcer.announce();

    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(serviceTopic('kimi-2.5')), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(serviceTopic('kimi_2.5')), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(serviceTopic('kimi 2.5')), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(serviceSearchTopic('kimi2.5')), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(ANTSEED_WILDCARD_TOPIC), 6882);
    expect(dht.announce).toHaveBeenCalledWith(topicToInfoHash(peerTopic(config.identity.peerId)), 6882);
  });
});

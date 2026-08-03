import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function buildMetadata(peerId: string, timestamp = Date.now()): PeerMetadata {
  return {
    peerId: peerId as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 1,
      },
    ],
    region: 'test',
    timestamp,
    signature: 'b'.repeat(128),
  };
}

describe('AntseedNode.findPeer compatibility', () => {
  it('falls back to wildcard discovery for old sellers without per-peer topics', async () => {
    const targetId = 'a'.repeat(40);
    const otherId = 'b'.repeat(40);
    const node = new AntseedNode({ role: 'buyer' });

    (node as any)._peerLookup = {
      findByPeerId: vi.fn().mockResolvedValue([]),
      findAll: vi.fn().mockResolvedValue([
        {
          metadata: buildMetadata(otherId),
          host: '5.5.5.5',
          port: 6882,
        },
        {
          metadata: buildMetadata(targetId),
          host: '34.10.10.10',
          port: 6882,
        },
      ]),
    };

    const peer = await node.findPeer(targetId);

    expect(peer?.peerId).toBe(targetId);
    expect(peer?.publicAddress).toBe('34.10.10.10:6882');
    expect((node as any)._peerLookup.findByPeerId).toHaveBeenCalledWith(targetId);
    expect((node as any)._peerLookup.findAll).toHaveBeenCalledTimes(1);
  });

  it('does not invent aggregate verification state when no service is requested', async () => {
    const targetId = 'a'.repeat(40);
    const nowSec = Math.floor(Date.now() / 1000);
    const node = new AntseedNode({ role: 'buyer' });

    (node as any)._peerLookup = {
      findByPeerId: vi.fn().mockResolvedValue([
        {
          metadata: buildMetadata(targetId),
          host: '34.10.10.10',
          port: 6882,
        },
      ]),
      findAll: vi.fn(),
    };
    (node as any)._stakingClient = {
      getAgentId: vi.fn().mockResolvedValue(55),
      getStake: vi.fn().mockResolvedValue(10_000_000n),
      getStakedAt: vi.fn().mockResolvedValue(nowSec - 86_400),
    };
    (node as any)._channelsClient = {
      getAgentStats: vi.fn().mockResolvedValue({
        channelCount: 3,
        ghostCount: 0,
        totalVolumeUsdc: 5_000_000n,
        lastSettledAt: nowSec,
      }),
    };
    (node as any)._verifierRegistryClient = {
      queryAttestations: vi.fn(),
    };

    const peer = await node.findPeer(targetId);

    expect(peer?.onChainAgentId).toBe(55);
    expect(peer?.modelVerification).toBeUndefined();
    expect((node as any)._verifierRegistryClient.queryAttestations).not.toHaveBeenCalled();
  });

  it('does not scan wildcard when the per-peer topic returns a match', async () => {
    const targetId = 'a'.repeat(40);
    const node = new AntseedNode({ role: 'buyer' });

    (node as any)._peerLookup = {
      findByPeerId: vi.fn().mockResolvedValue([
        {
          metadata: buildMetadata(targetId),
          host: '34.10.10.10',
          port: 6882,
        },
      ]),
      findAll: vi.fn(),
    };

    const peer = await node.findPeer(targetId);

    expect(peer?.peerId).toBe(targetId);
    expect((node as any)._peerLookup.findAll).not.toHaveBeenCalled();
  });
});

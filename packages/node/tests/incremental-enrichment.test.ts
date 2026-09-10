import { describe, expect, it, vi } from 'vitest';
import { AntseedNode, type PeerInfo } from '../src/node.js';
import { GITHUB_VERIFICATION_PROOF_TYPE } from '../src/discovery/github-verification.js';
import * as publicJson from '../src/reputation/public-json.js';

function makePeer(peerId = 'a'.repeat(40)): PeerInfo {
  return {
    peerId: peerId as PeerInfo['peerId'],
    providers: ['openai'],
    lastSeen: Date.now(),
  };
}

describe('AntseedNode incremental discovery enrichment', () => {
  it('emits an enriched peer update after a partial metadata-only discovery event', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    const nowSec = Math.floor(Date.now() / 1000);
    const discovered = vi.fn();

    node.on('peers:discovered', discovered);
    (node as any)._started = true;
    (node as any)._stakingClient = {
      getAgentId: vi.fn().mockResolvedValue(123),
      getStake: vi.fn().mockResolvedValue(10_000_000n),
      getStakedAt: vi.fn().mockResolvedValue(nowSec - 86_400),
    };
    (node as any)._channelsClient = {
      getAgentStats: vi.fn().mockResolvedValue({
        channelCount: 25,
        ghostCount: 0,
        totalVolumeUsdc: 50_000_000n,
        lastSettledAt: nowSec,
      }),
    };

    (node as any)._queuePartialPeerEnrichment([peer]);
    await (node as any)._partialPeerEnrichmentChain;

    expect(discovered).toHaveBeenCalledTimes(1);
    const [[peers]] = discovered.mock.calls as [[PeerInfo[]]];
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerId).toBe(peer.peerId);
    expect(peers[0]?.onChainAgentId).toBe(123);
    expect(peers[0]?.onChainChannelCount).toBe(25);
    expect(peers[0]?.onChainTotalVolumeUsdcMicros).toBe(50_000_000);
    expect(peers[0]?.onChainStatsFetchedAt).toEqual(expect.any(Number));
    expect(peers[0]?.onChainReputationScore).toEqual(expect.any(Number));
  });

  it('does not overwrite a verified staking timestamp when a refresh returns zero', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const previousStakedAt = Math.floor(Date.now() / 1000) - 90 * 86_400;
    const peer = makePeer();
    peer.onChainStakedAtSec = previousStakedAt;
    (node as any)._stakingClient = {
      getAgentId: vi.fn().mockResolvedValue(123),
      getStake: vi.fn().mockResolvedValue(10_000_000n),
      getStakedAt: vi.fn().mockResolvedValue(0),
    };
    (node as any)._channelsClient = {
      getAgentStats: vi.fn().mockResolvedValue({
        channelCount: 1_208,
        ghostCount: 16,
        totalVolumeUsdc: 5_428_786_420n,
        lastSettledAt: Math.floor(Date.now() / 1000),
      }),
    };

    await (node as any)._enrichPeersWithOnChainStats([peer]);

    expect(peer.onChainStakedAtSec).toBe(previousStakedAt);
    expect(peer.onChainTrustScore).toBeCloseTo(5_428.78642, 6);
    expect(peer.onChainReputationScore).toBeGreaterThan(90);
  });

  it('keeps the last-known score when the staking timestamp read fails', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const previousFetchedAt = Date.now() - 120_000;
    const peer = makePeer();
    peer.onChainStakedAtSec = Math.floor(Date.now() / 1000) - 90 * 86_400;
    peer.onChainStakeUsdcMicros = 10_000_000;
    peer.onChainTrustScore = 5_428.78642;
    peer.onChainReputationScore = 80;
    peer.onChainStatsFetchedAt = previousFetchedAt;
    (node as any)._stakingClient = {
      getAgentId: vi.fn().mockResolvedValue(123),
      getStake: vi.fn().mockResolvedValue(10_000_000n),
      getStakedAt: vi.fn().mockRejectedValue(new Error('transient RPC failure')),
    };
    (node as any)._channelsClient = {
      getAgentStats: vi.fn().mockResolvedValue({
        channelCount: 1_208,
        ghostCount: 16,
        totalVolumeUsdc: 5_428_786_420n,
        lastSettledAt: Math.floor(Date.now() / 1000),
      }),
    };

    await (node as any)._enrichPeersWithOnChainStats([peer]);

    expect(peer.onChainChannelCount).toBeUndefined();
    expect(peer.onChainTotalVolumeUsdcMicros).toBeUndefined();
    expect(peer.onChainTrustScore).toBe(5_428.78642);
    expect(peer.onChainReputationScore).toBe(80);
    expect(peer.onChainStatsFetchedAt).toBe(previousFetchedAt);
  });

  it('keeps the last-known stake and score when the stake read fails', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const previousFetchedAt = Date.now() - 120_000;
    const peer = makePeer();
    peer.onChainStakedAtSec = Math.floor(Date.now() / 1000) - 90 * 86_400;
    peer.onChainStakeUsdcMicros = 10_000_000;
    peer.onChainTrustScore = 5_428.78642;
    peer.onChainReputationScore = 80;
    peer.onChainStatsFetchedAt = previousFetchedAt;
    (node as any)._stakingClient = {
      getAgentId: vi.fn().mockResolvedValue(123),
      getStake: vi.fn().mockRejectedValue(new Error('transient RPC failure')),
      getStakedAt: vi.fn().mockResolvedValue(peer.onChainStakedAtSec),
    };
    (node as any)._channelsClient = {
      getAgentStats: vi.fn().mockResolvedValue({
        channelCount: 1_208,
        ghostCount: 16,
        totalVolumeUsdc: 5_428_786_420n,
        lastSettledAt: Math.floor(Date.now() / 1000),
      }),
    };

    await (node as any)._enrichPeersWithOnChainStats([peer]);

    expect(peer.onChainStakeUsdcMicros).toBe(10_000_000);
    expect(peer.onChainChannelCount).toBeUndefined();
    expect(peer.onChainTotalVolumeUsdcMicros).toBeUndefined();
    expect(peer.onChainTrustScore).toBe(5_428.78642);
    expect(peer.onChainReputationScore).toBe(80);
    expect(peer.onChainStatsFetchedAt).toBe(previousFetchedAt);
  });

  it('emits external verification results without blocking initial discovery events', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    peer.metadata = {
      peerId: peer.peerId,
      version: 10,
      providers: [],
      region: 'unknown',
      timestamp: Date.now(),
      signature: '00'.repeat(65),
      verifications: {
        github: [{ username: 'octocat' }],
      },
    };
    const discovered = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      type: GITHUB_VERIFICATION_PROOF_TYPE,
      peerId: peer.peerId,
      username: 'octocat',
    }), { status: 200 }));

    node.on('peers:discovered', discovered);
    const proofFetch = vi.spyOn(publicJson, 'fetchPublicProof').mockImplementation(fetchMock);
    (node as any)._externalHistoryCollector = { collect: vi.fn().mockResolvedValue({ version: 1, identities: [] }) };
    try {
      (node as any)._started = true;
      (node as any)._queueExternalVerification([peer]);
      expect(discovered).not.toHaveBeenCalled();

      await (node as any)._externalVerificationChain;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(discovered).toHaveBeenCalledTimes(1);
      const [[peers]] = discovered.mock.calls as [[PeerInfo[]]];
      expect(peers[0]?.verificationResults?.verified).toBe(true);
      expect(peers[0]?.verificationResults?.github[0]?.username).toBe('octocat');
      expect(peers[0]?.verificationResults?.externalHistory?.version).toBe(1);
    } finally {
      proofFetch.mockRestore();
    }
  });
});

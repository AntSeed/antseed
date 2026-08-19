import { describe, expect, it, vi } from 'vitest';
import { AntseedNode, type PeerInfo } from '../src/node.js';
import { GITHUB_VERIFICATION_PROOF_TYPE } from '../src/discovery/github-verification.js';

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
    (node as any)._applyTrustAndSybil([peer]);
    expect(peer.onChainTrustScore).toBeCloseTo(5_428.78642, 6);
    expect(peer.onChainReputationScore).toBeGreaterThan(90);
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
    vi.stubGlobal('fetch', fetchMock);
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
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

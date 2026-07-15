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

  it('includes verifier-registry enrichment in the partial-enrichment queue', async () => {
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
    (node as any)._verifierRegistryClient = {
      verificationStats: vi.fn(),
      agentVerificationStats: vi.fn().mockResolvedValue({
        sameCount: 4,
        diffCount: 0,
        undeterminedCount: 0,
        distinctVerifierCount: 2,
        lastVerdict: 1,
        lastVerifier: '0x' + '1'.repeat(40),
        activeDiffVerifierCount: 0,
      }),
      getMinDistinctDiffVerifiers: vi.fn().mockResolvedValue(3),
    };

    (node as any)._queuePartialPeerEnrichment([peer]);
    await (node as any)._partialPeerEnrichmentChain;

    expect(discovered).toHaveBeenCalledTimes(1);
    const [[peers]] = discovered.mock.calls as [[PeerInfo[]]];
    expect(peers[0]?.modelVerification?.['*']?.sameCount).toBe(4);
    expect(peers[0]?.modelVerification?.['*']?.activeDiffVerifierCount).toBe(0);
    // The chain-read points-policy exclusion threshold is stamped onto the
    // enrichment result so routing exclusion fires at the on-chain bar.
    expect(peers[0]?.modelVerification?.['*']?.exclusionThreshold).toBe(3);
    expect((node as any)._verifierRegistryClient.agentVerificationStats).toHaveBeenCalledWith(123);
  });

  it('keeps per-service verification stats when the aggregate read fails (and vice versa)', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const serviceStats = {
      sameCount: 3,
      diffCount: 1,
      undeterminedCount: 0,
      distinctVerifierCount: 2,
      lastVerdict: 2,
      lastVerifier: '0x' + '2'.repeat(40),
      activeDiffVerifierCount: 1,
    };

    // Aggregate read fails — per-service stats must survive.
    const peerA = { ...makePeer('a'.repeat(40)), onChainAgentId: 7 };
    (node as any)._verifierRegistryClient = {
      verificationStats: vi.fn().mockResolvedValue(serviceStats),
      agentVerificationStats: vi.fn().mockRejectedValue(new Error('rpc down')),
      getMinDistinctDiffVerifiers: vi.fn().mockResolvedValue(2),
    };
    await (node as any)._enrichPeersWithVerification([peerA], 'Kimi-K2');
    expect(peerA.modelVerification?.['kimi-k2']?.activeDiffVerifierCount).toBe(1);
    expect(peerA.modelVerification?.['*']).toBeUndefined();

    // Per-service read fails — aggregate stats must survive.
    const peerB = { ...makePeer('b'.repeat(40)), onChainAgentId: 8 };
    (node as any)._verifierRegistryClient = {
      verificationStats: vi.fn().mockRejectedValue(new Error('rpc down')),
      agentVerificationStats: vi.fn().mockResolvedValue(serviceStats),
      getMinDistinctDiffVerifiers: vi.fn().mockResolvedValue(2),
    };
    await (node as any)._enrichPeersWithVerification([peerB], 'kimi-k2');
    expect(peerB.modelVerification?.['kimi-k2']).toBeUndefined();
    expect(peerB.modelVerification?.['*']?.sameCount).toBe(3);
  });

  it('issues the per-service and aggregate verification reads concurrently', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = { ...makePeer(), onChainAgentId: 9 };
    let resolveService!: (value: unknown) => void;
    let resolveAggregate!: (value: unknown) => void;
    const started: string[] = [];
    const stats = {
      sameCount: 1, diffCount: 0, undeterminedCount: 0, distinctVerifierCount: 1,
      lastVerdict: 1, lastVerifier: '0x0', activeDiffVerifierCount: 0,
    };
    (node as any)._verifierRegistryClient = {
      verificationStats: vi.fn(() => {
        started.push('service');
        return new Promise((res) => { resolveService = res; });
      }),
      agentVerificationStats: vi.fn(() => {
        started.push('aggregate');
        return new Promise((res) => { resolveAggregate = res; });
      }),
      getMinDistinctDiffVerifiers: vi.fn().mockResolvedValue(2),
    };

    const done = (node as any)._enrichPeersWithVerification([peer], 'kimi-k2');
    // Flush microtasks past the (mock-resolved) exclusion-threshold read that
    // precedes the per-peer stat reads.
    await new Promise((resolve) => setImmediate(resolve));
    // Both reads must be in flight before either resolves.
    expect(started).toEqual(['service', 'aggregate']);
    resolveService(stats);
    resolveAggregate(stats);
    await done;
    expect(peer.modelVerification?.['kimi-k2']).toBeDefined();
    expect(peer.modelVerification?.['*']).toBeDefined();
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

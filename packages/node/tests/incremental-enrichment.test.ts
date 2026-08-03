import { describe, expect, it, vi } from 'vitest';
import { AntseedNode, type PeerInfo } from '../src/node.js';
import { GITHUB_VERIFICATION_PROOF_TYPE } from '../src/discovery/github-verification.js';
import {
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_SAME,
  serviceHash,
  type AttestationSubmittedEvent,
} from '../src/payments/evm/verifier-client.js';

function makePeer(peerId = 'a'.repeat(40)): PeerInfo {
  return {
    peerId: peerId as PeerInfo['peerId'],
    providers: ['openai'],
    lastSeen: Date.now(),
  };
}

function attestation(
  verdict: number,
  blockNumber: number,
  overrides: Partial<AttestationSubmittedEvent> = {},
): AttestationSubmittedEvent {
  return {
    auditId: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    verifier: '0x' + '11'.repeat(20),
    agentId: 7n,
    serviceHash: serviceHash('kimi-k2'),
    verdict: verdict as AttestationSubmittedEvent['verdict'],
    modelShareBps: verdict === VERIFIER_VERDICT_DIFF ? 2500 : 0,
    evidenceHash: '0x' + '22'.repeat(32),
    relayClaimCount: 3,
    relayPayoutUsdc: 3000n,
    blockNumber,
    logIndex: 0,
    transactionHash: '0x' + '33'.repeat(32),
    ...overrides,
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

  it('does not query verifier attestations in a metadata-only partial update without a service', async () => {
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
      queryAttestations: vi.fn(),
    };

    (node as any)._queuePartialPeerEnrichment([peer]);
    await (node as any)._partialPeerEnrichmentChain;

    expect(discovered).toHaveBeenCalledTimes(1);
    const [[peers]] = discovered.mock.calls as [[PeerInfo[]]];
    expect(peers[0]?.modelVerification).toBeUndefined();
    expect((node as any)._verifierRegistryClient.queryAttestations).not.toHaveBeenCalled();
  });

  it('derives service lifecycle from ordered attestation events', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = { ...makePeer('a'.repeat(40)), onChainAgentId: 7 };
    (node as any)._verifierRegistryClient = {
      queryAttestations: vi.fn().mockResolvedValue([
        attestation(VERIFIER_VERDICT_DIFF, 10),
        attestation(VERIFIER_VERDICT_DIFF, 11),
      ]),
    };
    await (node as any)._enrichPeersWithVerification([peer], 'Kimi-K2');
    expect(peer.modelVerification?.['kimi-k2']?.lifecycle).toBe('suspended');
    expect(peer.modelVerification?.['kimi-k2']?.consecutiveDiffCount).toBe(2);
    expect((node as any)._verifierRegistryClient.queryAttestations).toHaveBeenCalledWith(7);
  });

  it('keeps a previous lifecycle when the registry read fails', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const existing = {
      serviceHash: serviceHash('kimi-k2'),
      lifecycle: 'verified' as const,
      sameCount: 1,
      diffCount: 0,
      undeterminedCount: 0,
      consecutiveDiffCount: 0,
      lastVerdict: VERIFIER_VERDICT_SAME,
      lastConclusiveVerdict: VERIFIER_VERDICT_SAME,
      latestAuditId: '0x' + '11'.repeat(32),
      latestEvidenceHash: '0x' + '22'.repeat(32),
      latestVerifier: '0x' + '33'.repeat(20),
      latestBlockNumber: 10,
      modelShareBps: 0,
    };
    const peer = { ...makePeer(), onChainAgentId: 9, modelVerification: { 'kimi-k2': existing } };
    (node as any)._verifierRegistryClient = {
      queryAttestations: vi.fn().mockRejectedValue(new Error('rpc down')),
    };
    await (node as any)._enrichPeersWithVerification([peer], 'kimi-k2');
    expect(peer.modelVerification?.['kimi-k2']).toEqual(existing);
  });

  it('issues attestation reads concurrently across peers', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peers = [
      { ...makePeer('a'.repeat(40)), onChainAgentId: 7 },
      { ...makePeer('b'.repeat(40)), onChainAgentId: 8 },
    ];
    const started: number[] = [];
    const resolvers = new Map<number, (value: AttestationSubmittedEvent[]) => void>();
    (node as any)._verifierRegistryClient = {
      queryAttestations: vi.fn((agentId: number) => {
        started.push(agentId);
        return new Promise<AttestationSubmittedEvent[]>((resolve) => resolvers.set(agentId, resolve));
      }),
    };
    const done = (node as any)._enrichPeersWithVerification(peers, 'kimi-k2');
    await new Promise((resolve) => setImmediate(resolve));
    expect(started.sort()).toEqual([7, 8]);
    resolvers.get(7)!([attestation(VERIFIER_VERDICT_SAME, 10, { agentId: 7n })]);
    resolvers.get(8)!([attestation(VERIFIER_VERDICT_DIFF, 11, { agentId: 8n })]);
    await done;
    expect(peers[0]?.modelVerification?.['kimi-k2']?.lifecycle).toBe('verified');
    expect(peers[1]?.modelVerification?.['kimi-k2']?.lifecycle).toBe('flagged');
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

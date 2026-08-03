import { describe, expect, it, vi } from 'vitest';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { PeerId, PeerInfo } from '../src/types/peer.js';
import type { AuditRelayJobPayload } from '../src/types/protocol.js';
import { assignRelaysRoundRobin, RelayManager, type ConnectedRelay } from '../src/verification/relay-manager.js';

const VERIFIER_ID = 'f'.repeat(40) as PeerId;
const RELAY_ID = 'd'.repeat(40) as PeerId;

function peerInfo(peerId: PeerId): PeerInfo {
  return { peerId, providers: [], lastSeen: Date.now() };
}

function relayJob(): Omit<AuditRelayJobPayload, 'version'> {
  return {
    jobId: 'audit-1:0',
    chainId: 'base-local',
    registryAddress: '0x' + '11'.repeat(20),
    treasuryAddress: '0x' + '22'.repeat(20),
    auditSnapshot: {
      committer: '0x' + '33'.repeat(20),
      auditJobRoot: '0x' + '44'.repeat(32),
      jobCount: 10,
      payoutPerJobUsdc: '2500',
      reservedRelayBudgetUsdc: '25000',
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
      forceClaimAvailableAt: 1_800_022_200,
      forceClaimDeadline: 1_802_614_200,
      attested: false,
    },
    job: {
      auditId: '0x' + '55'.repeat(32),
      jobIndex: 0,
      sellerPeerId: '0x' + '77'.repeat(20),
      serviceHash: '0x' + '88'.repeat(32),
      requestHash: '0x' + '99'.repeat(32),
      jobSalt: '0x' + 'aa'.repeat(32),
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
    },
    jobProof: ['0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32), '0x' + 'dd'.repeat(32), '0x' + 'ee'.repeat(32)],
    assignment: {
      auditId: '0x' + '55'.repeat(32),
      jobIndex: 0,
      attempt: 0,
      relayBuyer: '0x' + '66'.repeat(20),
      payoutPerJobUsdc: '2500',
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
    },
    verifierSignature: '0x' + 'ab'.repeat(65),
    targetPeerId: '77'.repeat(20),
    service: 'gpt-5.6-sol',
    requestBytesBase64: Buffer.from('request-bytes').toString('base64'),
    payoutPerJobUsdc: '2500',
    timeoutMs: 1_000,
  };
}

function connectedRelay(peerId: string, minPayoutPerJobUsdc = 0n): ConnectedRelay {
  return {
    peerId: peerId as PeerId,
    chainId: 'base-local',
    registryAddress: '0x' + '11'.repeat(20),
    treasuryAddress: '0x' + '22'.repeat(20),
    minPayoutPerJobUsdc,
    maxConcurrentJobs: 1,
    activeJobs: 0,
    connectedAt: 1,
  };
}

function managerPair(): {
  verifier: RelayManager;
  relay: RelayManager;
  verifierConnection: PeerConnection;
  relayConnection: PeerConnection;
} {
  const verifier = new RelayManager({
    emit: vi.fn(),
    expectedChainId: 'base-local',
    expectedRegistryAddress: '0x' + '11'.repeat(20),
    expectedTreasuryAddress: '0x' + '22'.repeat(20),
  });
  const relay = new RelayManager({ emit: vi.fn() });
  const verifierConnection = {
    remotePeerId: RELAY_ID,
    send: (data: Uint8Array): void => {
      const decoded = decodeFrame(data);
      if (!decoded) throw new Error('incomplete verifier frame');
      relay.tryDispatchFrame(VERIFIER_ID, decoded.message);
    },
  } as unknown as PeerConnection;
  const relayConnection = {
    remotePeerId: VERIFIER_ID,
    send: (data: Uint8Array): void => {
      const decoded = decodeFrame(data);
      if (!decoded) throw new Error('incomplete relay frame');
      verifier.tryDispatchFrame(RELAY_ID, decoded.message);
    },
  } as unknown as PeerConnection;
  return { verifier, relay, verifierConnection, relayConnection };
}

describe('assignRelaysRoundRobin', () => {
  it('sorts eligible relays deterministically and uses exactly the required count', () => {
    const relays = [connectedRelay('c'.repeat(40)), connectedRelay('a'.repeat(40)), connectedRelay('b'.repeat(40))];
    const assignments = assignRelaysRoundRobin(relays, 7, 2);
    expect(assignments.map((relay) => relay.peerId)).toEqual([
      'a'.repeat(40),
      'b'.repeat(40),
      'a'.repeat(40),
      'b'.repeat(40),
      'a'.repeat(40),
      'b'.repeat(40),
      'a'.repeat(40),
    ]);
  });

  it('rejects a plan without enough eligible relays', () => {
    expect(() => assignRelaysRoundRobin([connectedRelay('a'.repeat(40))], 10, 2)).toThrow(/need 2/);
  });
});

describe('RelayManager', () => {
  it('registers a compatible relay and executes one job end to end', async () => {
    const { verifier, relay, verifierConnection, relayConnection } = managerPair();
    verifier.registerInboundRelay(verifierConnection);
    await expect(relay.serveRelayJobs(
      peerInfo(VERIFIER_ID),
      relayConnection,
      {
        chainId: 'base-local',
        registryAddress: '0x' + '11'.repeat(20),
        treasuryAddress: '0x' + '22'.repeat(20),
        minPayoutPerJobUsdc: '1000',
        maxConcurrentJobs: 1,
      },
      async () => ({ status: 'error', error: 'seller_timeout' }),
      { welcomeTimeoutMs: 1_000 },
    )).resolves.toEqual({ accepted: true });

    expect(verifier.getConnectedRelays()).toMatchObject([{ peerId: RELAY_ID, minPayoutPerJobUsdc: 1000n }]);
    await expect(verifier.runRelayJob(RELAY_ID, relayJob())).resolves.toMatchObject({
      status: 'error',
      error: 'seller_timeout',
    });
  });

  it('tracks verifier-side relay capacity while a job is in flight', async () => {
    const { verifier, relay, verifierConnection, relayConnection } = managerPair();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    verifier.registerInboundRelay(verifierConnection);
    await relay.serveRelayJobs(
      peerInfo(VERIFIER_ID),
      relayConnection,
      {
        chainId: 'base-local',
        registryAddress: '0x' + '11'.repeat(20),
        treasuryAddress: '0x' + '22'.repeat(20),
        minPayoutPerJobUsdc: '1000',
        maxConcurrentJobs: 1,
      },
      async () => {
        await gate;
        return { status: 'error', error: 'seller_timeout' };
      },
      { welcomeTimeoutMs: 1_000 },
    );

    const first = verifier.runRelayJob(RELAY_ID, relayJob());
    await new Promise((resolve) => setImmediate(resolve));
    expect(verifier.getConnectedRelays()[0]?.activeJobs).toBe(1);
    await expect(verifier.runRelayJob(RELAY_ID, { ...relayJob(), jobId: 'audit-1:1' })).rejects.toThrow(/capacity/);
    release();
    await first;
    expect(verifier.getConnectedRelays()[0]?.activeJobs).toBe(0);
  });

  it('rejects a relay on chain mismatch before accepting jobs', async () => {
    const { verifier, relay, verifierConnection, relayConnection } = managerPair();
    verifier.registerInboundRelay(verifierConnection);
    await expect(relay.serveRelayJobs(
      peerInfo(VERIFIER_ID),
      relayConnection,
      {
        chainId: 'wrong-chain',
        registryAddress: '0x' + '11'.repeat(20),
        treasuryAddress: '0x' + '22'.repeat(20),
        minPayoutPerJobUsdc: '1000',
      },
      async () => ({ status: 'error', error: 'unexpected' }),
      { welcomeTimeoutMs: 1_000 },
    )).resolves.toEqual({ accepted: false, reason: 'chain_mismatch' });
    expect(verifier.getConnectedRelays()).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DelegationManager } from '../src/verification/delegation-manager.js';
import { DelegationMux } from '../src/verification/delegation-mux.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { PeerId, PeerInfo } from '../src/types/peer.js';
import type { ProbeJobRequestPayload } from '../src/types/protocol.js';

const VERIFIER_ID = 'f'.repeat(40) as PeerId;
const DELEGATE_ID = 'd'.repeat(40) as PeerId;

function peerInfo(peerId: string): PeerInfo {
  return { peerId: peerId as PeerId, providers: [], lastSeen: Date.now() };
}

function jobPayload(jobId: string): Omit<ProbeJobRequestPayload, 'version'> {
  return {
    jobId,
    targetPeerId: 'b'.repeat(40),
    service: 'kimi-k2',
    request: {
      requestId: `req-${jobId}`,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from('{"model":"kimi-k2"}').toString('base64'),
    },
    timeoutMs: 1_000,
  };
}

/**
 * Wire a DelegationManager (delegate side) to a raw verifier-side
 * DelegationMux through in-memory frame delivery, mirroring the node's
 * dispatch path (`tryDispatchFrame`).
 */
function delegateHarness(manager: DelegationManager): {
  verifierMux: DelegationMux;
  conn: PeerConnection;
} {
  let verifierMux!: DelegationMux;
  // Frames the delegate sends land on the verifier's raw mux.
  const conn = {
    remotePeerId: VERIFIER_ID,
    send: (data: Uint8Array): void => {
      const decoded = decodeFrame(data);
      if (!decoded) throw new Error('incomplete frame in test pipe');
      void verifierMux.handleFrame(decoded.message);
    },
  } as unknown as PeerConnection;
  // Frames the verifier sends land on the manager's dispatch path.
  verifierMux = new DelegationMux({
    send: (data: Uint8Array): void => {
      const decoded = decodeFrame(data);
      if (!decoded) throw new Error('incomplete frame in test pipe');
      manager.tryDispatchFrame(VERIFIER_ID, decoded.message);
    },
  } as unknown as PeerConnection);
  return { verifierMux, conn };
}

/**
 * Wire a DelegationManager (host side) to a raw delegate-side DelegationMux.
 * Returns the connection the host registers plus the remote delegate mux.
 */
function hostHarness(manager: DelegationManager, delegateId: PeerId = DELEGATE_ID): {
  delegateMux: DelegationMux;
  conn: PeerConnection;
} {
  let delegateMux!: DelegationMux;
  const conn = {
    remotePeerId: delegateId,
    send: (data: Uint8Array): void => {
      const decoded = decodeFrame(data);
      if (!decoded) throw new Error('incomplete frame in test pipe');
      void delegateMux.handleFrame(decoded.message);
    },
  } as unknown as PeerConnection;
  delegateMux = new DelegationMux({
    send: (data: Uint8Array): void => {
      const decoded = decodeFrame(data);
      if (!decoded) throw new Error('incomplete frame in test pipe');
      manager.tryDispatchFrame(delegateId, decoded.message);
    },
  } as unknown as PeerConnection);
  return { delegateMux, conn };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('DelegationManager delegate side (serveProbeJobs)', () => {
  it('rejects jobs pushed before the welcome without executing the handler', async () => {
    const manager = new DelegationManager({ emit: vi.fn() });
    const { verifierMux, conn } = delegateHarness(manager);
    const handler = vi.fn();

    // Verifier stays silent on hello: registration is pending.
    const serving = manager.serveProbeJobs(peerInfo(VERIFIER_ID), conn, {}, handler, undefined, {
      welcomeTimeoutMs: 5_000,
    });

    const result = await verifierMux.runJob({ version: 1, ...jobPayload('early') }, 1_000);
    expect(result.status).toBe('error');
    expect(result.error).toBe('not_registered');
    expect(handler).not.toHaveBeenCalled();

    // Accept late so the pending registration resolves and jobs start flowing.
    verifierMux.sendWelcome({ version: 1, accepted: true });
    await expect(serving).resolves.toEqual({ accepted: true });
    handler.mockResolvedValue({ status: 'ok' });
    const ok = await verifierMux.runJob({ version: 1, ...jobPayload('late') }, 1_000);
    expect(ok.status).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('tears the channel down on a rejected welcome so later jobs cannot reach the handler', async () => {
    const manager = new DelegationManager({ emit: vi.fn() });
    const { verifierMux, conn } = delegateHarness(manager);
    const handler = vi.fn();
    verifierMux.onHello(() => {
      verifierMux.sendWelcome({ version: 1, accepted: false, reason: 'not_today' });
    });

    const result = await manager.serveProbeJobs(peerInfo(VERIFIER_ID), conn, {}, handler);
    expect(result).toEqual({ accepted: false, reason: 'not_today' });

    // The mux is unregistered: the job frame is not dispatched at all.
    const pending = verifierMux.runJob({ version: 1, ...jobPayload('after-reject') }, 50);
    await expect(pending).rejects.toThrow(/timed out/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tears the channel down on welcome timeout so later jobs cannot reach the handler', async () => {
    const manager = new DelegationManager({ emit: vi.fn() });
    const { verifierMux, conn } = delegateHarness(manager);
    const handler = vi.fn();

    await expect(
      manager.serveProbeJobs(peerInfo(VERIFIER_ID), conn, {}, handler, undefined, { welcomeTimeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);

    const pending = verifierMux.runJob({ version: 1, ...jobPayload('after-timeout') }, 50);
    await expect(pending).rejects.toThrow(/timed out/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('enforces its own advertised maxConcurrentJobs before any handler call', async () => {
    const manager = new DelegationManager({ emit: vi.fn() });
    const { verifierMux, conn } = delegateHarness(manager);
    verifierMux.onHello(() => verifierMux.sendWelcome({ version: 1, accepted: true }));

    let releaseFirst!: () => void;
    const firstJobRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let inFlight = 0;
    const handler = vi.fn(async () => {
      inFlight += 1;
      await firstJobRunning;
      inFlight -= 1;
      return { status: 'ok' as const };
    });

    await manager.serveProbeJobs(peerInfo(VERIFIER_ID), conn, { maxConcurrentJobs: 1 }, handler);

    const first = verifierMux.runJob({ version: 1, ...jobPayload('slot') }, 1_000);
    await flush();
    expect(inFlight).toBe(1);

    const second = await verifierMux.runJob({ version: 1, ...jobPayload('excess') }, 1_000);
    expect(second.status).toBe('error');
    expect(second.error).toBe('delegate_at_capacity');
    expect(handler).toHaveBeenCalledTimes(1);

    releaseFirst();
    const firstResult = await first;
    expect(firstResult.status).toBe('ok');

    // Slot freed — the next job runs.
    const third = await verifierMux.runJob({ version: 1, ...jobPayload('after-free') }, 1_000);
    expect(third.status).toBe('ok');
  });
});

describe('DelegationManager host side (registerInboundDelegate)', () => {
  it('registers a delegate once, keeps repeated hellos idempotent', async () => {
    const emit = vi.fn();
    const manager = new DelegationManager({ emit });
    const { delegateMux, conn } = hostHarness(manager);

    manager.registerInboundDelegate(conn);
    const firstWelcome = delegateMux.waitForWelcome(1_000);
    delegateMux.sendHello({ version: 1, maxConcurrentJobs: 2 });
    await expect(firstWelcome).resolves.toEqual({ version: 1, accepted: true });

    // Second hello on the same channel: refreshed, welcomed again, no
    // duplicate delegate:connected.
    const secondWelcome = delegateMux.waitForWelcome(1_000);
    delegateMux.sendHello({ version: 1, maxConcurrentJobs: 5 });
    await expect(secondWelcome).resolves.toEqual({ version: 1, accepted: true });

    const connectedEvents = emit.mock.calls.filter(([event]) => event === 'delegate:connected');
    expect(connectedEvents).toHaveLength(1);
    expect(manager.getConnectedDelegates()).toHaveLength(1);
    expect(manager.getConnectedDelegates()[0]?.maxConcurrentJobs).toBe(5);
  });

  it('closes the replaced mux on reconnect so its pending jobs reject promptly', async () => {
    const emit = vi.fn();
    const manager = new DelegationManager({ emit });
    const first = hostHarness(manager);

    manager.registerInboundDelegate(first.conn);
    const welcome = first.delegateMux.waitForWelcome(1_000);
    first.delegateMux.sendHello({ version: 1 });
    await welcome;

    // Delegate swallows the job so it stays pending on the first channel.
    first.delegateMux.onJob(() => { /* never answers */ });
    const pending = manager.runProbeJob(DELEGATE_ID, jobPayload('stranded'), 60_000);
    const guard = pending.catch(() => 'rejected');

    // Reconnect from the same peer replaces the channel.
    const second = hostHarness(manager);
    manager.registerInboundDelegate(second.conn);
    await expect(pending).rejects.toThrow(/closed/);
    expect(await guard).toBe('rejected');

    // The new channel is live and does not re-emit delegate:connected.
    const rewelcome = second.delegateMux.waitForWelcome(1_000);
    second.delegateMux.sendHello({ version: 1 });
    await expect(rewelcome).resolves.toEqual({ version: 1, accepted: true });
    const connectedEvents = emit.mock.calls.filter(([event]) => event === 'delegate:connected');
    expect(connectedEvents).toHaveLength(1);
  });

  it('rejects hellos beyond maxDelegates with delegate_capacity and tears the channel down', async () => {
    const emit = vi.fn();
    const manager = new DelegationManager({ emit, maxDelegates: 1 });

    const first = hostHarness(manager, 'a'.repeat(40) as PeerId);
    manager.registerInboundDelegate(first.conn);
    const firstWelcome = first.delegateMux.waitForWelcome(1_000);
    first.delegateMux.sendHello({ version: 1 });
    await expect(firstWelcome).resolves.toEqual({ version: 1, accepted: true });

    const second = hostHarness(manager, 'b'.repeat(40) as PeerId);
    manager.registerInboundDelegate(second.conn);
    const secondWelcome = second.delegateMux.waitForWelcome(1_000);
    second.delegateMux.sendHello({ version: 1 });
    const welcome = await secondWelcome;
    expect(welcome.accepted).toBe(false);
    expect(welcome.reason).toBe('delegate_capacity');

    expect(manager.getConnectedDelegates().map((d) => d.peerId)).toEqual(['a'.repeat(40)]);
    const connectedEvents = emit.mock.calls.filter(([event]) => event === 'delegate:connected');
    expect(connectedEvents).toHaveLength(1);
    // Channel torn down: nothing routes to the rejected peer anymore.
    expect(() => manager.sendDelegateVoucher('b'.repeat(40) as PeerId, {
      version: 1,
      chainId: 1,
      registry: '0x' + 'e'.repeat(40),
      buyer: '0x' + 'a'.repeat(40),
      probeCommitment: '0x' + '4'.repeat(64),
      credits: 1,
      nonce: '1',
      deadline: 1_800_000_000,
      signature: '0x' + '5'.repeat(130),
    })).toThrow(/No delegation channel/);
  });
});

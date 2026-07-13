import type { PeerConnection } from '../p2p/connection-manager.js';
import type { PeerId, PeerInfo } from '../types/peer.js';
import type {
  DelegateHelloPayload,
  DelegateVoucherPayload,
  FramedMessage,
  ProbeJobRequestPayload,
  ProbeJobResultPayload,
} from '../types/protocol.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { DelegationMux } from './delegation-mux.js';

/** A delegate buyer currently registered with this delegation host. */
export interface ConnectedDelegate {
  /**
   * The delegate's peer identity — an EVM address, and the `buyer` named in
   * any DelegateVoucher issued to it. Its deposits operator is resolved
   * on-chain at claim time; nothing about payout is asserted or checked here.
   */
  peerId: PeerId;
  maxConcurrentJobs: number;
  connectedAt: number;
}

export interface DelegationManagerDeps {
  /** Forwarded to the node's EventEmitter (delegate:connected/disconnected). */
  emit: (event: string, ...args: unknown[]) => void;
  /**
   * Host side: maximum delegates this host will register at once. Additional
   * hellos are rejected with a `delegate_capacity` welcome and their channel
   * is torn down. Default: DEFAULT_MAX_DELEGATES.
   */
  maxDelegates?: number;
}

/**
 * Default cap on concurrently registered delegates. Each delegate costs the
 * host a live connection plus bookkeeping, and an unbounded roster is a
 * trivial resource-exhaustion vector (any peer can register unauthenticated).
 */
export const DEFAULT_MAX_DELEGATES = 64;

/**
 * Probe-delegation state and protocol behavior, kept out of AntseedNode:
 * the per-peer DelegationMux registry, the delegate roster on the host
 * (verifier) side, and job serving on the delegate (buyer) side. The node
 * owns connection lifecycle and calls in here; this class never dials or
 * listens itself.
 */
export class DelegationManager {
  private readonly _deps: DelegationManagerDeps;
  private readonly _maxDelegates: number;
  private readonly _muxes = new Map<PeerId, DelegationMux>();
  private readonly _delegates = new Map<PeerId, ConnectedDelegate>();

  constructor(deps: DelegationManagerDeps) {
    this._deps = deps;
    this._maxDelegates = Math.max(1, Math.floor(deps.maxDelegates ?? DEFAULT_MAX_DELEGATES));
  }

  // ─── Host (verifier) side ─────────────────────────────────────────

  /**
   * Wire an inbound delegate connection: create its mux and handle the
   * hello/welcome registration. There is no payout to validate — the peerId
   * the delegate authenticated with is the buyer address its vouchers will
   * name, and the operator binding is enforced by the contract at claim
   * time. The caller still runs the node's frame wiring for the connection.
   *
   * Reconnects replace the previous channel: the stale mux is closed first so
   * any jobs still pending on it reject promptly instead of dangling until
   * their timeout. Repeated hellos on the same channel are idempotent — the
   * roster entry is refreshed and the welcome re-sent, but `delegate:connected`
   * fires only once per registration.
   */
  registerInboundDelegate(conn: PeerConnection): void {
    const delegatePeerId = conn.remotePeerId;
    debugLog(`[Delegation] Incoming delegate connection from ${delegatePeerId.slice(0, 12)}...`);

    const previous = this._muxes.get(delegatePeerId);
    if (previous) {
      debugLog(`[Delegation] Replacing existing delegation channel for ${delegatePeerId.slice(0, 12)}...`);
      previous.close();
    }

    const mux = new DelegationMux(conn);
    mux.onHello((hello: DelegateHelloPayload) => {
      // Ignore hellos on a channel that has since been replaced or torn down.
      if (this._muxes.get(delegatePeerId) !== mux) return;

      const alreadyRegistered = this._delegates.has(delegatePeerId);
      if (!alreadyRegistered && this._delegates.size >= this._maxDelegates) {
        debugWarn(
          `[Delegation] Rejecting delegate ${delegatePeerId.slice(0, 12)}...: `
          + `roster full (${this._delegates.size}/${this._maxDelegates})`,
        );
        try {
          mux.sendWelcome({ version: 1, accepted: false, reason: 'delegate_capacity' });
        } catch {
          // Best-effort: the rejection below tears the channel down regardless.
        }
        this._muxes.delete(delegatePeerId);
        mux.close();
        return;
      }

      const delegate: ConnectedDelegate = {
        peerId: delegatePeerId,
        maxConcurrentJobs: Math.max(1, Math.floor(hello.maxConcurrentJobs ?? 1)),
        connectedAt: this._delegates.get(delegatePeerId)?.connectedAt ?? Date.now(),
      };
      this._delegates.set(delegatePeerId, delegate);
      mux.sendWelcome({ version: 1, accepted: true });
      if (alreadyRegistered) {
        debugLog(`[Delegation] Delegate hello refreshed: ${delegatePeerId.slice(0, 12)}...`);
        return;
      }
      debugLog(`[Delegation] Delegate registered: ${delegatePeerId.slice(0, 12)}...`);
      this._deps.emit('delegate:connected', delegate);
    });
    this._muxes.set(delegatePeerId, mux);
  }

  /**
   * Send a signed DelegateVoucher to a registered delegate. Best-effort by
   * design — the caller should log failures and move on; an unreachable
   * delegate simply misses this round's voucher.
   */
  sendDelegateVoucher(delegatePeerId: PeerId, voucher: DelegateVoucherPayload): void {
    const mux = this._muxes.get(delegatePeerId);
    if (!mux) {
      throw new Error(`No delegation channel to ${delegatePeerId}`);
    }
    mux.sendVoucher(voucher);
  }

  /** Delegate buyers currently registered with this delegation host. */
  getConnectedDelegates(): ConnectedDelegate[] {
    return [...this._delegates.values()];
  }

  /**
   * Dispatch one probe job to a registered delegate and await its result.
   * The caller must independently verify the returned ResponseAuth — the
   * delegate is untrusted transport.
   */
  async runProbeJob(
    delegatePeerId: PeerId,
    job: Omit<ProbeJobRequestPayload, 'version'>,
    timeoutMs?: number,
  ): Promise<ProbeJobResultPayload> {
    if (!this._delegates.has(delegatePeerId)) {
      throw new Error(`Delegate ${delegatePeerId} is not registered`);
    }
    const mux = this._muxes.get(delegatePeerId);
    if (!mux) {
      throw new Error(`No delegation channel to ${delegatePeerId}`);
    }
    return mux.runJob({ version: 1, ...job }, timeoutMs ?? job.timeoutMs + 5_000);
  }

  // ─── Delegate (buyer) side ────────────────────────────────────────

  /**
   * Register with a delegation host (verifier) over an existing connection
   * and serve its probe jobs. `handler` errors are reported back to the
   * verifier as failed jobs. `onVoucher` receives the signed DelegateVouchers
   * the verifier issues for carried probes — the caller must verify and
   * persist them (they are the only proof of claimable credits). Resolves
   * with the verifier's welcome.
   *
   * Fail-closed: no probe job is executed (and therefore no paid seller
   * request is made) until the verifier's welcome arrives with
   * `accepted: true`. Jobs pushed before then are answered with an error
   * result, and on a rejected or timed-out welcome the channel is torn down
   * so the verifier cannot keep pushing jobs afterwards.
   *
   * The delegate also enforces its own advertised `maxConcurrentJobs` here:
   * the verifier is the untrusted party, so excess jobs are rejected before
   * any paid request is issued rather than trusting host-side scheduling.
   */
  async serveProbeJobs(
    verifierPeer: PeerInfo,
    conn: PeerConnection,
    hello: Omit<DelegateHelloPayload, 'version'>,
    handler: (job: ProbeJobRequestPayload) => Promise<Omit<ProbeJobResultPayload, 'version' | 'jobId'>>,
    onVoucher?: (voucher: DelegateVoucherPayload) => void | Promise<void>,
    opts?: { welcomeTimeoutMs?: number },
  ): Promise<{ accepted: boolean; reason?: string }> {
    // Always bind a fresh mux to this connection: a stale entry from an
    // earlier registration may reference a dead connection, and its pending
    // state should reject promptly.
    const previous = this._muxes.get(verifierPeer.peerId);
    if (previous) previous.close();
    const jobMux = new DelegationMux(conn);
    this._muxes.set(verifierPeer.peerId, jobMux);

    let acceptedWelcome = false;
    const maxConcurrentJobs = Math.max(1, Math.floor(hello.maxConcurrentJobs ?? 1));
    let activeJobs = 0;

    if (onVoucher) {
      jobMux.onVoucher(async (voucher) => {
        if (!acceptedWelcome) {
          debugWarn('[Delegation] Dropping DelegateVoucher received before an accepted welcome');
          return;
        }
        await onVoucher(voucher);
      });
    }
    // The job handler is registered before the hello so there is no window
    // where a job frame bypasses the gate below; execution is guarded by the
    // welcome flag, not by handler registration order.
    jobMux.onJob(async (job) => {
      const rejectJob = (error: string): void => {
        try {
          jobMux.sendResult({ version: 1, jobId: job.jobId, status: 'error', error });
        } catch (err) {
          debugWarn(`[Delegation] Failed to send probe job rejection for ${job.jobId}: ${err instanceof Error ? err.message : err}`);
        }
      };
      if (!acceptedWelcome) {
        debugWarn(`[Delegation] Rejecting probe job ${job.jobId}: no accepted welcome from verifier`);
        rejectJob('not_registered');
        return;
      }
      if (activeJobs >= maxConcurrentJobs) {
        debugWarn(`[Delegation] Rejecting probe job ${job.jobId}: at capacity (${activeJobs}/${maxConcurrentJobs})`);
        rejectJob('delegate_at_capacity');
        return;
      }
      activeJobs += 1;
      let result: Omit<ProbeJobResultPayload, 'version' | 'jobId'>;
      try {
        result = await handler(job);
      } catch (err) {
        result = { status: 'error', error: err instanceof Error ? err.message : String(err) };
      } finally {
        activeJobs -= 1;
      }
      try {
        jobMux.sendResult({ version: 1, jobId: job.jobId, ...result });
      } catch (err) {
        debugWarn(`[Delegation] Failed to send probe job result for ${job.jobId}: ${err instanceof Error ? err.message : err}`);
      }
    });

    const teardown = (): void => {
      if (this._muxes.get(verifierPeer.peerId) === jobMux) {
        this._muxes.delete(verifierPeer.peerId);
      }
      jobMux.close();
    };

    let welcome: { accepted: boolean; reason?: string };
    try {
      const welcomePromise = jobMux.waitForWelcome(opts?.welcomeTimeoutMs);
      jobMux.sendHello({ version: 1, ...hello });
      welcome = await welcomePromise;
    } catch (err) {
      // Welcome timed out (or the channel failed) — fail closed.
      teardown();
      throw err;
    }
    if (!welcome.accepted) {
      // Rejected — tear the channel down so the verifier cannot push jobs
      // to a delegate it claimed not to want.
      teardown();
      return { accepted: false, ...(welcome.reason ? { reason: welcome.reason } : {}) };
    }
    acceptedWelcome = true;
    return { accepted: true };
  }

  // ─── Plumbing (called from the node's connection wiring) ─────────

  /**
   * Route a frame to the peer's delegation mux. Returns false when the frame
   * is not a delegation message or no channel exists, so the caller can fall
   * through to the next mux in its dispatch chain.
   */
  tryDispatchFrame(peerId: PeerId, frame: FramedMessage): boolean {
    if (!DelegationMux.isDelegationMessage(frame.type)) return false;
    const mux = this._muxes.get(peerId);
    if (!mux) return false;
    mux.handleFrame(frame).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      debugWarn(`[Delegation] Failed to handle frame from ${peerId.slice(0, 12)}...: ${message}`);
    });
    return true;
  }

  /** Tear down per-peer state when its connection closes. */
  onPeerDisconnect(peerId: PeerId): void {
    this._muxes.get(peerId)?.close();
    this._muxes.delete(peerId);
    if (this._delegates.delete(peerId)) {
      this._deps.emit('delegate:disconnected', peerId);
    }
  }

  close(): void {
    for (const mux of this._muxes.values()) {
      mux.close();
    }
    this._muxes.clear();
    this._delegates.clear();
  }
}

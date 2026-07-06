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
}

/**
 * Probe-delegation state and protocol behavior, kept out of AntseedNode:
 * the per-peer DelegationMux registry, the delegate roster on the host
 * (verifier) side, and job serving on the delegate (buyer) side. The node
 * owns connection lifecycle and calls in here; this class never dials or
 * listens itself.
 */
export class DelegationManager {
  private readonly _deps: DelegationManagerDeps;
  private readonly _muxes = new Map<PeerId, DelegationMux>();
  private readonly _delegates = new Map<PeerId, ConnectedDelegate>();

  constructor(deps: DelegationManagerDeps) {
    this._deps = deps;
  }

  // ─── Host (verifier) side ─────────────────────────────────────────

  /**
   * Wire an inbound delegate connection: create its mux and handle the
   * hello/welcome registration. There is no payout to validate — the peerId
   * the delegate authenticated with is the buyer address its vouchers will
   * name, and the operator binding is enforced by the contract at claim
   * time. The caller still runs the node's frame wiring for the connection.
   */
  registerInboundDelegate(conn: PeerConnection): void {
    const delegatePeerId = conn.remotePeerId;
    debugLog(`[Delegation] Incoming delegate connection from ${delegatePeerId.slice(0, 12)}...`);

    const mux = new DelegationMux(conn);
    mux.onHello((hello: DelegateHelloPayload) => {
      const delegate: ConnectedDelegate = {
        peerId: delegatePeerId,
        maxConcurrentJobs: Math.max(1, Math.floor(hello.maxConcurrentJobs ?? 1)),
        connectedAt: Date.now(),
      };
      this._delegates.set(delegatePeerId, delegate);
      mux.sendWelcome({ version: 1, accepted: true });
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
   */
  async serveProbeJobs(
    verifierPeer: PeerInfo,
    conn: PeerConnection,
    hello: Omit<DelegateHelloPayload, 'version'>,
    handler: (job: ProbeJobRequestPayload) => Promise<Omit<ProbeJobResultPayload, 'version' | 'jobId'>>,
    onVoucher?: (voucher: DelegateVoucherPayload) => void | Promise<void>,
  ): Promise<{ accepted: boolean; reason?: string }> {
    let mux = this._muxes.get(verifierPeer.peerId);
    if (!mux) {
      mux = new DelegationMux(conn);
      this._muxes.set(verifierPeer.peerId, mux);
    }
    const jobMux = mux;
    if (onVoucher) {
      jobMux.onVoucher(onVoucher);
    }
    jobMux.onJob(async (job) => {
      let result: Omit<ProbeJobResultPayload, 'version' | 'jobId'>;
      try {
        result = await handler(job);
      } catch (err) {
        result = { status: 'error', error: err instanceof Error ? err.message : String(err) };
      }
      try {
        jobMux.sendResult({ version: 1, jobId: job.jobId, ...result });
      } catch (err) {
        debugWarn(`[Delegation] Failed to send probe job result for ${job.jobId}: ${err instanceof Error ? err.message : err}`);
      }
    });

    const welcomePromise = jobMux.waitForWelcome();
    jobMux.sendHello({ version: 1, ...hello });
    const welcome = await welcomePromise;
    return { accepted: welcome.accepted, ...(welcome.reason ? { reason: welcome.reason } : {}) };
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

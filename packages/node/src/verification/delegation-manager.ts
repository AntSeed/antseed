import { ZeroAddress, isAddress } from 'ethers';
import type { PeerConnection } from '../p2p/connection-manager.js';
import type { PeerId, PeerInfo } from '../types/peer.js';
import { peerIdToAddress } from '../types/peer.js';
import type {
  DelegateHelloPayload,
  FramedMessage,
  ProbeJobRequestPayload,
  ProbeJobResultPayload,
} from '../types/protocol.js';
import type { DepositsClient } from '../payments/evm/deposits-client.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { DelegationMux } from './delegation-mux.js';

/** A delegate buyer currently registered with this delegation host. */
export interface ConnectedDelegate {
  peerId: PeerId;
  /** Payout (operator) address the delegate asked to be credited at. */
  payoutAddress: string;
  maxConcurrentJobs: number;
  connectedAt: number;
}

export interface DelegationManagerDeps {
  /**
   * Deposits client used to verify a delegate's payout against its
   * registered on-chain operator. Resolved lazily — payments wiring may
   * finish after this manager is constructed.
   */
  getDepositsClient: () => DepositsClient | null;
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
   * hello/welcome registration, including the on-chain operator binding
   * check. The caller still runs the node's frame wiring for the connection.
   */
  registerInboundDelegate(conn: PeerConnection): void {
    const delegatePeerId = conn.remotePeerId;
    debugLog(`[Delegation] Incoming delegate connection from ${delegatePeerId.slice(0, 12)}...`);

    const mux = new DelegationMux(conn);
    mux.onHello(async (hello: DelegateHelloPayload) => {
      const reject = (reason: string): void => {
        debugWarn(`[Delegation] Rejecting delegate ${delegatePeerId.slice(0, 12)}...: ${reason}`);
        mux.sendWelcome({ version: 1, accepted: false, reason });
      };
      if (!isAddress(hello.payoutAddress)) {
        reject('invalid_payout_address');
        return;
      }
      // Bind the payout claim to the delegate's on-chain identity: credits
      // must go to the operator registered for this buyer in AntseedDeposits,
      // not to whatever address the hello asserts. This also doubles as a
      // sybil filter — a delegate without a funded, operator-bound deposit
      // account is not the organic buyer this network exists to recruit.
      const depositsClient = this._deps.getDepositsClient();
      if (depositsClient) {
        let operator: string;
        try {
          operator = await depositsClient.getOperator(peerIdToAddress(delegatePeerId));
        } catch (err) {
          debugWarn(`[Delegation] Operator lookup failed for delegate ${delegatePeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
          // Transient by contract with the worker: it will retry on a later
          // scan instead of blacklisting this host.
          reject('operator_check_unavailable');
          return;
        }
        if (!operator || operator === ZeroAddress) {
          reject('no_registered_operator');
          return;
        }
        if (operator.toLowerCase() !== hello.payoutAddress.toLowerCase()) {
          reject('payout_not_operator');
          return;
        }
      } else {
        debugWarn(`[Delegation] Deposits client unavailable — accepting delegate ${delegatePeerId.slice(0, 12)}... without operator binding check`);
      }
      const delegate: ConnectedDelegate = {
        peerId: delegatePeerId,
        payoutAddress: hello.payoutAddress,
        maxConcurrentJobs: Math.max(1, Math.floor(hello.maxConcurrentJobs ?? 1)),
        connectedAt: Date.now(),
      };
      this._delegates.set(delegatePeerId, delegate);
      mux.sendWelcome({ version: 1, accepted: true });
      debugLog(`[Delegation] Delegate registered: ${delegatePeerId.slice(0, 12)}... payout=${hello.payoutAddress.slice(0, 10)}...`);
      this._deps.emit('delegate:connected', delegate);
    });
    this._muxes.set(delegatePeerId, mux);
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
   * verifier as failed jobs. Resolves with the verifier's welcome.
   */
  async serveProbeJobs(
    verifierPeer: PeerInfo,
    conn: PeerConnection,
    hello: Omit<DelegateHelloPayload, 'version'>,
    handler: (job: ProbeJobRequestPayload) => Promise<Omit<ProbeJobResultPayload, 'version' | 'jobId'>>,
  ): Promise<{ accepted: boolean; reason?: string }> {
    let mux = this._muxes.get(verifierPeer.peerId);
    if (!mux) {
      mux = new DelegationMux(conn);
      this._muxes.set(verifierPeer.peerId, mux);
    }
    const jobMux = mux;
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

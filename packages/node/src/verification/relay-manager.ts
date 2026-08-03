import type { PeerConnection } from '../p2p/connection-manager.js';
import type { PeerId, PeerInfo } from '../types/peer.js';
import type {
  AuditRelayJobPayload,
  AuditRelayResultPayload,
  FramedMessage,
  RelayHelloPayload,
} from '../types/protocol.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { RelayMux } from './relay-mux.js';

export const DEFAULT_MAX_RELAYS = 64;

export interface ConnectedRelay {
  peerId: PeerId;
  chainId: string;
  registryAddress: string;
  treasuryAddress: string;
  minPayoutPerJobUsdc: bigint;
  maxConcurrentJobs: number;
  activeJobs: number;
  connectedAt: number;
}

export interface RelayManagerDeps {
  emit: (event: string, ...args: unknown[]) => void;
  maxRelays?: number;
  expectedChainId?: string;
  expectedRegistryAddress?: string;
  expectedTreasuryAddress?: string;
}

export function assignRelaysRoundRobin(
  relays: readonly ConnectedRelay[],
  jobCount: number,
  requiredRelayCount: number,
): ConnectedRelay[] {
  if (!Number.isInteger(jobCount) || jobCount <= 0) throw new Error('jobCount must be positive');
  if (!Number.isInteger(requiredRelayCount) || requiredRelayCount <= 0) {
    throw new Error('requiredRelayCount must be positive');
  }
  const eligible = relays.slice().sort((left, right) => left.peerId.localeCompare(right.peerId));
  if (eligible.length < requiredRelayCount) {
    throw new Error(`need ${requiredRelayCount} eligible relays, found ${eligible.length}`);
  }
  const selected = eligible.slice(0, requiredRelayCount);
  return Array.from({ length: jobCount }, (_unused, index) => selected[index % selected.length]!);
}

export class RelayManager {
  private readonly _maxRelays: number;
  private readonly _muxes = new Map<PeerId, RelayMux>();
  private readonly _relays = new Map<PeerId, ConnectedRelay>();

  constructor(private readonly _deps: RelayManagerDeps) {
    this._maxRelays = Math.max(1, Math.floor(_deps.maxRelays ?? DEFAULT_MAX_RELAYS));
  }

  registerInboundRelay(connection: PeerConnection): void {
    const relayPeerId = connection.remotePeerId;
    this._muxes.get(relayPeerId)?.close();
    const mux = new RelayMux(connection);
    mux.onHello((hello) => {
      if (this._muxes.get(relayPeerId) !== mux) return;
      const incompatibility = this._helloIncompatibility(hello);
      const alreadyRegistered = this._relays.has(relayPeerId);
      if (incompatibility || (!alreadyRegistered && this._relays.size >= this._maxRelays)) {
        const reason = incompatibility ?? 'relay_capacity';
        try { mux.sendWelcome({ version: 1, accepted: false, reason }); } catch {}
        this._muxes.delete(relayPeerId);
        mux.close();
        return;
      }
      const relay: ConnectedRelay = {
        peerId: relayPeerId,
        chainId: hello.chainId,
        registryAddress: hello.registryAddress,
        treasuryAddress: hello.treasuryAddress,
        minPayoutPerJobUsdc: BigInt(hello.minPayoutPerJobUsdc),
        maxConcurrentJobs: Math.max(1, Math.floor(hello.maxConcurrentJobs ?? 1)),
        activeJobs: this._relays.get(relayPeerId)?.activeJobs ?? 0,
        connectedAt: this._relays.get(relayPeerId)?.connectedAt ?? Date.now(),
      };
      this._relays.set(relayPeerId, relay);
      mux.sendWelcome({ version: 1, accepted: true });
      if (!alreadyRegistered) this._deps.emit('relay:connected', relay);
    });
    this._muxes.set(relayPeerId, mux);
  }

  getConnectedRelays(): ConnectedRelay[] {
    return [...this._relays.values()];
  }

  async runRelayJob(
    relayPeerId: PeerId,
    job: Omit<AuditRelayJobPayload, 'version'>,
    timeoutMs = job.timeoutMs,
  ): Promise<AuditRelayResultPayload> {
    const mux = this._muxes.get(relayPeerId);
    const relay = this._relays.get(relayPeerId);
    if (!mux || !relay) throw new Error(`relay ${relayPeerId} is not connected`);
    if (relay.activeJobs >= relay.maxConcurrentJobs) throw new Error(`relay ${relayPeerId} is at capacity`);
    relay.activeJobs += 1;
    try {
      return await mux.runJob({ version: 1, ...job }, timeoutMs);
    } finally {
      relay.activeJobs -= 1;
    }
  }

  async serveRelayJobs(
    verifierPeer: PeerInfo,
    connection: PeerConnection,
    hello: Omit<RelayHelloPayload, 'version'>,
    handler: (job: AuditRelayJobPayload) => Promise<Omit<AuditRelayResultPayload, 'version' | 'jobId'>>,
    options: { welcomeTimeoutMs?: number } = {},
  ): Promise<{ accepted: boolean; reason?: string }> {
    this._muxes.get(verifierPeer.peerId)?.close();
    const mux = new RelayMux(connection);
    this._muxes.set(verifierPeer.peerId, mux);
    let accepted = false;
    mux.onWelcome((welcome) => { accepted = welcome.accepted; });
    const maxConcurrentJobs = Math.max(1, Math.floor(hello.maxConcurrentJobs ?? 1));
    let activeJobs = 0;
    mux.onJob(async (job) => {
      const sendError = (error: string): void => {
        try { mux.sendResult({ version: 1, jobId: job.jobId, status: 'error', error }); } catch {}
      };
      if (!accepted) return sendError('not_registered');
      if (activeJobs >= maxConcurrentJobs) return sendError('relay_at_capacity');
      activeJobs += 1;
      let result: Omit<AuditRelayResultPayload, 'version' | 'jobId'>;
      try {
        result = await handler(job);
      } catch (error) {
        result = { status: 'error', error: error instanceof Error ? error.message : String(error) };
      } finally {
        activeJobs -= 1;
      }
      try { mux.sendResult({ version: 1, jobId: job.jobId, ...result }); } catch (error) {
        debugWarn(`[Relay] Failed to send result ${job.jobId}: ${error instanceof Error ? error.message : error}`);
      }
    });

    const welcomePromise = mux.waitForWelcome(options.welcomeTimeoutMs);
    welcomePromise.catch(() => {});
    try {
      mux.sendHello({ version: 1, ...hello });
      const welcome = await welcomePromise;
      if (!welcome.accepted) {
        this._muxes.delete(verifierPeer.peerId);
        mux.close();
        return { accepted: false, ...(welcome.reason ? { reason: welcome.reason } : {}) };
      }
      return { accepted: true };
    } catch (error) {
      this._muxes.delete(verifierPeer.peerId);
      mux.close();
      throw error;
    }
  }

  tryDispatchFrame(peerId: PeerId, frame: FramedMessage): boolean {
    if (!RelayMux.isRelayMessage(frame.type)) return false;
    const mux = this._muxes.get(peerId);
    if (!mux) return false;
    mux.handleFrame(frame).catch((error) => {
      debugWarn(`[Relay] Frame failure from ${peerId.slice(0, 12)}: ${error instanceof Error ? error.message : error}`);
    });
    return true;
  }

  onPeerDisconnect(peerId: PeerId): void {
    this._muxes.get(peerId)?.close();
    this._muxes.delete(peerId);
    if (this._relays.delete(peerId)) this._deps.emit('relay:disconnected', peerId);
  }

  close(): void {
    for (const mux of this._muxes.values()) mux.close();
    this._muxes.clear();
    this._relays.clear();
  }

  private _helloIncompatibility(hello: RelayHelloPayload): string | null {
    if (this._deps.expectedChainId && hello.chainId !== this._deps.expectedChainId) return 'chain_mismatch';
    if (this._deps.expectedRegistryAddress
      && hello.registryAddress.toLowerCase() !== this._deps.expectedRegistryAddress.toLowerCase()) {
      return 'registry_mismatch';
    }
    if (this._deps.expectedTreasuryAddress
      && hello.treasuryAddress.toLowerCase() !== this._deps.expectedTreasuryAddress.toLowerCase()) {
      return 'treasury_mismatch';
    }
    try {
      if (BigInt(hello.minPayoutPerJobUsdc) < 0n) return 'invalid_min_payout';
    } catch {
      return 'invalid_min_payout';
    }
    debugLog(`[Relay] Compatible hello for ${hello.chainId}`);
    return null;
  }
}

import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Identity } from "./p2p/identity.js";
import { loadOrCreateIdentity } from "./p2p/identity.js";
import type { PeerId } from "./types/peer.js";
import type { PeerInfo, TokenPricingUsdPerMillion } from "./types/peer.js";
import {
  ANTSEED_STREAMING_RESPONSE_HEADER,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
} from "./types/http.js";
import type { ConnectionConfig } from "./types/connection.js";
import type { MeteringEvent, SessionMetrics } from "./types/metering.js";
import { MeteringStorage } from "./metering/storage.js";
import { ReceiptGenerator } from "./metering/receipt-generator.js";
import { ConnectionState } from "./types/connection.js";
import {
  DHTNode,
  DEFAULT_DHT_CONFIG,
  type DHTNodeConfig,
} from "./discovery/dht-node.js";
import { toBootstrapConfig, OFFICIAL_BOOTSTRAP_NODES, mergeBootstrapNodes } from "./discovery/bootstrap.js";
import {
  ConnectionManager,
  PeerConnection,
} from "./p2p/connection-manager.js";
import {
  PeerAnnouncer,
  type AnnouncerConfig,
} from "./discovery/announcer.js";
import {
  PeerLookup,
  DEFAULT_LOOKUP_CONFIG,
  type LookupConfig,
  type LookupResult,
} from "./discovery/peer-lookup.js";
import { HttpMetadataResolver } from "./discovery/http-metadata-resolver.js";
import { ProxyMux } from "./proxy/proxy-mux.js";
import { PaymentMux } from "./p2p/payment-mux.js";
import { FrameDecoder } from "./p2p/message-protocol.js";
import type {
  Provider,
  ProviderStreamCallbacks,
} from "./interfaces/seller-provider.js";
import type { Router } from "./interfaces/buyer-router.js";
import { NatTraversal } from "./p2p/nat-traversal.js";
import { signUtf8Ed25519 } from "./p2p/identity.js";
import { verifyMessage, getBytes } from "ethers";
import {
  BalanceManager,
  type PaymentConfig,
  type PaymentMethod,
  BaseEscrowClient,
  identityToEvmWallet,
  buildLockMessageHash,
  buildReceiptMessage,
  buildAckMessage,
  signMessageEd25519,
  verifyMessageEd25519,
} from "./payments/index.js";
import type {
  SessionLockAuthPayload,
  BuyerAckPayload,
  SessionEndPayload,
  TopUpAuthPayload,
} from "./types/protocol.js";
import { hexToBytes, bytesToHex } from "./utils/hex.js";
import { debugLog, debugWarn } from "./utils/debug.js";
import { parsePublicAddress } from "./discovery/public-address.js";
import { BuyerPaymentManager, type BuyerPaymentConfig } from "./payments/buyer-payment-manager.js";
import { identityToEvmAddress } from "./payments/evm/keypair.js";

export type { Provider, ProviderStreamCallbacks };
export type { Router };
export type { BuyerPaymentConfig };

export interface NodePaymentsConfig {
  /** Enable seller-side payment channels and automatic settlement. */
  enabled?: boolean;
  /** Payment method used for settlement. Default: "crypto" */
  paymentMethod?: PaymentMethod;
  /** Platform fee rate in [0,1]. Default: 0.05 */
  platformFeeRate?: number;
  /** Idle time before a session is finalized and settled. Default: 30000ms */
  settlementIdleMs?: number;
  /** Default escrow amount in USDC units. Default: "1" */
  defaultEscrowAmountUSDC?: string;
  /** Optional seller wallet address for auto-funded escrow deposit. */
  sellerWalletAddress?: string;
  /** Settlement backend configuration (crypto). */
  paymentConfig?: PaymentConfig | null;
  /** Base JSON-RPC URL (e.g. http://127.0.0.1:8545 for anvil) */
  rpcUrl?: string;
  /** Deployed AntseedEscrow contract address */
  contractAddress?: string;
  /** USDC token contract address */
  usdcAddress?: string;
}

export interface NodeConfig {
  role: 'seller' | 'buyer';
  displayName?: string;
  /** Publicly reachable seller address override ("host:port") announced in metadata. */
  publicAddress?: string;
  dataDir?: string;           // Default: ~/.antseed
  dhtPort?: number;           // Default: 6881 for seller, 0 for buyer
  signalingPort?: number;     // Default: 6882 for seller
  bootstrapNodes?: Array<{ host: string; port: number }>;
  requestTimeoutMs?: number;  // Default: 30000
  /** Maximum buffered body size (bytes) while reconstructing streaming responses. Default: 16 MiB. */
  maxStreamBufferBytes?: number;
  /** Maximum wall time allowed for a streaming response. Default: 5 minutes. */
  maxStreamDurationMs?: number;
  /** Allow private/loopback IPs in DHT lookups. Default: false. Set true for local testing. */
  allowPrivateIPs?: boolean;
  /** Use only the provided bootstrapNodes and skip the official public DHT nodes. Default: false.
   *  Set true for isolated local testing where official nodes must not be contacted. */
  noOfficialBootstrap?: boolean;
  /** Override the DHT operation timeout in ms. Defaults to DEFAULT_DHT_CONFIG.operationTimeoutMs (10 000). */
  dhtOperationTimeoutMs?: number;
  /** Optional seller-side payment runtime wiring. */
  payments?: NodePaymentsConfig;
}

interface SellerSessionState {
  sessionId: string;
  sessionIdBytes: Uint8Array;
  startedAt: number;
  lastActivityAt: number;
  totalRequests: number;
  totalTokens: number;
  totalLatencyMs: number;
  totalCostCents: number;
  provider: string;

  // --- Bilateral payment state ---
  lockCommitted: boolean;
  lockedAmount: bigint;
  runningTotal: bigint;
  ackedRequestCount: number;
  lastAckedTotal: bigint;
  awaitingAck: boolean;
  buyerEvmAddress: string | null;

  // Legacy fields
  channelId?: string;
  settling?: boolean;
}

export interface SellerSessionSnapshot {
  sessionId: string;
  buyerPeerId: string;
  provider: string;
  startedAt: number;
  lastActivityAt: number;
  totalRequests: number;
  totalTokens: number;
  avgLatencyMs: number;
  settling: boolean;
  lockCommitted: boolean;
  lockedAmountUSDC: string;
  runningTotalUSDC: string;
  ackedRequestCount: number;
}

export interface RequestStreamResponseMetadata {
  streaming: boolean;
}

export interface RequestStreamCallbacks {
  onResponseStart?: (
    response: SerializedHttpResponse,
    metadata: RequestStreamResponseMetadata,
  ) => void;
  onResponseChunk?: (chunk: SerializedHttpResponseChunk) => void;
}

export interface RequestExecutionOptions {
  signal?: AbortSignal;
}

export class AntseedNode extends EventEmitter {
  private static readonly _METADATA_REFRESH_DEBOUNCE_MS = 200;
  private _config: NodeConfig;
  private _identity: Identity | null = null;
  private _dht: DHTNode | null = null;
  private _connectionManager: ConnectionManager | null = null;
  private _providers: Provider[] = [];
  private _router: Router | null = null;
  private _started = false;
  private _announcer: PeerAnnouncer | null = null;
  private _peerLookup: PeerLookup | null = null;
  private _muxes = new Map<PeerId, ProxyMux>();
  private _decoders = new Map<PeerId, FrameDecoder>();
  private _nat: NatTraversal | null = null;
  private _metering: MeteringStorage | null = null;
  private _receiptGenerator: ReceiptGenerator | null = null;
  private _balanceManager: BalanceManager | null = null;
  private _escrowClient: BaseEscrowClient | null = null;
  private _paymentMuxes = new Map<PeerId, PaymentMux>();
  private _providerLoadCounts = new Map<string, number>();
  private _metadataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-buyer session tracking: buyerPeerId → seller session state */
  private _sessions = new Map<string, SellerSessionState>();
  private _settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Buyer-side payment manager (initialized when buyer has payment config). */
  private _buyerPaymentManager: BuyerPaymentManager | null = null;
  /** Tracks which seller peers the buyer has already initiated a lock for. */
  private _buyerLockedPeers = new Set<string>();

  constructor(config: NodeConfig) {
    super();
    this._config = config;
  }

  get peerId(): string | null {
    return this._identity?.peerId ?? null;
  }

  get identity(): Identity | null {
    return this._identity;
  }

  registerProvider(provider: Provider): void {
    this._providers.push(provider);
  }

  setRouter(router: Router): void {
    this._router = router;
  }

  get router(): Router | null {
    return this._router;
  }

  /** Buyer-side payment manager (null if payments not enabled or not in buyer mode). */
  get buyerPaymentManager(): BuyerPaymentManager | null {
    return this._buyerPaymentManager;
  }

  /** Actual DHT port after binding (0 means not started). */
  get dhtPort(): number {
    return this._dht?.getPort() ?? 0;
  }

  /** Actual signaling/connection port after binding (0 means not started). */
  get signalingPort(): number {
    return this._connectionManager?.getListeningPort() ?? 0;
  }

  /** Current connection state for a peer if a connection exists, otherwise null. */
  getPeerConnectionState(peerId: PeerId): ConnectionState | null {
    return this._connectionManager?.getConnection(peerId)?.state ?? null;
  }

  /**
   * Active seller sessions currently tracked in-memory.
   * Includes open sessions before they are finalized/settled.
   */
  getActiveSellerSessions(): SellerSessionSnapshot[] {
    const snapshots: SellerSessionSnapshot[] = [];
    for (const [buyerPeerId, session] of this._sessions.entries()) {
      snapshots.push({
        sessionId: session.sessionId,
        buyerPeerId,
        provider: session.provider,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        totalRequests: session.totalRequests,
        totalTokens: session.totalTokens,
        avgLatencyMs: session.totalRequests > 0 ? session.totalLatencyMs / session.totalRequests : 0,
        settling: Boolean(session.settling),
        lockCommitted: session.lockCommitted,
        lockedAmountUSDC: session.lockedAmount.toString(),
        runningTotalUSDC: session.runningTotal.toString(),
        ackedRequestCount: session.ackedRequestCount,
      });
    }
    return snapshots;
  }

  /** Number of active in-memory seller sessions that are not currently settling. */
  getActiveSellerSessionCount(): number {
    let count = 0;
    for (const session of this._sessions.values()) {
      if (!session.settling) {
        count += 1;
      }
    }
    return count;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Node already started");
    }

    const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");

    // Load or create identity
    this._identity = await loadOrCreateIdentity(dataDir);
    debugLog(`[Node] Identity loaded: ${this._identity.peerId.slice(0, 12)}...`);

    // Determine bootstrap nodes — merge official + any user-configured nodes unless
    // noOfficialBootstrap is set (e.g. isolated local testing).
    const bootstrapNodes = toBootstrapConfig(
      this._config.noOfficialBootstrap
        ? (this._config.bootstrapNodes ?? [])
        : mergeBootstrapNodes(OFFICIAL_BOOTSTRAP_NODES, this._config.bootstrapNodes ?? [])
    );
    debugLog(`[Node] Starting as ${this._config.role} with ${bootstrapNodes.length} bootstrap node(s)`);

    if (this._config.role === "seller") {
      await this._startSeller(bootstrapNodes);
    } else {
      await this._startBuyer(bootstrapNodes);
    }

    this._started = true;
    debugLog(`[Node] Started successfully`);
    this.emit("started");
  }

  async stop(): Promise<void> {
    if (!this._started) {
      return;
    }

    // End all active buyer payment sessions before shutdown
    await this._endAllBuyerSessions();

    await this._finalizeAllSessions("node-stop");

    for (const timer of this._settlementTimers.values()) {
      clearTimeout(timer);
    }
    this._settlementTimers.clear();
    if (this._metadataRefreshTimer) {
      clearTimeout(this._metadataRefreshTimer);
      this._metadataRefreshTimer = null;
    }
    this._providerLoadCounts.clear();

    // Remove NAT port mappings
    if (this._nat) {
      await this._nat.cleanup();
      this._nat = null;
    }

    // Stop announcer
    if (this._announcer) {
      this._announcer.stopPeriodicAnnounce();
      this._announcer = null;
    }

    // Close all proxy muxes
    this._muxes.clear();
    this._paymentMuxes.clear();
    this._decoders.clear();

    // Close all connections
    if (this._connectionManager) {
      this._connectionManager.closeAll();
      this._connectionManager = null;
    }

    // Stop DHT
    if (this._dht) {
      await this._dht.stop();
      this._dht = null;
    }

    if (this._balanceManager) {
      try {
        const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");
        await this._balanceManager.save(join(dataDir, "payments"));
      } catch (err) {
        debugWarn(`[Node] Failed to persist payment balances: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (this._metering) {
      try {
        this._metering.close();
      } catch {
        // ignore close errors
      }
      this._metering = null;
    }

    this._peerLookup = null;
    this._receiptGenerator = null;
    this._balanceManager = null;
    this._escrowClient = null;
    this._buyerPaymentManager = null;
    this._buyerLockedPeers.clear();
    this._started = false;
    this.emit("stopped");
  }

  async discoverPeers(service?: string): Promise<PeerInfo[]> {
    if (!this._peerLookup) {
      throw new Error("Node not started or not in buyer mode");
    }

    debugLog(`[Node] Discovering peers (service: "${service ?? "*"}")...`);

    // Query service-level DHT topic when a service is specified — returns only peers
    // that explicitly announced that service. Fall back to wildcard if no results.
    let results = service
      ? await this._peerLookup.findByService(service)
      : await this._peerLookup.findAll();

    if (service && results.length === 0) {
      debugLog(`[Node] No service-topic results for "${service}", falling back to wildcard`);
      results = await this._peerLookup.findAll();
    }
    debugLog(`[Node] DHT returned ${results.length} result(s)`);

    // Deduplicate by peerId (DHT can return the same peer from multiple topic lookups)
    const seen = new Set<string>();
    const peers: PeerInfo[] = [];
    for (const r of results) {
      const p = this._lookupResultToPeerInfo(r);
      if (!seen.has(p.peerId)) {
        seen.add(p.peerId);
        peers.push(p);
      }
    }



    // Optional reputation verification: replace claimed data with verified on-chain data
    if (this._escrowClient) {
      for (const p of peers) {
        if (p.evmAddress && p.onChainReputation !== undefined) {
          try {
            const rep = await this._escrowClient.getReputation(p.evmAddress);
            p.onChainReputation = rep.weightedAverage;
            p.onChainSessionCount = rep.sessionCount;
            p.onChainDisputeCount = rep.disputeCount;
            p.trustScore = rep.weightedAverage;
          } catch {
            // Use claimed data if verification fails
          }
        }
      }
    }

    for (const p of peers) {
      debugLog(`[Node]   peer ${p.peerId.slice(0, 12)}... providers=[${p.providers.join(",")}] addr=${p.publicAddress ?? "?"}`);
    }
    return peers;
  }

  async sendRequest(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    return this._sendRequestInternal(peer, req, undefined, options);
  }

  async sendRequestStream(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    callbacks: RequestStreamCallbacks,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    return this._sendRequestInternal(peer, req, callbacks, options);
  }

  private async _sendRequestInternal(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    callbacks?: RequestStreamCallbacks,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    if (!req.requestId || typeof req.requestId !== "string") {
      throw new Error("requestId must be a non-empty string");
    }
    if (!this._connectionManager || !this._identity) {
      throw new Error("Node not started");
    }

    const opName = callbacks ? "sendRequestStream" : "sendRequest";
    debugLog(`[Node] ${opName} ${req.method} ${req.path} → peer ${peer.peerId.slice(0, 12)}... (reqId=${req.requestId.slice(0, 8)})`);

    const conn = await this._getOrCreateConnection(peer);
    debugLog(`[Node] Connection to ${peer.peerId.slice(0, 12)}... state=${conn.state}`);
    const mux = this._getOrCreateMux(peer.peerId, conn);

    // Buyer-side: initiate lock and wait for confirmation on first request to a new peer
    if (this._buyerPaymentManager && !this._buyerLockedPeers.has(peer.peerId)) {
      await this._initiateBuyerLock(peer, conn);
    }

    const startTime = Date.now();
    return new Promise<SerializedHttpResponse>((resolve, reject) => {
      const timeoutMs = this._config.requestTimeoutMs ?? 30_000;
      const maxStreamBufferBytes = Math.max(1, this._config.maxStreamBufferBytes ?? 16 * 1024 * 1024);
      const maxStreamDurationMs = Math.max(1, this._config.maxStreamDurationMs ?? 5 * 60_000);
      const streamInitialResponseTimeoutMs = callbacks ? Math.max(timeoutMs, 90_000) : timeoutMs;
      // Idle timeout for streaming: resets on each chunk so long-running
      // streams (thinking models, large outputs) stay alive as long as
      // data keeps flowing.
      const streamIdleTimeoutMs = Math.max(timeoutMs, 60_000);
      let settled = false;
      let streamStarted = false;
      let streamStartedAtMs = 0;
      let streamBufferedBytes = 0;
      let streamStartResponse: SerializedHttpResponse | null = null;
      const streamChunks: Uint8Array[] = [];
      let activeTimeout: ReturnType<typeof setTimeout> | null = null;
      let activeTimeoutMs = streamInitialResponseTimeoutMs;
      const abortSignal = options?.signal;
      let abortListenerAttached = false;
      let connectionStateListenerAttached = false;
      const hasConnectionStateEvents =
        typeof (conn as { on?: unknown }).on === "function"
        && typeof (conn as { off?: unknown }).off === "function";

      const cleanupAbortListener = (): void => {
        if (abortSignal && abortListenerAttached) {
          abortSignal.removeEventListener("abort", onAbort);
          abortListenerAttached = false;
        }
      };
      const cleanupConnectionListener = (): void => {
        if (!connectionStateListenerAttached) return;
        conn.off("stateChange", onConnectionStateChange);
        connectionStateListenerAttached = false;
      };
      const onConnectionStateChange = (state: ConnectionState): void => {
        if (settled) return;
        if (state !== ConnectionState.Closed && state !== ConnectionState.Failed) {
          return;
        }
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        mux.cancelProxyRequest(req.requestId);
        reject(new Error(`Connection to ${peer.peerId} ${state.toLowerCase()} during request ${req.requestId}`));
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        debugWarn(`[Node] Request ${req.requestId.slice(0, 8)} aborted by caller`);
        mux.cancelProxyRequest(req.requestId);
        reject(new Error(`Request ${req.requestId} aborted`));
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
        abortListenerAttached = true;
      }
      if (hasConnectionStateEvents) {
        conn.on("stateChange", onConnectionStateChange);
        connectionStateListenerAttached = true;
      }

      const resetTimeout = (ms: number): void => {
        if (activeTimeout) clearTimeout(activeTimeout);
        activeTimeoutMs = ms;
        activeTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupAbortListener();
          cleanupConnectionListener();
          debugWarn(
            `[Node] Request ${req.requestId.slice(0, 8)} timed out after ${Date.now() - startTime}ms `
            + `(timeout=${activeTimeoutMs}ms, stream=${callbacks ? "true" : "false"}, streamStarted=${streamStarted ? "true" : "false"}, buffered=${streamBufferedBytes}b)`,
          );
          mux.cancelProxyRequest(req.requestId);
          reject(new Error(`Request ${req.requestId} timed out`));
        }, ms);
      };

      // Initial timeout: wait for the first response frame.
      resetTimeout(streamInitialResponseTimeoutMs);

      const finish = (response: SerializedHttpResponse): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        const cleaned = this._stripStreamingHeader(response);
        debugLog(`[Node] Response for ${req.requestId.slice(0, 8)}: status=${cleaned.statusCode} (${Date.now() - startTime}ms, ${cleaned.body.length}b)`);
        resolve(cleaned);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        reject(error);
      };

      mux.sendProxyRequest(
        req,
        (response: SerializedHttpResponse, metadata) => {
          if (settled) return;
          if (metadata.streamingStart) {
            streamStarted = true;
            streamStartedAtMs = Date.now();
            streamBufferedBytes = 0;
            streamStartResponse = this._stripStreamingHeader(response);
            debugLog(`[Node] Stream started for ${req.requestId.slice(0, 8)}; idle-timeout=${streamIdleTimeoutMs}ms`);
            // Switch to streaming idle timeout: resets on each chunk.
            resetTimeout(streamIdleTimeoutMs);
            callbacks?.onResponseStart?.(streamStartResponse, { streaming: true });
            return;
          }

          callbacks?.onResponseStart?.(this._stripStreamingHeader(response), { streaming: false });
          finish(response);
        },
        (chunk) => {
          if (settled) return;
          if (!streamStarted) return;

          // Reset idle timeout on each chunk so streaming stays alive.
          resetTimeout(streamIdleTimeoutMs);

          if (Date.now() - streamStartedAtMs > maxStreamDurationMs) {
            mux.cancelProxyRequest(req.requestId);
            fail(new Error(`Stream ${req.requestId} exceeded max duration (${maxStreamDurationMs}ms)`));
            return;
          }

          callbacks?.onResponseChunk?.(chunk);

          if (chunk.data.length > 0) {
            if (callbacks) {
              // Streaming mode: chunks already delivered to caller, only track
              // bytes for duration/idle timeout — skip buffer accumulation so
              // large streams aren't capped by maxStreamBufferBytes.
              streamBufferedBytes += chunk.data.length;
            } else {
              // Non-streaming: accumulate chunks for the final response body.
              const nextBufferedBytes = streamBufferedBytes + chunk.data.length;
              if (nextBufferedBytes > maxStreamBufferBytes) {
                mux.cancelProxyRequest(req.requestId);
                fail(new Error(`Stream ${req.requestId} exceeded max buffered size (${maxStreamBufferBytes} bytes)`));
                return;
              }
              streamBufferedBytes = nextBufferedBytes;
              streamChunks.push(chunk.data);
            }
          }

          if (!chunk.done) return;

          if (!streamStartResponse) {
            fail(new Error(`Stream ${req.requestId} ended before response start`));
            return;
          }

          finish({
            ...streamStartResponse,
            body: concatChunks(streamChunks),
          });
        },
      );
    });
  }

  private _createDHTConfig(port: number, bootstrapNodes: Array<{ host: string; port: number }>): DHTNodeConfig {
    return {
      peerId: this._identity!.peerId,
      port,
      bootstrapNodes,
      reannounceIntervalMs: DEFAULT_DHT_CONFIG.reannounceIntervalMs,
      operationTimeoutMs: this._config.dhtOperationTimeoutMs ?? DEFAULT_DHT_CONFIG.operationTimeoutMs,
      allowPrivateIPs: this._config.allowPrivateIPs,
    };
  }

  private _wireConnection(conn: PeerConnection, peerId: PeerId): void {
    const decoder = new FrameDecoder();
    conn.on("message", (data: Uint8Array) => {
      let frames: ReturnType<typeof decoder.feed>;
      try {
        frames = decoder.feed(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugWarn(`[Node] Failed to decode frame from ${peerId.slice(0, 12)}...: ${message}`);
        conn.fail(err instanceof Error ? err : new Error(message));
        return;
      }
      const proxyMux = this._muxes.get(peerId);
      const paymentMux = this._paymentMuxes.get(peerId);
      for (const frame of frames) {
        if (paymentMux && PaymentMux.isPaymentMessage(frame.type)) {
          paymentMux.handleFrame(frame).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            debugWarn(`[Node] Failed to handle payment frame from ${peerId.slice(0, 12)}...: ${message}`);
          });
        } else if (proxyMux) {
          proxyMux.handleFrame(frame).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            debugWarn(`[Node] Failed to handle frame from ${peerId.slice(0, 12)}...: ${message}`);
            conn.fail(err instanceof Error ? err : new Error(message));
          });
        }
      }
    });

    this._decoders.set(peerId, decoder);

    conn.on("stateChange", (state: ConnectionState) => {
      if (state === ConnectionState.Closed || state === ConnectionState.Failed) {
        // Guard against stale close events: if a reconnect arrived before this
        // connection finished closing, a new decoder will have been registered.
        // Wiping the maps would evict the live session, so bail out early.
        if (this._decoders.get(peerId) !== decoder) return;
        // Flush any in-progress chunked uploads so buffers are not leaked
        this._muxes.get(peerId)?.abortPendingUploads();
        this._muxes.delete(peerId);
        this._paymentMuxes.delete(peerId);
        this._decoders.delete(peerId);
        // Handle buyer disconnect (ghost scenario)
        void this._finalizeSession(peerId, "disconnect");
      }
    });
  }

  private async _startSeller(bootstrapNodes: Array<{ host: string; port: number }>): Promise<void> {
    const identity = this._identity!;
    const dhtPort = this._config.dhtPort ?? 6881;
    const signalingPort = this._config.signalingPort ?? 6882;
    debugLog(`[Node] Starting seller — DHT port=${dhtPort}, signaling port=${signalingPort}`);

    // Initialize metering storage
    const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");
    try {
      this._metering = new MeteringStorage(join(dataDir, "metering.db"));
      debugLog("[Node] Metering storage initialized");
    } catch (err) {
      debugWarn(`[Node] Metering storage unavailable: ${err instanceof Error ? err.message : err}`);
    }

    if (this._metering) {
      this._receiptGenerator = new ReceiptGenerator({
        peerId: identity.peerId,
        sign: (message: string) => signUtf8Ed25519(identity.privateKey, message),
      });
    }

    await this._initializePayments(dataDir);

    // Start DHT
    this._dht = new DHTNode(this._createDHTConfig(dhtPort, bootstrapNodes));
    await this._dht.start();

    // Create ConnectionManager and start listening
    this._connectionManager = new ConnectionManager();
    this._connectionManager.setLocalIdentity(identity);
    this._connectionManager.on("error", (err: Error) => {
      debugWarn(`[ConnectionManager] ${err.message}`);
    });
    await this._connectionManager.startListening({
      peerId: identity.peerId,
      port: signalingPort,
      host: "0.0.0.0",
    });

    // Resolve actual bound port (important when port 0 is used for OS-assigned)
    const actualSignalingPort = this._connectionManager.getListeningPort() ?? signalingPort;
    const actualDhtPort = this._dht.getPort();

    // NAT traversal: automatically map ports via UPnP/NAT-PMP
    this._nat = new NatTraversal();
    const natResult = await this._nat.mapPorts([
      { port: actualSignalingPort, protocol: "TCP" },
      { port: actualDhtPort, protocol: "UDP" },
    ]);

    if (natResult.success) {
      this.emit("nat:mapped", natResult);
    } else {
      debugWarn("[NAT] UPnP/NAT-PMP mapping failed — seller may not be reachable from the internet");
      debugWarn("[NAT] Ensure port forwarding is configured manually, or peers on the same LAN can still connect");
      this.emit("nat:failed");
    }

    // Set up announcer for providers
    if (this._providers.length > 0) {
      const announcerConfig: AnnouncerConfig = {
        identity,
        dht: this._dht,
        providers: this._providers.map((p) => ({
          provider: p.name,
          services: p.services,
          ...(p.serviceCategories ? { serviceCategories: { ...p.serviceCategories } } : {}),
          ...(p.serviceApiProtocols ? { serviceApiProtocols: { ...p.serviceApiProtocols } } : {}),
          maxConcurrency: p.maxConcurrency,
        })),
        ...(this._config.displayName ? { displayName: this._config.displayName } : {}),
        ...(this._config.publicAddress ? { publicAddress: this._config.publicAddress } : {}),
        region: "unknown",
        pricing: new Map(
          this._providers.map((p) => [
            p.name,
            {
              defaults: {
                inputUsdPerMillion: p.pricing.defaults.inputUsdPerMillion,
                outputUsdPerMillion: p.pricing.defaults.outputUsdPerMillion,
              },
              ...(p.pricing.services ? { services: { ...p.pricing.services } } : {}),
            },
          ]),
        ),
        reannounceIntervalMs: DEFAULT_DHT_CONFIG.reannounceIntervalMs,
        signalingPort: actualSignalingPort,
      };
      this._announcer = new PeerAnnouncer(announcerConfig);
      this._announcer.startPeriodicAnnounce();

      // Serve metadata on the signaling port (HTTP requests are auto-detected)
      this._connectionManager!.setMetadataProvider(
        () => this._announcer?.getLatestMetadata() ?? null,
      );
    }

    // Listen for incoming connections
    this._connectionManager.on("connection", (conn: PeerConnection) => {
      this._handleIncomingConnection(conn);
    });

    debugLog(`[Node] Seller ready — announcing ${this._providers.length} provider(s)`);
  }

  private async _startBuyer(bootstrapNodes: Array<{ host: string; port: number }>): Promise<void> {
    const identity = this._identity!;
    const dhtPort = this._config.dhtPort ?? 0;
    debugLog(`[Node] Starting buyer — DHT port=${dhtPort}`);

    // Start DHT with ephemeral port
    this._dht = new DHTNode(this._createDHTConfig(dhtPort, bootstrapNodes));
    await this._dht.start();

    // Create ConnectionManager for outbound connections
    this._connectionManager = new ConnectionManager();
    this._connectionManager.setLocalIdentity(identity);
    this._connectionManager.on("error", (err: Error) => {
      debugWarn(`[ConnectionManager] ${err.message}`);
    });

    // Create PeerLookup with HttpMetadataResolver
    const metadataResolver = new HttpMetadataResolver();
    const lookupConfig: LookupConfig = {
      dht: this._dht,
      metadataResolver,
      requireValidSignature: DEFAULT_LOOKUP_CONFIG.requireValidSignature,
      allowStaleMetadata: DEFAULT_LOOKUP_CONFIG.allowStaleMetadata,
      maxAnnouncementAgeMs: DEFAULT_LOOKUP_CONFIG.maxAnnouncementAgeMs,
      maxResults: DEFAULT_LOOKUP_CONFIG.maxResults,
    };
    this._peerLookup = new PeerLookup(lookupConfig);

    // Initialize buyer-side payment manager if payments config is provided
    const payments = this._config.payments;
    if (payments?.enabled && payments.rpcUrl && payments.contractAddress && payments.usdcAddress) {
      const buyerPaymentConfig: BuyerPaymentConfig = {
        defaultLockAmountUSDC: payments.defaultEscrowAmountUSDC ?? "1000000",
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.contractAddress,
        usdcAddress: payments.usdcAddress,
      };
      this._buyerPaymentManager = new BuyerPaymentManager(identity, buyerPaymentConfig);
      debugLog(`[Node] Buyer payment manager initialized (wallet=${identityToEvmAddress(identity).slice(0, 10)}...)`);
    }

    debugLog(`[Node] Buyer ready — DHT running on port ${this._dht!.getPort()}`);
  }

  private _handleIncomingConnection(conn: PeerConnection): void {
    debugLog(`[Node] Incoming connection from ${conn.remotePeerId.slice(0, 12)}...`);
    const buyerPeerId = conn.remotePeerId;
    const mux = new ProxyMux(conn);

    // Create PaymentMux alongside ProxyMux (seller-side)
    const paymentMux = new PaymentMux(conn);
    paymentMux.onSessionLockAuth((payload) => {
      void this._handleSessionLockAuth(buyerPeerId, payload, paymentMux);
    });
    paymentMux.onBuyerAck((payload) => {
      void this._handleBuyerAck(buyerPeerId, payload);
    });
    paymentMux.onSessionEnd((payload) => {
      void this._handleSessionEnd(buyerPeerId, payload);
    });
    paymentMux.onTopUpAuth((payload) => {
      void this._handleTopUpAuth(buyerPeerId, payload);
    });
    this._paymentMuxes.set(buyerPeerId, paymentMux);

    // Register the ProxyMux request handler that routes to providers
    mux.onProxyRequest(async (request: SerializedHttpRequest) => {
      debugLog(`[Node] Seller received request: ${request.method} ${request.path} (reqId=${request.requestId.slice(0, 8)})`);

      // Reject with 402 if lock not committed and escrow client is configured
      const session = this._sessions.get(buyerPeerId);
      if (this._escrowClient && (!session || !session.lockCommitted)) {
        debugWarn(`[Node] Rejecting request from ${buyerPeerId.slice(0, 12)}... — lock not committed`);
        mux.sendProxyResponse({
          requestId: request.requestId,
          statusCode: 402,
          headers: { "content-type": "text/plain" },
          body: new TextEncoder().encode("Payment required: session lock not committed"),
        });
        return;
      }

      const requestedService = this._extractRequestedService(request);
      const requestedProvider = this._extractRequestedProvider(request);
      const matchesService = (provider: Provider): boolean =>
        provider.services.length === 0
        || (requestedService !== null && provider.services.includes(requestedService))
        || this._providers.length === 1;

      let provider: Provider | undefined;
      if (requestedProvider) {
        provider = this._providers.find((candidate) =>
          candidate.name.toLowerCase() === requestedProvider && matchesService(candidate),
        );
      }
      if (!provider) {
        provider = this._providers.find((candidate) => matchesService(candidate));
      }

      if (!provider) {
        debugWarn(`[Node] No matching provider for ${request.path}`);
        mux.sendProxyResponse({
          requestId: request.requestId,
          statusCode: 502,
          headers: { "content-type": "text/plain" },
          body: new TextEncoder().encode("No matching provider"),
        });
        return;
      }

      // Track active seller session at request start so runtime state reflects
      // in-flight work immediately (not only after metering persistence).
      this._getOrCreateSellerSession(buyerPeerId, provider.name);

      request.headers['x-antseed-buyer-peer-id'] = buyerPeerId;

      debugLog(`[Node] Routing to provider "${provider.name}"`);
      const startTime = Date.now();
      let statusCode = 500;
      let responseBody: Uint8Array = new Uint8Array(0);
      let streamedResponseStarted = false;
      this._adjustProviderLoad(provider.name, 1);
      try {
        try {
          const response = await this._executeProviderRequest(provider, request, {
            onResponseStart: (streamResponseStart) => {
              streamedResponseStarted = true;
              statusCode = streamResponseStart.statusCode;
              mux.sendProxyResponse(streamResponseStart);
            },
            onResponseChunk: (chunk) => {
              if (!streamedResponseStarted) return;
              mux.sendProxyChunk(chunk);
            },
          });
          statusCode = response.statusCode;
          responseBody = response.body;
          debugLog(`[Node] Provider responded: status=${statusCode} (${Date.now() - startTime}ms, ${responseBody.length}b)`);
          if (!streamedResponseStarted) {
            mux.sendProxyResponse(response);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Internal error";
          debugWarn(`[Node] Provider error after ${Date.now() - startTime}ms: ${message}`);
          responseBody = new TextEncoder().encode(message);
          if (streamedResponseStarted) {
            mux.sendProxyChunk({
              requestId: request.requestId,
              data: new TextEncoder().encode(`event: error\ndata: ${message}\n\n`),
              done: false,
            });
            mux.sendProxyChunk({
              requestId: request.requestId,
              data: new Uint8Array(0),
              done: true,
            });
          } else {
            statusCode = 500;
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 500,
              headers: { "content-type": "text/plain" },
              body: responseBody,
            });
          }
        }

        // Record metering
        const latencyMs = Date.now() - startTime;
        const requestPricing = this._resolveProviderPricing(provider, request);
        await this._recordMetering(
          buyerPeerId,
          provider.name,
          requestPricing,
          request,
          statusCode,
          latencyMs,
          request.body.length,
          responseBody.length,
        );

        // Generate bilateral receipt after each request if lock committed (Task 3)
        const currentSession = this._sessions.get(buyerPeerId);
        if (currentSession?.lockCommitted) {
          await this._sendBilateralReceipt(buyerPeerId, currentSession, requestPricing, responseBody, paymentMux);
        }
      } finally {
        this._adjustProviderLoad(provider.name, -1);
      }
    });

    this._muxes.set(buyerPeerId, mux);
    this._wireConnection(conn, buyerPeerId);
    this.emit("connection", conn);
  }

  private async _executeProviderRequest(
    provider: Provider,
    request: SerializedHttpRequest,
    streamCallbacks?: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse> {
    if (streamCallbacks && provider.handleRequestStream) {
      return provider.handleRequestStream(request, streamCallbacks);
    }

    return provider.handleRequest(request);
  }

  private _stripStreamingHeader(response: SerializedHttpResponse): SerializedHttpResponse {
    if (response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] !== "1") {
      return response;
    }

    const headers = { ...response.headers };
    delete headers[ANTSEED_STREAMING_RESPONSE_HEADER];
    return {
      ...response,
      headers,
    };
  }

  private _parseJsonBody(body: Uint8Array): unknown | null {
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      return null;
    }
  }

  private _extractRequestedService(request: SerializedHttpRequest): string | null {
    const contentType = request.headers["content-type"] ?? request.headers["Content-Type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return null;
    }
    const parsed = this._parseJsonBody(request.body);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const service = (parsed as Record<string, unknown>)["model"];
    if (typeof service !== "string" || service.trim().length === 0) {
      return null;
    }
    return service.trim();
  }

  private _extractRequestedProvider(request: SerializedHttpRequest): string | null {
    const providers = Object.entries(request.headers)
      .filter(([header]) => header.toLowerCase() === "x-antseed-provider")
      .map(([, value]) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);

    return providers[0] ?? null;
  }

  private _resolveProviderPricing(
    provider: Provider,
    request: SerializedHttpRequest,
  ): { inputUsdPerMillion: number; outputUsdPerMillion: number } {
    const requestedService = this._extractRequestedService(request);
    if (requestedService) {
      const servicePricing = provider.pricing.services?.[requestedService];
      if (servicePricing) {
        return servicePricing;
      }
    }
    return provider.pricing.defaults;
  }

  private _getOrCreateSellerSession(
    buyerPeerId: string,
    providerName: string,
  ): SellerSessionState | null {
    if (!this._identity) {
      return null;
    }

    let session = this._sessions.get(buyerPeerId);
    if (!session) {
      const now = Date.now();
      const sessionId = randomUUID();
      // Generate 32-byte sessionIdBytes from UUID for on-chain use
      const sessionIdBytes = createHash("sha256").update(sessionId).digest();
      session = {
        sessionId,
        sessionIdBytes: new Uint8Array(sessionIdBytes),
        startedAt: now,
        lastActivityAt: now,
        totalRequests: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
        totalCostCents: 0,
        provider: providerName,
        lockCommitted: false,
        lockedAmount: 0n,
        runningTotal: 0n,
        ackedRequestCount: 0,
        lastAckedTotal: 0n,
        awaitingAck: false,
        buyerEvmAddress: null,
      };
      this._sessions.set(buyerPeerId, session);
    }

    session.provider = providerName;
    session.lastActivityAt = Date.now();
    this._emitSellerSessionUpdated(buyerPeerId, session);

    return session;
  }

  private _emitSellerSessionUpdated(buyerPeerId: string, session: SellerSessionState): void {
    this.emit("session:updated", {
      buyerPeerId,
      sessionId: session.sessionId,
      provider: session.provider,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      totalRequests: session.totalRequests,
      totalTokens: session.totalTokens,
      avgLatencyMs: session.totalRequests > 0 ? session.totalLatencyMs / session.totalRequests : 0,
      settling: Boolean(session.settling),
    });
  }

  /** Estimate tokens from byte lengths (rough: ~4 chars per token). */
  private _estimateTokens(inputBytes: number, outputBytes: number) {
    const inputTokens = Math.max(1, Math.round(inputBytes / 4));
    const outputTokens = Math.max(1, Math.round(outputBytes / 4));
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }

  private async _recordMetering(
    buyerPeerId: string,
    providerName: string,
    providerPricingUsdPerMillion: { inputUsdPerMillion: number; outputUsdPerMillion: number },
    request: SerializedHttpRequest,
    statusCode: number,
    latencyMs: number,
    inputBytes: number,
    outputBytes: number,
  ): Promise<void> {
    if (!this._identity) return;

    const sellerPeerId = this._identity.peerId;
    const isSSE = request.headers["accept"]?.includes("text/event-stream") ?? false;
    const tokens = this._estimateTokens(inputBytes, outputBytes);

    // Get or create session for this buyer
    const session = this._getOrCreateSellerSession(buyerPeerId, providerName);
    if (!session) return;

    session.totalRequests++;
    session.totalTokens += tokens.totalTokens;
    session.totalLatencyMs += latencyMs;
    session.provider = providerName;
    session.lastActivityAt = Date.now();
    this._emitSellerSessionUpdated(buyerPeerId, session);

    const metering = this._metering;
    if (!metering) {
      this._scheduleSettlementTimer(buyerPeerId);
      return;
    }

    // Record metering event
    const event: MeteringEvent = {
      eventId: randomUUID(),
      sessionId: session.sessionId,
      timestamp: Date.now(),
      provider: providerName,
      sellerPeerId,
      buyerPeerId,
      tokens: { ...tokens, method: "content-length", confidence: "low" },
      latencyMs,
      statusCode,
      wasStreaming: isSSE,
    };

    try {
      metering.insertEvent(event);
    } catch (err) {
      debugWarn(`[Node] Failed to record metering event: ${err instanceof Error ? err.message : err}`);
    }

    if (this._receiptGenerator) {
      const estimatedCostUsd =
        (tokens.inputTokens * providerPricingUsdPerMillion.inputUsdPerMillion +
          tokens.outputTokens * providerPricingUsdPerMillion.outputUsdPerMillion) /
        1_000_000;
      const effectiveUsdPerThousandTokens =
        tokens.totalTokens > 0 ? (estimatedCostUsd / tokens.totalTokens) * 1000 : 0;
      // Receipt unit pricing uses USD cents per 1,000 tokens.
      const unitPriceCentsPerThousandTokens = Math.max(0, effectiveUsdPerThousandTokens * 100);
      const receipt = this._receiptGenerator.generate(
        session.sessionId,
        event.eventId,
        providerName,
        buyerPeerId,
        event.tokens,
        unitPriceCentsPerThousandTokens,
      );
      try {
        metering.insertReceipt(receipt);
        session.totalCostCents += receipt.costCents;
      } catch (err) {
        debugWarn(`[Node] Failed to record usage receipt: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Upsert session
    const sessionMetrics: SessionMetrics = {
      sessionId: session.sessionId,
      sellerPeerId,
      buyerPeerId,
      provider: providerName,
      startedAt: session.startedAt,
      endedAt: null,
      totalRequests: session.totalRequests,
      totalTokens: session.totalTokens,
      totalCostCents: session.totalCostCents,
      avgLatencyMs: session.totalLatencyMs / session.totalRequests,
      peerSwitches: 0,
      disputedReceipts: 0,
    };

    try {
      metering.upsertSession(sessionMetrics);
    } catch (err) {
      debugWarn(`[Node] Failed to upsert session: ${err instanceof Error ? err.message : err}`);
    }

    this._scheduleSettlementTimer(buyerPeerId);
  }

  private async _initializePayments(dataDir: string): Promise<void> {
    const payments = this._config.payments;
    if (!payments || !payments.enabled) {
      return;
    }

    // Initialize BaseEscrowClient if Base config is provided
    if (payments.rpcUrl && payments.contractAddress && payments.usdcAddress) {
      this._escrowClient = new BaseEscrowClient({
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.contractAddress,
        usdcAddress: payments.usdcAddress,
      });
      debugLog(`[Node] BaseEscrowClient initialized (contract=${payments.contractAddress.slice(0, 10)}...)`);
    }

    if (!this._metering) {
      debugWarn("[Node] Payments enabled but metering storage is unavailable; skipping balance manager wiring");
      return;
    }

    const paymentsDir = join(dataDir, "payments");
    this._balanceManager = new BalanceManager();
    await this._balanceManager.load(paymentsDir).catch((err) => {
      debugWarn(`[Node] Failed to load payment balances: ${err instanceof Error ? err.message : err}`);
    });
  }

  private _scheduleSettlementTimer(buyerPeerId: string): void {
    const existing = this._settlementTimers.get(buyerPeerId);
    if (existing) {
      clearTimeout(existing);
    }

    const idleMs = this._config.payments?.settlementIdleMs ?? 30_000;
    const timer = setTimeout(() => {
      void this._finalizeSession(buyerPeerId, "idle-timeout");
    }, idleMs);

    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    this._settlementTimers.set(buyerPeerId, timer);
  }

  private async _finalizeSession(buyerPeerId: string, reason: string): Promise<void> {
    const session = this._sessions.get(buyerPeerId);
    if (!session || session.settling) {
      return;
    }
    session.settling = true;

    const timer = this._settlementTimers.get(buyerPeerId);
    if (timer) {
      clearTimeout(timer);
      this._settlementTimers.delete(buyerPeerId);
    }

    // Bilateral-aware disconnect handling (ghost scenario - Task 7)
    if (session.lockCommitted && this._escrowClient && this._identity && reason === "disconnect") {
      const sellerWallet = identityToEvmWallet(this._identity);
      const sessionIdHex = "0x" + bytesToHex(session.sessionIdBytes);

      try {
        if (session.lastAckedTotal > 0n) {
          // Buyer acked some work — open dispute with last acked total
          debugLog(`[Node] Ghost buyer — opening dispute with lastAckedTotal=${session.lastAckedTotal}`);
          await this._escrowClient.openDispute(sellerWallet, sessionIdHex, session.lastAckedTotal);
        } else if (session.runningTotal > 0n) {
          // No acks but work was done — open dispute with running total
          debugLog(`[Node] Ghost buyer — opening dispute with runningTotal=${session.runningTotal}`);
          await this._escrowClient.openDispute(sellerWallet, sessionIdHex, session.runningTotal);
        } else {
          // No work done — lock expires after 1 hour automatically
          debugLog(`[Node] Ghost buyer — no work done, lock will expire`);
        }
      } catch (err) {
        debugWarn(`[Node] Failed to handle ghost buyer for session ${session.sessionId}: ${err instanceof Error ? err.message : err}`);
      }

      this._sessions.delete(buyerPeerId);
      this.emit("session:finalized", {
        buyerPeerId,
        sessionId: session.sessionId,
        reason: "ghost-disconnect",
      });
      return;
    }

    if (!this._metering || !this._identity) {
      this._sessions.delete(buyerPeerId);
      return;
    }

    const now = Date.now();
    const baseMetrics: SessionMetrics = {
      sessionId: session.sessionId,
      sellerPeerId: this._identity.peerId,
      buyerPeerId,
      provider: session.provider,
      startedAt: session.startedAt,
      endedAt: now,
      totalRequests: session.totalRequests,
      totalTokens: session.totalTokens,
      totalCostCents: session.totalCostCents,
      avgLatencyMs: session.totalRequests > 0 ? session.totalLatencyMs / session.totalRequests : 0,
      peerSwitches: 0,
      disputedReceipts: 0,
    };

    try {
      this._metering.upsertSession(baseMetrics);
      this._sessions.delete(buyerPeerId);
      this.emit("session:finalized", {
        buyerPeerId,
        sessionId: session.sessionId,
        reason,
      });
    } catch (err) {
      session.settling = false;
      debugWarn(`[Node] Failed to finalize session ${session.sessionId}: ${err instanceof Error ? err.message : err}`);
      const retry = setTimeout(() => {
        void this._finalizeSession(buyerPeerId, "retry");
      }, 10_000);
      if (typeof (retry as { unref?: () => void }).unref === "function") {
        (retry as { unref: () => void }).unref();
      }
      this._settlementTimers.set(buyerPeerId, retry);
    }
  }

  private async _finalizeAllSessions(reason: string): Promise<void> {
    if (this._sessions.size === 0) return;
    const buyers = [...this._sessions.keys()];
    await Promise.allSettled(
      buyers.map((buyerPeerId) => this._finalizeSession(buyerPeerId, reason)),
    );
  }

  private async _getOrCreateConnection(peer: PeerInfo): Promise<PeerConnection> {
    if (!this._connectionManager || !this._identity) {
      throw new Error("Node not started");
    }

    const existing = this._connectionManager.getConnection(peer.peerId);
    if (
      existing &&
      existing.state !== ConnectionState.Closed &&
      existing.state !== ConnectionState.Failed
    ) {
      debugLog(`[Node] Reusing existing connection to ${peer.peerId.slice(0, 12)}... (state=${existing.state})`);
      // If still connecting, wait for it to reach Open or Authenticated
      if (existing.state === ConnectionState.Connecting) {
        debugLog(`[Node] Waiting for connection to open...`);
        await new Promise<void>((resolve, reject) => {
          const onState = (state: ConnectionState): void => {
            if (state === ConnectionState.Open || state === ConnectionState.Authenticated) {
              existing.off("stateChange", onState);
              resolve();
            } else if (state === ConnectionState.Failed || state === ConnectionState.Closed) {
              existing.off("stateChange", onState);
              reject(new Error(`Connection to ${peer.peerId} failed`));
            }
          };
          existing.on("stateChange", onState);
        });
      }
      return existing;
    }

    // Register the peer endpoint so ConnectionManager can resolve it
    if (peer.publicAddress) {
      const parts = peer.publicAddress.split(":");
      const host = parts[0]!;
      const port = parseInt(parts[1] ?? "6882", 10);
      this._connectionManager.registerPeerEndpoint(peer.peerId, { host, port });
      debugLog(`[Node] Connecting to ${peer.peerId.slice(0, 12)}... at ${host}:${port}`);
    } else {
      debugWarn(`[Node] Peer ${peer.peerId.slice(0, 12)}... has no public address`);
    }

    const connConfig: ConnectionConfig = {
      remotePeerId: peer.peerId,
      isInitiator: true,
    };

    const conn = this._connectionManager.createConnection(connConfig);

    // Wait for connection to open
    await new Promise<void>((resolve, reject) => {
      const onState = (state: ConnectionState): void => {
        debugLog(`[Node] Connection state: ${state}`);
        if (state === ConnectionState.Open || state === ConnectionState.Authenticated) {
          conn.off("stateChange", onState);
          resolve();
        } else if (state === ConnectionState.Failed || state === ConnectionState.Closed) {
          conn.off("stateChange", onState);
          reject(new Error(`Connection to ${peer.peerId} failed`));
        }
      };
      conn.on("stateChange", onState);
    });

    debugLog(`[Node] Connected to ${peer.peerId.slice(0, 12)}...`);
    this._wireConnection(conn, peer.peerId);
    return conn;
  }

  private _getOrCreateMux(peerId: PeerId, conn: PeerConnection): ProxyMux {
    const existing = this._muxes.get(peerId);
    if (existing) {
      return existing;
    }

    const mux = new ProxyMux(conn);
    this._muxes.set(peerId, mux);
    return mux;
  }

  // ── Seller-side bilateral payment handlers ─────────────────────

  /**
   * Handle SessionLockAuth from buyer (Task 2).
   * Recovers buyer address, commits lock on-chain, initializes bilateral state.
   */
  private async _handleSessionLockAuth(
    buyerPeerId: string,
    payload: SessionLockAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    if (!this._identity || !this._escrowClient) {
      paymentMux.sendSessionLockReject({
        sessionId: payload.sessionId,
        reason: "Escrow client not configured",
      });
      return;
    }

    try {
      const sellerWallet = identityToEvmWallet(this._identity);
      const lockedAmount = BigInt(payload.lockedAmount);

      // Recover buyer address from ECDSA signature
      const lockMsgHash = buildLockMessageHash(payload.sessionId, sellerWallet.address, lockedAmount);
      const buyerEvmAddress = verifyMessage(getBytes(lockMsgHash), payload.buyerSig);

      // Submit commit_lock on-chain
      const txHash = await this._escrowClient.commitLock(
        sellerWallet,
        buyerEvmAddress,
        payload.sessionId,
        lockedAmount,
        payload.buyerSig,
      );

      // Initialize or update bilateral session state
      let session: SellerSessionState | null | undefined = this._sessions.get(buyerPeerId);
      if (!session) {
        session = this._getOrCreateSellerSession(buyerPeerId, this._providers[0]?.name ?? "unknown");
      }
      if (session) {
        // Override sessionId with the one from the lock auth (buyer-chosen)
        session.sessionId = payload.sessionId;
        session.sessionIdBytes = hexToBytes(payload.sessionId.replace(/^0x/, ""));
        session.lockCommitted = true;
        session.lockedAmount = lockedAmount;
        session.runningTotal = 0n;
        session.ackedRequestCount = 0;
        session.lastAckedTotal = 0n;
        session.awaitingAck = false;
        session.buyerEvmAddress = buyerEvmAddress;
      }

      debugLog(`[Node] Lock committed for buyer ${buyerPeerId.slice(0, 12)}... amount=${lockedAmount} tx=${txHash.slice(0, 12)}...`);

      paymentMux.sendSessionLockConfirm({
        sessionId: payload.sessionId,
        txSignature: txHash,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      debugWarn(`[Node] Failed to commit lock for ${buyerPeerId.slice(0, 12)}...: ${reason}`);
      paymentMux.sendSessionLockReject({
        sessionId: payload.sessionId,
        reason,
      });
    }
  }

  /**
   * Generate and send a bilateral receipt after processing a request (Task 3).
   */
  private async _sendBilateralReceipt(
    _buyerPeerId: string,
    session: SellerSessionState,
    providerPricingUsdPerMillion: { inputUsdPerMillion: number; outputUsdPerMillion: number },
    responseBody: Uint8Array,
    paymentMux: PaymentMux,
  ): Promise<void> {
    if (!this._identity) return;

    // Calculate incremental cost in USDC base units (6 decimals)
    // Estimate tokens from response body size
    const tokens = this._estimateTokens(0, responseBody.length);
    const costUSD =
      (tokens.inputTokens * providerPricingUsdPerMillion.inputUsdPerMillion +
        tokens.outputTokens * providerPricingUsdPerMillion.outputUsdPerMillion) /
      1_000_000;
    const costBaseUnits = BigInt(Math.round(costUSD * 1_000_000));

    // Update running total
    session.runningTotal += costBaseUnits;

    // SHA-256 hash of response body for proof of work
    const responseHash = createHash("sha256").update(responseBody).digest();

    // Build receipt message and sign with Ed25519
    const receiptMsg = buildReceiptMessage(
      session.sessionIdBytes,
      session.runningTotal,
      session.totalRequests,
      new Uint8Array(responseHash),
    );
    const sellerSig = await signMessageEd25519(this._identity, receiptMsg);

    paymentMux.sendSellerReceipt({
      sessionId: session.sessionId,
      runningTotal: session.runningTotal.toString(),
      requestCount: session.totalRequests,
      responseHash: bytesToHex(new Uint8Array(responseHash)),
      sellerSig: bytesToHex(sellerSig),
    });

    session.awaitingAck = true;

    // Send TopUpRequest if running total > 80% of locked amount
    if (session.lockedAmount > 0n && session.runningTotal * 100n > session.lockedAmount * 80n) {
      const additionalAmount = session.lockedAmount; // Request same amount again
      paymentMux.sendTopUpRequest({
        sessionId: session.sessionId,
        additionalAmount: additionalAmount.toString(),
        currentRunningTotal: session.runningTotal.toString(),
        currentLockedAmount: session.lockedAmount.toString(),
      });
      debugLog(`[Node] TopUpRequest sent for session ${session.sessionId.slice(0, 8)}... (running=${session.runningTotal}, locked=${session.lockedAmount})`);
    }
  }

  /**
   * Handle BuyerAck (Task 4).
   * Verifies buyer's Ed25519 ack signature and updates session state.
   */
  private async _handleBuyerAck(buyerPeerId: string, payload: BuyerAckPayload): Promise<void> {
    const session = this._sessions.get(buyerPeerId);
    if (!session || !session.lockCommitted) {
      debugWarn(`[Node] Received BuyerAck for unknown/uncommitted session from ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    try {
      // Verify buyer's Ed25519 ack signature
      const buyerPublicKey = hexToBytes(buyerPeerId);
      const ackMsg = buildAckMessage(
        session.sessionIdBytes,
        BigInt(payload.runningTotal),
        payload.requestCount,
      );
      const sigBytes = hexToBytes(payload.buyerSig);
      const valid = await verifyMessageEd25519(buyerPublicKey, sigBytes, ackMsg);

      if (!valid) {
        debugWarn(`[Node] Invalid BuyerAck signature from ${buyerPeerId.slice(0, 12)}...`);
        return;
      }

      session.ackedRequestCount = payload.requestCount;
      session.lastAckedTotal = BigInt(payload.runningTotal);
      session.awaitingAck = false;

      debugLog(`[Node] BuyerAck received: requestCount=${payload.requestCount} runningTotal=${payload.runningTotal}`);
    } catch (err) {
      debugWarn(`[Node] Failed to process BuyerAck: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Handle SessionEnd from buyer (Task 5).
   * Submits settlement on-chain and cleans up.
   */
  private async _handleSessionEnd(buyerPeerId: string, payload: SessionEndPayload): Promise<void> {
    const session = this._sessions.get(buyerPeerId);
    if (!session || !session.lockCommitted) {
      debugWarn(`[Node] Received SessionEnd for unknown/uncommitted session from ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    if (!this._identity || !this._escrowClient) {
      debugWarn(`[Node] Cannot process SessionEnd — escrow client not available`);
      return;
    }

    try {
      const sellerWallet = identityToEvmWallet(this._identity);
      const sessionIdHex = "0x" + bytesToHex(session.sessionIdBytes);

      // Submit settlement on-chain with buyer's ECDSA signature and score
      const txHash = await this._escrowClient.settle(
        sellerWallet,
        sessionIdHex,
        BigInt(payload.runningTotal),
        payload.score,
        payload.buyerSig,
      );

      debugLog(`[Node] Session settled on-chain: ${session.sessionId.slice(0, 8)}... tx=${txHash.slice(0, 12)}... score=${payload.score}`);

      // Clean up session
      this._sessions.delete(buyerPeerId);
      const timer = this._settlementTimers.get(buyerPeerId);
      if (timer) {
        clearTimeout(timer);
        this._settlementTimers.delete(buyerPeerId);
      }

      this.emit("session:settled", {
        buyerPeerId,
        sessionId: session.sessionId,
        runningTotal: payload.runningTotal,
        score: payload.score,
        txHash,
      });
    } catch (err) {
      debugWarn(`[Node] Failed to settle session ${session.sessionId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Handle TopUpAuth from buyer (Task 6).
   * Calls extendLock on-chain and updates session.
   */
  private async _handleTopUpAuth(buyerPeerId: string, payload: TopUpAuthPayload): Promise<void> {
    const session = this._sessions.get(buyerPeerId);
    if (!session || !session.lockCommitted) {
      debugWarn(`[Node] Received TopUpAuth for unknown/uncommitted session from ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    if (!this._identity || !this._escrowClient) {
      debugWarn(`[Node] Cannot process TopUpAuth — escrow client not available`);
      return;
    }

    try {
      const sellerWallet = identityToEvmWallet(this._identity);
      const sessionIdHex = "0x" + bytesToHex(session.sessionIdBytes);
      const additionalAmount = BigInt(payload.additionalAmount);

      const txHash = await this._escrowClient.extendLock(
        sellerWallet,
        sessionIdHex,
        additionalAmount,
        payload.buyerSig,
      );

      session.lockedAmount += additionalAmount;
      debugLog(`[Node] TopUp committed: session=${session.sessionId.slice(0, 8)}... additional=${additionalAmount} newTotal=${session.lockedAmount} tx=${txHash.slice(0, 12)}...`);
    } catch (err) {
      debugWarn(`[Node] Failed to extend lock for session ${session.sessionId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Buyer-side payment helpers ─────────────────────────────────

  /**
   * Create a PaymentMux for a buyer-side outbound connection and register
   * buyer-side handlers (lock confirm, lock reject, seller receipt, top-up request).
   */
  private _getOrCreateBuyerPaymentMux(peerId: PeerId, conn: PeerConnection): PaymentMux {
    const existing = this._paymentMuxes.get(peerId);
    if (existing) return existing;

    const pmux = new PaymentMux(conn);
    this._paymentMuxes.set(peerId, pmux);

    const bpm = this._buyerPaymentManager;
    if (!bpm) return pmux;

    pmux.onSessionLockConfirm((payload) => {
      bpm.handleLockConfirm(peerId, payload);
    });

    pmux.onSessionLockReject((payload) => {
      bpm.handleLockReject(peerId, payload);
    });

    pmux.onSellerReceipt((receipt) => {
      void bpm.handleSellerReceipt(peerId, receipt, pmux);
    });

    pmux.onTopUpRequest((request) => {
      void bpm.handleTopUpRequest(peerId, request, pmux);
    });

    return pmux;
  }

  /**
   * Initiate a lock with a seller peer. Creates PaymentMux, signs lock auth,
   * and waits for confirmation before returning.
   */
  private async _initiateBuyerLock(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    const bpm = this._buyerPaymentManager;
    if (!bpm) return;

    // Mark as locked so we don't re-initiate
    this._buyerLockedPeers.add(peer.peerId);

    const pmux = this._getOrCreateBuyerPaymentMux(peer.peerId, conn);

    // Determine seller EVM address — prefer from peer metadata
    const sellerEvmAddress = peer.evmAddress ?? "";
    if (!sellerEvmAddress) {
      debugWarn(`[Node] Seller ${peer.peerId.slice(0, 12)}... has no EVM address; skipping lock initiation`);
      return;
    }

    try {
      await bpm.initiateLock(peer.peerId, sellerEvmAddress, pmux);
      debugLog(`[Node] Lock initiated for seller ${peer.peerId.slice(0, 12)}..., waiting for confirmation...`);

      // Wait for lock confirmation (polls every 200ms, 30s timeout)
      await this._waitForLockConfirmation(peer.peerId);
      debugLog(`[Node] Lock confirmed for seller ${peer.peerId.slice(0, 12)}...`);
    } catch (err) {
      debugWarn(`[Node] Lock initiation/confirmation failed for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      // Remove from locked set so next request can retry
      this._buyerLockedPeers.delete(peer.peerId);
    }
  }

  /**
   * Poll until the lock for a seller is confirmed or rejected.
   * Polls every 200ms with a 30-second timeout.
   */
  private async _waitForLockConfirmation(sellerPeerId: string): Promise<void> {
    const bpm = this._buyerPaymentManager;
    if (!bpm) return;

    const pollIntervalMs = 200;
    const timeoutMs = 30_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (bpm.isLockConfirmed(sellerPeerId)) {
        return;
      }
      if (bpm.isLockRejected(sellerPeerId)) {
        throw new Error(`Lock rejected by seller ${sellerPeerId.slice(0, 12)}...`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Lock confirmation timed out for seller ${sellerPeerId.slice(0, 12)}... (${timeoutMs}ms)`);
  }

  /**
   * End all active buyer payment sessions (called during shutdown).
   */
  private async _endAllBuyerSessions(): Promise<void> {
    const bpm = this._buyerPaymentManager;
    if (!bpm) return;

    const sessions = bpm.getActiveSessions();
    if (sessions.length === 0) return;

    debugLog(`[Node] Ending ${sessions.length} buyer payment session(s)...`);
    await Promise.allSettled(
      sessions.map((session) => {
        const pmux = this._paymentMuxes.get(session.sellerPeerId as PeerId);
        if (pmux) {
          return bpm.endSession(session.sellerPeerId, pmux, 80);
        }
        return Promise.resolve();
      }),
    );
  }

  private _resolvePublicAddress(result: LookupResult): string {
    const metadataPublicAddress = result.metadata.publicAddress?.trim();
    if (metadataPublicAddress && parsePublicAddress(metadataPublicAddress) !== null) {
      return metadataPublicAddress;
    }
    return `${result.host}:${result.port}`;
  }

  private _lookupResultToPeerInfo(result: LookupResult): PeerInfo {
    const providers = result.metadata.providers.map((p) => p.provider);
    const firstProvider = result.metadata.providers[0];
    const providerPricingEntries: NonNullable<PeerInfo["providerPricing"]> = {};
    const providerServiceCategoryEntries: NonNullable<PeerInfo["providerServiceCategories"]> = {};
    const providerServiceApiProtocolEntries: NonNullable<PeerInfo["providerServiceApiProtocols"]> = {};

    for (const providerAnnouncement of result.metadata.providers) {
      const serviceEntries: Record<string, TokenPricingUsdPerMillion> = {};
      for (const service of providerAnnouncement.services) {
        serviceEntries[service] =
          providerAnnouncement.servicePricing?.[service] ?? providerAnnouncement.defaultPricing;
      }
      providerPricingEntries[providerAnnouncement.provider] = {
        defaults: {
          inputUsdPerMillion: providerAnnouncement.defaultPricing.inputUsdPerMillion,
          outputUsdPerMillion: providerAnnouncement.defaultPricing.outputUsdPerMillion,
        },
        ...(Object.keys(serviceEntries).length > 0 ? { services: serviceEntries } : {}),
      };

      if (providerAnnouncement.serviceCategories && Object.keys(providerAnnouncement.serviceCategories).length > 0) {
        providerServiceCategoryEntries[providerAnnouncement.provider] = {
          services: Object.fromEntries(
            Object.entries(providerAnnouncement.serviceCategories)
              .map(([service, categories]) => [service, [...categories]]),
          ),
        };
      }

      if (providerAnnouncement.serviceApiProtocols && Object.keys(providerAnnouncement.serviceApiProtocols).length > 0) {
        providerServiceApiProtocolEntries[providerAnnouncement.provider] = {
          services: Object.fromEntries(
            Object.entries(providerAnnouncement.serviceApiProtocols)
              .map(([service, protocols]) => [service, [...protocols]]),
          ),
        };
      }
    }

    const hasProviderPricing = Object.keys(providerPricingEntries).length > 0;
    const hasProviderServiceCategories = Object.keys(providerServiceCategoryEntries).length > 0;
    const hasProviderServiceApiProtocols = Object.keys(providerServiceApiProtocolEntries).length > 0;

    return {
      peerId: result.metadata.peerId,
      displayName: result.metadata.displayName,
      lastSeen: result.metadata.timestamp,
      providers,
      publicAddress: this._resolvePublicAddress(result),
      ...(hasProviderPricing ? { providerPricing: providerPricingEntries } : {}),
      ...(hasProviderServiceCategories ? { providerServiceCategories: providerServiceCategoryEntries } : {}),
      ...(hasProviderServiceApiProtocols ? { providerServiceApiProtocols: providerServiceApiProtocolEntries } : {}),
      defaultInputUsdPerMillion: firstProvider?.defaultPricing.inputUsdPerMillion,
      defaultOutputUsdPerMillion: firstProvider?.defaultPricing.outputUsdPerMillion,
      maxConcurrency: firstProvider?.maxConcurrency,
      currentLoad: firstProvider?.currentLoad,
      evmAddress: result.metadata.evmAddress,
      onChainReputation: result.metadata.onChainReputation,
      onChainSessionCount: result.metadata.onChainSessionCount,
      onChainDisputeCount: result.metadata.onChainDisputeCount,
      trustScore: result.metadata.onChainReputation,
    };
  }

  private _adjustProviderLoad(providerName: string, delta: number): void {
    const nextLoad = Math.max(0, (this._providerLoadCounts.get(providerName) ?? 0) + delta);
    this._providerLoadCounts.set(providerName, nextLoad);

    if (!this._announcer) return;
    this._announcer.updateLoad(providerName, nextLoad);
    this._scheduleMetadataRefresh();
  }

  private _scheduleMetadataRefresh(): void {
    if (!this._announcer || this._metadataRefreshTimer) {
      return;
    }

    const timer = setTimeout(() => {
      this._metadataRefreshTimer = null;
      const announcer = this._announcer;
      if (!announcer) return;
      void announcer.refreshMetadata().catch((err) => {
        debugWarn(`[Node] Failed to refresh metadata snapshot: ${err instanceof Error ? err.message : err}`);
      });
    }, AntseedNode._METADATA_REFRESH_DEBOUNCE_MS);
    this._metadataRefreshTimer = timer;
    this._unrefTimer(timer);
  }

  private _unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

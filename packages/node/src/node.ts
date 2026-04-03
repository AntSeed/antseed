import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Identity, IdentityStore } from "./p2p/identity.js";
import { loadOrCreateIdentity } from "./p2p/identity.js";
import type { PeerId } from "./types/peer.js";
import type { PeerInfo, TokenPricingUsdPerMillion } from "./types/peer.js";
import { peerIdToAddress } from "./types/peer.js";
import {
  ANTSEED_STREAMING_RESPONSE_HEADER,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
  ANTSEED_SPENDING_AUTH_HEADER,
} from "./types/http.js";
import type { ConnectionConfig } from "./types/connection.js";
import { MeteringStorage } from "./metering/storage.js";
import { ReceiptGenerator } from "./metering/receipt-generator.js";
import {
  SellerSessionTracker,
  type SellerSessionSnapshot,
} from "./metering/seller-session-tracker.js";
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
import { FrameDecoder, encodeFrame } from "./p2p/message-protocol.js";
import { KeepaliveManager, buildPongPayload } from "./p2p/keepalive.js";
import { MessageType } from "./types/protocol.js";
import type {
  Provider,
  ProviderStreamCallbacks,
} from "./interfaces/seller-provider.js";
import type { Router } from "./interfaces/buyer-router.js";
import { NatTraversal } from "./p2p/nat-traversal.js";
import { signUtf8 } from "./p2p/identity.js";
import {
  BalanceManager,
  type PaymentConfig,
  type PaymentMethod,
  DepositsClient,
  ChannelsClient,
  StakingClient,
  ChannelStore,
} from "./payments/index.js";
import { debugLog, debugWarn } from "./utils/debug.js";
import { parsePublicAddress } from "./discovery/public-address.js";
import { BuyerPaymentManager, type BuyerPaymentConfig } from "./payments/buyer-payment-manager.js";
import { BuyerPaymentNegotiator } from "./payments/buyer-payment-negotiator.js";
import { SellerPaymentManager, type SellerPaymentConfig } from "./payments/seller-payment-manager.js";
import { IdentityClient } from "./payments/evm/identity-client.js";
import { SellerRequestHandler } from "./seller-request-handler.js";

export type { Provider, ProviderStreamCallbacks };
export type { Router };
export type { BuyerPaymentConfig };
export type { SellerSessionSnapshot };

export interface NodePaymentsConfig {
  /** Enable seller-side payment channels and automatic settlement. */
  enabled?: boolean;
  /** Payment method used for settlement. Default: "crypto" */
  paymentMethod?: PaymentMethod;
  /** Platform fee rate in [0,1]. Default: 0.05 */
  platformFeeRate?: number;
  /** Idle time before a session is finalized and settled. Default: 30000ms */
  settlementIdleMs?: number;
  /** Default deposit amount in USDC units. Default: "1" */
  defaultDepositAmountUSDC?: string;
  /** Optional seller wallet address for auto-funded deposit. */
  sellerWalletAddress?: string;
  /** Settlement backend configuration (crypto). */
  paymentConfig?: PaymentConfig | null;
  /** Base JSON-RPC URL (e.g. http://127.0.0.1:8545 for anvil) */
  rpcUrl?: string;
  /** Deployed AntseedDeposits contract address */
  depositsAddress?: string;
  /** Deployed AntseedChannels contract address */
  channelsAddress?: string;
  /** USDC token contract address */
  usdcAddress?: string;
  /** ERC-8004 IdentityRegistry contract address */
  identityRegistryAddress?: string;
  /** AntseedStaking contract address */
  stakingAddress?: string;
  /** Chain ID for EIP-712 domain. Default: 8453 (Base) */
  chainId?: number;
  /** Default maximum USDC per spending auth. Default: 100000 ($0.10) */
  defaultMaxAmountUsdc?: string;
  /** Default auth duration in seconds. Default: 90000 */
  defaultAuthDurationSecs?: number;
  /** Minimum USDC per request (base units) for seller. Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Maximum USDC the buyer authorizes per single request (base units). Default: "100000" ($0.10). */
  maxPerRequestUsdc?: string;
  /** Maximum total USDC the buyer will reserve in a single SpendingAuth (base units). Default: "10000000" ($10.00). */
  maxReserveAmountUsdc?: string;
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
  /** Pluggable identity storage backend. When set, takes precedence over dataDir for identity loading. */
  identityStore?: IdentityStore;
  /** Optional explicit config.json path for runtime config reloads. */
  configPath?: string;
  /**
   * When true, the node returns the 402 to the caller instead of auto-signing.
   * The caller can then sign externally and retry with x-antseed-spending-auth header.
   */
  requireManualApproval?: boolean;
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
  private _keepalives = new Map<PeerId, KeepaliveManager>();
  private _nat: NatTraversal | null = null;
  private _metering: MeteringStorage | null = null;
  private _receiptGenerator: ReceiptGenerator | null = null;
  private _balanceManager: BalanceManager | null = null;
  private _depositsClient: DepositsClient | null = null;
  private _channelsClient: ChannelsClient | null = null;
  private _stakingClient: StakingClient | null = null;
  private _identityClient: IdentityClient | null = null;
  private _paymentMuxes = new Map<PeerId, PaymentMux>();
  /** Seller-side request handler (provider matching, execution, load tracking). */
  private _sellerHandler: SellerRequestHandler | null = null;
  /** Buyer-side payment manager (initialized when buyer has payment config). */
  private _buyerPaymentManager: BuyerPaymentManager | null = null;
  /** Buyer-side payment negotiation (402 handling, SpendingAuth, cost tracking). */
  private _buyerNegotiator: BuyerPaymentNegotiator | null = null;
  /** Seller-side payment manager (initialized when seller has payment config). */
  private _sellerPaymentManager: SellerPaymentManager | null = null;
  /** Shared channel store for payment persistence. */
  private _channelStore: ChannelStore | null = null;
  /** Periodic timeout checker interval. */
  private _timeoutCheckerInterval: ReturnType<typeof setInterval> | null = null;
  /** Seller session lifecycle tracking (metering, settlement). */
  private _sessionTracker: SellerSessionTracker | null = null;

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

  /** Buyer-side payment negotiator (null if payments not configured for buyer). */
  get buyerNegotiator(): BuyerPaymentNegotiator | null {
    return this._buyerNegotiator;
  }

  /** Actual DHT port after binding (0 means not started). */
  get dhtPort(): number {
    return this._dht?.getPort() ?? 0;
  }

  /** Actual signaling/connection port after binding (0 means not started). */
  get signalingPort(): number {
    return this._connectionManager?.getListeningPort() ?? 0;
  }

  /** ERC-8004 IdentityRegistry client (null if not configured). */
  get identityClient(): IdentityClient | null {
    return this._identityClient;
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
    return this._sessionTracker?.getActiveSessions() ?? [];
  }

  /** Number of active in-memory seller channels that are not currently settling. */
  getActiveSellerChannelCount(): number {
    return this._sessionTracker?.getActiveChannelCount() ?? 0;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Node already started");
    }

    const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");

    // Load or create identity
    this._identity = await loadOrCreateIdentity(this._config.identityStore ?? dataDir);
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
    if (this._buyerNegotiator) {
      this._buyerNegotiator.cleanup();
    }

    if (this._sessionTracker) {
      await this._sessionTracker.finalizeAllSessions("node-stop");
      this._sessionTracker.clearTimers();
    }
    if (this._sellerHandler) {
      this._sellerHandler.clearMetadataRefreshTimer();
      this._sellerHandler = null;
    }

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

    // Stop all keepalive managers
    for (const keepalive of this._keepalives.values()) {
      keepalive.stop();
    }
    this._keepalives.clear();

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

    if (this._timeoutCheckerInterval) {
      clearInterval(this._timeoutCheckerInterval);
      this._timeoutCheckerInterval = null;
    }

    if (this._channelStore) {
      try {
        this._channelStore.close();
      } catch {
        // ignore close errors
      }
      this._channelStore = null;
    }

    this._peerLookup = null;
    this._receiptGenerator = null;
    this._balanceManager = null;
    this._depositsClient = null;
    this._channelsClient = null;
    this._stakingClient = null;
    this._identityClient = null;
    this._buyerPaymentManager = null;
    this._buyerNegotiator = null;
    this._sellerPaymentManager = null;
    this._sessionTracker = null;
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

    // Verify claimed on-chain stats against actual contract data
    if (this._channelsClient && this._stakingClient) {
      for (const p of peers) {
        try {
          const evmAddress = peerIdToAddress(p.peerId);
          const agentId = await this._stakingClient.getAgentId(evmAddress);
          const stats = await this._channelsClient.getAgentStats(agentId);
          p.onChainChannelCount = stats.channelCount;
          p.onChainGhostCount = stats.ghostCount;
        } catch {
          // Contract lookup failed for this peer — keep claimed data
        }
      }
    }

    for (const p of peers) {
      debugLog(`[Node]   peer ${p.peerId.slice(0, 12)}... providers=[${p.providers.join(",")}] addr=${p.publicAddress ?? "?"}`);
    }
    return peers;
  }

  /**
   * Eagerly open a connection to a peer and wire up the mux.
   * Subsequent sendRequest / sendRequestStream calls will reuse this connection.
   */
  async connectToPeer(peer: PeerInfo): Promise<void> {
    const conn = await this._getOrCreateConnection(peer);
    this._getOrCreateMux(peer.peerId, conn);
    if (this._buyerNegotiator) {
      this._paymentMuxes.set(peer.peerId, this._buyerNegotiator.getOrCreatePaymentMux(peer.peerId, conn));
    }
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
    const negotiator = this._buyerNegotiator;
    if (negotiator) {
      this._paymentMuxes.set(peer.peerId, negotiator.getOrCreatePaymentMux(peer.peerId, conn));
    }

    // Extract and strip x-antseed-spending-auth header if present (manual approval flow)
    const externalSpendingAuth = req.headers[ANTSEED_SPENDING_AUTH_HEADER] ?? null;
    if (externalSpendingAuth) {
      const { [ANTSEED_SPENDING_AUTH_HEADER]: _, ...cleanHeaders } = req.headers;
      req = { ...req, headers: cleanHeaders };
    }

    // If an external spending auth was provided, apply it before sending the request.
    if (externalSpendingAuth && negotiator) {
      debugLog(`[Node] Applying external spending auth for ${peer.peerId.slice(0, 12)}...`);
      await negotiator.applyExternalSpendingAuth(peer, conn, externalSpendingAuth);
    }

    if (negotiator && !externalSpendingAuth) {
      await negotiator.preparePreRequestAuth(peer, conn);
    }

    let startTime = Date.now();

    const executeRequest = (): Promise<SerializedHttpResponse> => new Promise<SerializedHttpResponse>((resolve, reject) => {
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
            if (callbacks?.onResponseChunk) {
              // Streaming mode: chunks already delivered to caller via callback.
              // Track byte count for the debug timeout log only — do not
              // enforce maxStreamBufferBytes so large streams aren't rejected.
              streamBufferedBytes += chunk.data.length;
              streamChunks.push(chunk.data);
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

    // Execute the request. If we get a 402 and payment negotiation is needed,
    // wait for the seller's PaymentRequired message, negotiate, and retry.
    const response = await executeRequest();

    if (response.statusCode === 402 && negotiator && !externalSpendingAuth) {
      const result = await negotiator.handle402(response, peer, conn, req);
      if (result.action === 'return') return result.response;
      // Retry after successful negotiation
      startTime = Date.now();
      return executeRequest();
    }

    // Track response cost for buyer-side per-request auth verification
    if (negotiator) {
      negotiator.estimateCostFromResponse(peer, response);
      negotiator.parseCostHeaders(peer.peerId, response);
      negotiator.recordResponseContent(peer.peerId, req.body, response.body, Date.now() - startTime);
    }

    return response;
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
        // Keepalive: respond to Ping, dispatch Pong to manager
        if (frame.type === MessageType.Ping) {
          if (conn.state === ConnectionState.Open || conn.state === ConnectionState.Authenticated) {
            conn.send(encodeFrame({
              type: MessageType.Pong,
              messageId: frame.messageId,
              payload: buildPongPayload(frame.payload),
            }));
          }
          continue;
        }
        if (frame.type === MessageType.Pong) {
          this._keepalives.get(peerId)?.handlePong(frame.payload);
          continue;
        }
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
        // Stop keepalive for this peer
        this._keepalives.get(peerId)?.stop();
        this._keepalives.delete(peerId);
        // Flush any in-progress chunked uploads so buffers are not leaked
        this._muxes.get(peerId)?.abortPendingUploads();
        this._muxes.delete(peerId);
        this._paymentMuxes.delete(peerId);
        this._decoders.delete(peerId);
        // Clean up buyer-side payment state on disconnect
        this._buyerNegotiator?.onPeerDisconnect(peerId);
        // Handle buyer disconnect (seller side)
        if (this._sellerPaymentManager) {
          this._sellerPaymentManager.onBuyerDisconnect(peerId);
        }
        if (this._sessionTracker) {
          void this._sessionTracker.finalizeSession(peerId, "disconnect");
        }
      }
    });

    // Start keepalive pings on outbound (buyer-initiated) connections to
    // detect dead peers proactively instead of waiting for a request to fail.
    if (conn.isInitiator) {
      const keepalive = new KeepaliveManager({
        sendPing: (payload: Uint8Array) => {
          if (conn.state === ConnectionState.Open || conn.state === ConnectionState.Authenticated) {
            conn.send(encodeFrame({
              type: MessageType.Ping,
              messageId: 0,
              payload,
            }));
          }
        },
        onDead: () => {
          if (conn.state !== ConnectionState.Open && conn.state !== ConnectionState.Authenticated) return;
          debugWarn(`[Node] Keepalive timeout for ${peerId.slice(0, 12)}...`);
          conn.fail(new Error("Keepalive timeout"));
        },
      });
      this._keepalives.get(peerId)?.stop();
      this._keepalives.set(peerId, keepalive);
      keepalive.start();
    }
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
        sign: (message: string) => signUtf8(identity.wallet, message),
      });
    }

    // Initialize seller session tracker
    this._sessionTracker = new SellerSessionTracker(
      identity,
      this._metering,
      this._receiptGenerator,
      { settlementIdleMs: this._config.payments?.settlementIdleMs },
      {
        onSessionUpdated: (snapshot) => this.emit("session:updated", snapshot),
        onSessionFinalized: (info) => this.emit("session:finalized", info),
      },
    );

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
        ...(this._channelsClient ? { channelsClient: this._channelsClient } : {}),
        ...(this._stakingClient ? { stakingClient: this._stakingClient, paymentsEnabled: true } : {}),
      };
      this._announcer = new PeerAnnouncer(announcerConfig);
      this._announcer.startPeriodicAnnounce();

      // Serve metadata on the signaling port (HTTP requests are auto-detected)
      this._connectionManager!.setMetadataProvider(
        () => this._announcer?.getLatestMetadata() ?? null,
      );
    }

    // Create seller request handler
    this._sellerHandler = new SellerRequestHandler({
      providers: this._providers,
      sellerPaymentManager: this._sellerPaymentManager,
      sessionTracker: this._sessionTracker,
      channelsClient: this._channelsClient,
      announcer: this._announcer,
      emit: (event, ...args) => this.emit(event, ...args),
    });

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

    const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");
    await this._initializePayments(dataDir);

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
    if (payments?.enabled && payments.rpcUrl && payments.depositsAddress && payments.channelsAddress && payments.usdcAddress) {
      const paymentsDir = join(dataDir, "payments");
      // Create shared ChannelStore for both buyer and seller payment managers
      if (!this._channelStore) {
        try {
          this._channelStore = new ChannelStore(paymentsDir);
          debugLog("[Node] ChannelStore initialized (buyer)");
        } catch (err) {
          debugWarn(`[Node] ChannelStore unavailable: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (this._channelStore) {
        const buyerPaymentConfig: BuyerPaymentConfig = {
          rpcUrl: payments.rpcUrl,
          depositsContractAddress: payments.depositsAddress,
          channelsContractAddress: payments.channelsAddress,
          usdcAddress: payments.usdcAddress,
          identityRegistryAddress: payments.identityRegistryAddress ?? '',
          chainId: payments.chainId ?? 8453,
          defaultAuthDurationSecs: payments.defaultAuthDurationSecs ?? 900, // 15 min — seller must call reserve() promptly
          maxPerRequestUsdc: BigInt(payments.maxPerRequestUsdc ?? "500000"),  // $0.50 default — covers most LLM requests
          maxReserveAmountUsdc: BigInt(payments.maxReserveAmountUsdc ?? "5000000"),  // $5.00 default per session
          dataDir: paymentsDir,
        };
        this._buyerPaymentManager = new BuyerPaymentManager(identity, buyerPaymentConfig, this._channelStore);
        debugLog(`[Node] Buyer payment manager initialized (wallet=${identity.wallet.address.slice(0, 10)}... chainId=${buyerPaymentConfig.chainId} deposits=${buyerPaymentConfig.depositsContractAddress.slice(0, 10)}...)`);

        // Create negotiator that wraps the BPM with 402 handling and per-request auth
        this._buyerNegotiator = new BuyerPaymentNegotiator(
          identity,
          this._buyerPaymentManager,
          this._depositsClient,
          this._channelStore,
          {
            configPath: this._config.configPath,
            dataDir: this._config.dataDir,
            requireManualApproval: this._config.requireManualApproval,
          },
          this,
        );
        debugLog(`[Node] Buyer payment negotiator initialized`);
      }
    }

    debugLog(`[Node] Buyer ready — DHT running on port ${this._dht!.getPort()}`);
  }

  private _handleIncomingConnection(conn: PeerConnection): void {
    debugLog(`[Node] Incoming connection from ${conn.remotePeerId.slice(0, 12)}...`);
    const buyerPeerId = conn.remotePeerId;

    // Create PaymentMux alongside ProxyMux (seller-side)
    const paymentMux = new PaymentMux(conn);
    if (this._sellerPaymentManager) {
      const spm = this._sellerPaymentManager;
      paymentMux.onSpendingAuth((payload) => {
        void spm.handleSpendingAuth(buyerPeerId, payload, paymentMux)
          .then((status) => {
            if (status === 'rejected') {
              debugWarn(`[Node] SpendingAuth rejected for buyer ${buyerPeerId.slice(0, 12)}... — notifying via payment:auth-rejected event`);
              this.emit('payment:auth-rejected', { buyerPeerId, reason: 'invalid_or_non_monotonic' });
            }
          })
          .catch((err) => {
            debugWarn(`[Node] SpendingAuth handler error for ${buyerPeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
          });
      });
    } else {
      paymentMux.onSpendingAuth(() => {
        debugWarn(`[Node] SpendingAuth rejected — SellerPaymentManager not configured`);
      });
    }
    this._paymentMuxes.set(buyerPeerId, paymentMux);

    const { mux } = this._sellerHandler!.handleConnection(conn, buyerPeerId, paymentMux);

    this._muxes.set(buyerPeerId, mux);
    this._wireConnection(conn, buyerPeerId);
    this.emit("connection", conn);
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

  private async _initializePayments(dataDir: string): Promise<void> {
    const payments = this._config.payments;
    if (!payments || !payments.enabled) {
      return;
    }

    // Initialize DepositsClient
    if (payments.rpcUrl && payments.depositsAddress && payments.usdcAddress) {
      this._depositsClient = new DepositsClient({
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.depositsAddress,
        usdcAddress: payments.usdcAddress,
      });
      debugLog(`[Node] DepositsClient initialized (contract=${payments.depositsAddress.slice(0, 10)}...)`);
    }

    // Initialize ChannelsClient
    if (payments.rpcUrl && payments.channelsAddress) {
      this._channelsClient = new ChannelsClient({
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.channelsAddress,
      });
      debugLog(`[Node] ChannelsClient initialized (contract=${payments.channelsAddress.slice(0, 10)}...)`);
    }

    // Initialize StakingClient
    if (payments.rpcUrl && payments.stakingAddress && payments.usdcAddress) {
      this._stakingClient = new StakingClient({
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.stakingAddress,
        usdcAddress: payments.usdcAddress,
      });
      debugLog(`[Node] StakingClient initialized (contract=${payments.stakingAddress.slice(0, 10)}...)`);
    }

    // Initialize IdentityClient (ERC-8004 IdentityRegistry)
    if (payments.rpcUrl && payments.identityRegistryAddress) {
      this._identityClient = new IdentityClient({
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.identityRegistryAddress,
      });
      debugLog(`[Node] IdentityClient initialized (contract=${payments.identityRegistryAddress.slice(0, 10)}...)`);
    }

    // Initialize ChannelStore for persistent payment channels (shared instance)
    const paymentsDir = join(dataDir, "payments");
    if (!this._channelStore) {
      try {
        this._channelStore = new ChannelStore(paymentsDir);
        debugLog("[Node] ChannelStore initialized");
      } catch (err) {
        debugWarn(`[Node] ChannelStore unavailable: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Initialize SellerPaymentManager for seller role
    if (this._config.role === 'seller' && this._identity && this._channelStore &&
        payments.rpcUrl && payments.channelsAddress) {
      const sellerConfig: SellerPaymentConfig = {
        rpcUrl: payments.rpcUrl,
        channelsContractAddress: payments.channelsAddress,
        chainId: payments.chainId ?? 8453,
        dataDir: paymentsDir,
        ...(payments.minBudgetPerRequest ? { minBudgetPerRequest: payments.minBudgetPerRequest } : {}),
      };
      this._sellerPaymentManager = new SellerPaymentManager(this._identity, sellerConfig, this._channelStore);
      debugLog(`[Node] SellerPaymentManager initialized`);

      // Startup recovery: check for timed-out sessions
      await this._sellerPaymentManager.checkTimeouts();

      // Start periodic timeout checker (every 60s)
      this._timeoutCheckerInterval = setInterval(() => {
        void this._sellerPaymentManager?.checkTimeouts();
      }, 60_000);
      if (typeof (this._timeoutCheckerInterval as { unref?: () => void }).unref === "function") {
        (this._timeoutCheckerInterval as { unref: () => void }).unref();
      }
    }

    if (!this._metering) {
      debugWarn("[Node] Payments enabled but metering storage is unavailable; skipping balance manager wiring");
      return;
    }

    this._balanceManager = new BalanceManager();
    await this._balanceManager.load(paymentsDir).catch((err) => {
      debugWarn(`[Node] Failed to load payment balances: ${err instanceof Error ? err.message : err}`);
    });
  }

  private async _getOrCreateConnection(peer: PeerInfo): Promise<PeerConnection> {
    if (!this._connectionManager || !this._identity) {
      throw new Error("Node not started");
    }

    const existing = this._connectionManager.getConnection(peer.peerId);
    let endpointChanged = false;

    // Check if the peer's endpoint has changed (e.g. IP rotation).
    // Only applies to outbound connections where we registered the endpoint;
    // inbound connections (peer connected to us) have no registered endpoint
    // and are not subject to pinned-peer routing.
    if (existing && peer.publicAddress) {
      const currentEndpoint = ConnectionManager.resolvePeerEndpoint(peer.peerId);
      const { host: newHost, port: newPort } = parsePeerAddress(peer.publicAddress);
      if (currentEndpoint && (currentEndpoint.host !== newHost || currentEndpoint.port !== newPort)) {
        debugLog(`[Node] Peer ${peer.peerId.slice(0, 12)}... endpoint changed from ${currentEndpoint.host}:${currentEndpoint.port} to ${newHost}:${newPort}, reconnecting`);
        existing.close();
        endpointChanged = true;
      }
    }

    if (
      existing && !endpointChanged &&
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
      const { host, port } = parsePeerAddress(peer.publicAddress);
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
      onChainChannelCount: result.metadata.onChainChannelCount,
      onChainGhostCount: result.metadata.onChainGhostCount,
    };
  }

}

function parsePeerAddress(address: string): { host: string; port: number } {
  const parts = address.split(":");
  return { host: parts[0]!, port: parseInt(parts[1] ?? "6882", 10) };
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

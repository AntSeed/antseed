import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import type { MeteringEvent, SessionMetrics, TokenCount } from "./types/metering.js";
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
import { FrameDecoder, encodeFrame } from "./p2p/message-protocol.js";
import { KeepaliveManager, buildPongPayload } from "./p2p/keepalive.js";
import { MessageType } from "./types/protocol.js";
import type { PaymentRequiredPayload } from "./types/protocol.js";
import type {
  Provider,
  ProviderStreamCallbacks,
} from "./interfaces/seller-provider.js";
import type { Router } from "./interfaces/buyer-router.js";
import { NatTraversal } from "./p2p/nat-traversal.js";
import { signUtf8 } from "./p2p/identity.js";
// verifyMessage/getBytes removed — no longer needed after SpendingAuth refactor
import {
  BalanceManager,
  type PaymentConfig,
  type PaymentMethod,
  DepositsClient,
  SessionsClient,
  StakingClient,
  SessionStore,
} from "./payments/index.js";
import { parseJsonObject, extractUsage } from "@antseed/api-adapter";
import { debugLog, debugWarn } from "./utils/debug.js";
import { parsePublicAddress } from "./discovery/public-address.js";
import { BuyerPaymentManager, type BuyerPaymentConfig } from "./payments/buyer-payment-manager.js";
import { computeCostUsdc } from "./payments/pricing.js";
import { SellerPaymentManager, type SellerPaymentConfig } from "./payments/seller-payment-manager.js";
import { IdentityClient } from "./payments/evm/identity-client.js";
import { StatsClient } from "./payments/evm/stats-client.js";
import { verifyStats } from "./discovery/stats-verifier.js";

export type { Provider, ProviderStreamCallbacks };
export type { Router };
export type { BuyerPaymentConfig };

/**
 * Extract actual token usage from an LLM provider response body.
 * Handles both JSON and SSE (streaming) responses. Returns zeros
 * if usage data is not found (caller should fall back to estimation).
 */
function parseResponseUsage(body: Uint8Array): { inputTokens: number; outputTokens: number } {
  const parsed = parseJsonObject(body);
  if (parsed) {
    return extractUsage(parsed);
  }
  // SSE streaming: scan data lines for a usage object
  const text = new TextDecoder().decode(body);
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      const usage = extractUsage(event);
      if (usage.inputTokens > 0) inputTokens = Math.max(inputTokens, usage.inputTokens);
      if (usage.outputTokens > 0) outputTokens = Math.max(outputTokens, usage.outputTokens);
    } catch { /* skip non-JSON lines */ }
  }
  return { inputTokens, outputTokens };
}

/**
 * Compute request cost in USDC base units (6 decimals) from token counts and USD pricing.
 * pricing.inputUsdPerMillion / pricing.outputUsdPerMillion are in USD per million tokens.
 * Returns cost in base units (1 USDC = 1_000_000).
 */
// computeCostUsdc imported from ./payments/pricing.js

function parsePaymentRequiredBody(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

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
  /** Deployed AntseedSessions contract address */
  sessionsAddress?: string;
  /** USDC token contract address */
  usdcAddress?: string;
  /** ERC-8004 IdentityRegistry contract address */
  identityRegistryAddress?: string;
  /** AntseedStats contract address */
  statsAddress?: string;
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
  private _keepalives = new Map<PeerId, KeepaliveManager>();
  private _nat: NatTraversal | null = null;
  private _metering: MeteringStorage | null = null;
  private _receiptGenerator: ReceiptGenerator | null = null;
  private _balanceManager: BalanceManager | null = null;
  private _depositsClient: DepositsClient | null = null;
  private _sessionsClient: SessionsClient | null = null;
  private _stakingClient: StakingClient | null = null;
  private _identityClient: IdentityClient | null = null;
  private _statsClient: StatsClient | null = null;
  private _paymentMuxes = new Map<PeerId, PaymentMux>();
  private _providerLoadCounts = new Map<string, number>();
  private _metadataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-buyer session tracking: buyerPeerId → seller session state */
  private _sessions = new Map<string, SellerSessionState>();
  private _settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Buyer-side payment manager (initialized when buyer has payment config). */
  private _buyerPaymentManager: BuyerPaymentManager | null = null;
  /** Seller-side payment manager (initialized when seller has payment config). */
  private _sellerPaymentManager: SellerPaymentManager | null = null;
  /** Shared session store for payment persistence. */
  private _sessionStore: SessionStore | null = null;
  /** Periodic timeout checker interval. */
  private _timeoutCheckerInterval: ReturnType<typeof setInterval> | null = null;
  /** Tracks which seller peers the buyer has already negotiated payment for. */
  private _buyerLockedPeers = new Set<string>();
  /** Pending PaymentRequired payloads from sellers, keyed by peerId. Resolvers waiting for them. */
  private _pendingPaymentRequired = new Map<string, {
    resolve: (payload: PaymentRequiredPayload) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private _manualApprovalCache: { value: boolean; at: number } | null = null;
  /** Buffered PaymentRequired that arrived before _doNegotiatePayment registered its listener.
   *  This handles the race where 402 + PaymentRequired arrive in the same I/O tick. */
  private _bufferedPaymentRequired = new Map<string, PaymentRequiredPayload>();
  /** Per-peer mutex to prevent concurrent payment negotiations. */
  private _paymentNegotiationLocks = new Map<string, Promise<void>>();
  /** Peers that have already sent their first request after session establishment.
   *  Used to distinguish whether per-request SpendingAuth should be attached. */
  private _buyerFirstRequestSent = new Set<string>();
  /** Per-peer last response cost, raw content, and latency from the seller. */
  private _lastResponseCost = new Map<string, {
    costUsdc: bigint;
    inputTokens: bigint;
    outputTokens: bigint;
    cumulativeCost: bigint;
    inputContent: Uint8Array;
    outputContent: Uint8Array;
    latencyMs: number;
  }>();

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

  /** ERC-8004 IdentityRegistry client (null if not configured). */
  get identityClient(): IdentityClient | null {
    return this._identityClient;
  }

  /** AntseedStats client for on-chain agent stats (null if not configured). */
  get statsClient(): StatsClient | null {
    return this._statsClient;
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

    if (this._sessionStore) {
      try {
        this._sessionStore.close();
      } catch {
        // ignore close errors
      }
      this._sessionStore = null;
    }

    this._peerLookup = null;
    this._receiptGenerator = null;
    this._balanceManager = null;
    this._depositsClient = null;
    this._sessionsClient = null;
    this._stakingClient = null;
    this._identityClient = null;
    this._statsClient = null;
    this._buyerPaymentManager = null;
    this._sellerPaymentManager = null;
    this._buyerLockedPeers.clear();
    this._buyerFirstRequestSent.clear();
    this._lastResponseCost.clear();
    // Clean up payment negotiation state
    for (const [, pending] of this._pendingPaymentRequired) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Node stopped'));
    }
    this._pendingPaymentRequired.clear();
    this._bufferedPaymentRequired.clear();
    this._paymentNegotiationLocks.clear();
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



    // Optional stats verification: replace claimed data with verified on-chain data
    if (this._statsClient && this._stakingClient) {
      for (const p of peers) {
        try {
          const metadata: import("./discovery/peer-metadata.js").PeerMetadata = {
            peerId: p.peerId,
            version: 0,
            providers: [],
            region: "",
            timestamp: 0,
            signature: "",
            onChainReputation: p.onChainReputation,
            onChainSessionCount: p.onChainSessionCount,
            onChainDisputeCount: p.onChainDisputeCount,
          };
          const result = await verifyStats(this._statsClient, this._stakingClient, metadata);
          p.onChainReputation = result.actualReputation;
          p.onChainSessionCount = result.actualSessionCount;
          p.onChainDisputeCount = result.actualDisputeCount;
        } catch {
          // Stats/staking contract lookup failed for this peer — keep claimed data
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

    // Extract and strip x-antseed-spending-auth header if present (manual approval flow)
    const externalSpendingAuth = req.headers[ANTSEED_SPENDING_AUTH_HEADER] ?? null;
    if (externalSpendingAuth) {
      const { [ANTSEED_SPENDING_AUTH_HEADER]: _, ...cleanHeaders } = req.headers;
      req = { ...req, headers: cleanHeaders };
    }

    // If we already have a payment session with this peer, skip negotiation.
    const needsPaymentNegotiation = this._buyerPaymentManager
      && !this._buyerLockedPeers.has(peer.peerId);

    // If an external spending auth was provided, apply it before sending the request.
    if (externalSpendingAuth && needsPaymentNegotiation) {
      debugLog(`[Node] Applying external spending auth for ${peer.peerId.slice(0, 12)}...`);
      await this._applyExternalSpendingAuth(peer, conn, externalSpendingAuth);
    }

    // Send per-request SpendingAuth for subsequent requests (after the initial
    // session was established). The first request is covered by the initial
    // SpendingAuth from _doNegotiatePayment; skip it here.
    const alreadyLocked = this._buyerLockedPeers.has(peer.peerId);
    if (alreadyLocked && this._buyerPaymentManager && !externalSpendingAuth) {
      if (this._buyerFirstRequestSent.has(peer.peerId)) {
        await this._sendPerRequestAuth(peer, conn);
      } else {
        // First request after session open — initial SpendingAuth already sent
        this._buyerFirstRequestSent.add(peer.peerId);
      }
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

    if (response.statusCode === 402 && needsPaymentNegotiation && !externalSpendingAuth) {
      const manualApproval = await this._isManualApprovalEnabled();
      const directPaymentBody = parsePaymentRequiredBody(response.body);
      const responseAlreadyHasRequirements = Boolean(directPaymentBody?.minBudgetPerRequest);
      const waitMs = manualApproval ? 10_000 : 2_000;
      const buffered = responseAlreadyHasRequirements
        ? null
        : await this._awaitPaymentRequired(peer.peerId, conn, waitMs);
      if (buffered) this._bufferedPaymentRequired.delete(peer.peerId);

      // Helper: return enriched 402 so the caller can show an approval / add-credits card
      const returnPaymentRequired = (reason: string): SerializedHttpResponse => {
        debugLog(`[Node] Got 402 from ${peer.peerId.slice(0, 12)}... — returning to caller (${reason})`);
        if (responseAlreadyHasRequirements) {
          return response;
        }
        if (buffered) {
          const enrichedBody = JSON.stringify({
            error: 'payment_required',
            peerId: peer.peerId,
            minBudgetPerRequest: buffered.minBudgetPerRequest,
            suggestedAmount: buffered.suggestedAmount,
          });
          return {
            ...response,
            headers: { ...response.headers, 'content-type': 'application/json' },
            body: new TextEncoder().encode(enrichedBody),
          };
        }
        return response;
      };

      // If manual approval is on, always return the 402 to the caller
      if (manualApproval) {
        return returnPaymentRequired(responseAlreadyHasRequirements ? 'manual approval (direct body)' : 'manual approval');
      }

      // Auto mode: check if we can actually pay before attempting negotiation
      if (!this._depositsClient || !this._identity || !this._buyerPaymentManager) {
        return returnPaymentRequired('no deposits configured');
      }

      // Check on-chain balance — if insufficient, return 402 instead of failing mid-negotiate
      try {
        const buyerAddr = this._identity.wallet.address;
        const balance = await this._depositsClient.getBuyerBalance(buyerAddr);
        if (balance.available <= 0n) {
          return returnPaymentRequired('insufficient credits');
        }
      } catch (err) {
        debugWarn(`[Node] Failed to check buyer balance: ${err instanceof Error ? err.message : err}`);
        // Fall through to negotiate — let it fail naturally if balance is truly insufficient
      }

      // Auto-negotiate: sign SpendingAuth internally and retry
      // Re-buffer the PaymentRequired so _doNegotiatePayment can consume it.
      // When the 402 body already contained requirements (responseAlreadyHasRequirements),
      // construct a PaymentRequiredPayload from the body so _doNegotiatePayment doesn't
      // need to wait for the PaymentMux frame (which may have already been lost).
      if (buffered) {
        this._bufferedPaymentRequired.set(peer.peerId, buffered);
      } else if (responseAlreadyHasRequirements && directPaymentBody) {
        const bodyRequirements: PaymentRequiredPayload = {
          minBudgetPerRequest: String(directPaymentBody.minBudgetPerRequest ?? '10000'),
          suggestedAmount: String(directPaymentBody.suggestedAmount ?? '100000'),
          requestId: req.requestId,
          ...(directPaymentBody.inputUsdPerMillion != null ? { inputUsdPerMillion: Number(directPaymentBody.inputUsdPerMillion) } : {}),
          ...(directPaymentBody.outputUsdPerMillion != null ? { outputUsdPerMillion: Number(directPaymentBody.outputUsdPerMillion) } : {}),
        };
        this._bufferedPaymentRequired.set(peer.peerId, bodyRequirements);
      }
      debugLog(`[Node] Got 402 from ${peer.peerId.slice(0, 12)}... — auto-negotiating payment`);
      try {
        await this._negotiatePayment(peer, conn);
        debugLog(`[Node] Payment negotiated with ${peer.peerId.slice(0, 12)}... — retrying request`);
        startTime = Date.now(); // Reset so latency reflects inference time, not negotiation
        return executeRequest();
      } catch (err) {
        this._buyerLockedPeers.delete(peer.peerId);
        throw err;
      }
    }

    // Store response byte counts for the BPM's bytes/4 cost verification.
    // inputBytes = request body length (buyer knows their prompt).
    // outputBytes = response body length (buyer observes the response).
    // The BPM handles overdraft control; node.ts just records the raw data.
    this._estimateCostFromResponse(peer, response);
    this._parseCostHeaders(peer.peerId, response);
    const existing = this._lastResponseCost.get(peer.peerId);
    if (existing) {
      this._lastResponseCost.set(peer.peerId, {
        ...existing,
        inputContent: req.body,
        outputContent: response.body,
        latencyMs: Date.now() - startTime,
      });
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
        this._bufferedPaymentRequired.delete(peerId);
        // Cancel any in-flight PaymentRequired wait so _doNegotiatePayment
        // fails immediately instead of blocking for 10s on a dead connection.
        const pendingPR = this._pendingPaymentRequired.get(peerId);
        if (pendingPR) {
          clearTimeout(pendingPR.timer);
          this._pendingPaymentRequired.delete(peerId);
          pendingPR.reject(new Error(`Peer ${peerId.slice(0, 12)}... disconnected during payment negotiation`));
        }
        // Don't delete _paymentNegotiationLocks here — the pending rejection
        // causes _doNegotiatePayment to throw, and its finally block owns cleanup.
        // Deleting here would race with a new negotiation started on reconnect.
        this._decoders.delete(peerId);
        // Clean up buyer-side per-request auth tracking on disconnect
        this._buyerLockedPeers.delete(peerId);
        this._buyerFirstRequestSent.delete(peerId);
        this._lastResponseCost.delete(peerId);
        this._buyerPaymentManager?.cleanupSession(peerId);
        // Handle buyer disconnect
        if (this._sellerPaymentManager) {
          this._sellerPaymentManager.onBuyerDisconnect(peerId);
        }
        void this._finalizeSession(peerId, "disconnect");
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
        ...(this._statsClient ? { statsClient: this._statsClient } : {}),
        ...(this._stakingClient ? { stakingClient: this._stakingClient, paymentsEnabled: true } : {}),
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
    if (payments?.enabled && payments.rpcUrl && payments.depositsAddress && payments.sessionsAddress && payments.usdcAddress) {
      const paymentsDir = join(dataDir, "payments");
      // Create shared SessionStore for both buyer and seller payment managers
      if (!this._sessionStore) {
        try {
          this._sessionStore = new SessionStore(paymentsDir);
          debugLog("[Node] SessionStore initialized (buyer)");
        } catch (err) {
          debugWarn(`[Node] SessionStore unavailable: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (this._sessionStore) {
        const buyerPaymentConfig: BuyerPaymentConfig = {
          rpcUrl: payments.rpcUrl,
          depositsContractAddress: payments.depositsAddress,
          sessionsContractAddress: payments.sessionsAddress,
          usdcAddress: payments.usdcAddress,
          identityRegistryAddress: payments.identityRegistryAddress ?? '',
          chainId: payments.chainId ?? 8453,
          defaultAuthDurationSecs: payments.defaultAuthDurationSecs ?? 900, // 15 min — seller must call reserve() promptly
          maxPerRequestUsdc: BigInt(payments.maxPerRequestUsdc ?? "500000"),  // $0.50 default — covers most LLM requests
          maxReserveAmountUsdc: BigInt(payments.maxReserveAmountUsdc ?? "5000000"),  // $5.00 default per session
          dataDir: paymentsDir,
        };
        this._buyerPaymentManager = new BuyerPaymentManager(identity, buyerPaymentConfig, this._sessionStore);
        debugLog(`[Node] Buyer payment manager initialized (wallet=${identity.wallet.address.slice(0, 10)}... chainId=${buyerPaymentConfig.chainId} deposits=${buyerPaymentConfig.depositsContractAddress.slice(0, 10)}...)`);
      }
    }

    debugLog(`[Node] Buyer ready — DHT running on port ${this._dht!.getPort()}`);
  }

  private _handleIncomingConnection(conn: PeerConnection): void {
    debugLog(`[Node] Incoming connection from ${conn.remotePeerId.slice(0, 12)}...`);
    const buyerPeerId = conn.remotePeerId;
    const mux = new ProxyMux(conn);

    // Create PaymentMux alongside ProxyMux (seller-side)
    const paymentMux = new PaymentMux(conn);
    if (this._sellerPaymentManager) {
      const spm = this._sellerPaymentManager;
      paymentMux.onSpendingAuth((payload) => {
        // handleSpendingAuth handles both initial (sends AuthAck) and subsequent
        // per-request auths (validates monotonic increase, no AuthAck).
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
      // No SellerPaymentManager — reject SpendingAuth to prevent
      // accepting payment claims without EIP-712 signature verification
      paymentMux.onSpendingAuth(() => {
        debugWarn(`[Node] SpendingAuth rejected — SellerPaymentManager not configured`);
      });
    }
    this._paymentMuxes.set(buyerPeerId, paymentMux);

    // Register the ProxyMux request handler that routes to providers
    mux.onProxyRequest(async (request: SerializedHttpRequest) => {
      debugLog(`[Node] Seller received request: ${request.method} ${request.path} (reqId=${request.requestId.slice(0, 8)})`);

      // Reject with 402 if no active payment session and sessions client is configured.
      // Also send PaymentRequired via PaymentMux so the buyer knows what to sign.
      const spmAuthorized = this._sellerPaymentManager?.hasSession(buyerPeerId) ?? false;
      if (this._sessionsClient && !spmAuthorized) {
        // Pass buyerPeerId so seller can suggest higher amount for returning buyers,
        // and include per-direction pricing from the first registered provider.
        const firstProvider = this._providers[0];
        const providerPricing = firstProvider?.pricing?.defaults;
        const requirements = this._sellerPaymentManager?.getPaymentRequirements(
          request.requestId, buyerPeerId, providerPricing,
        );
        if (requirements) {
          debugLog(`[Node] No payment session for ${buyerPeerId.slice(0, 12)}... — sending 402 + PaymentRequired`);
          const paymentBody = JSON.stringify({
            error: 'payment_required',
            minBudgetPerRequest: requirements.minBudgetPerRequest,
            suggestedAmount: requirements.suggestedAmount,
          });
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 402,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode(paymentBody),
          });
          paymentMux.sendPaymentRequired(requirements);
        } else {
          debugWarn(`[Node] No payment session — returning 402`);
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 402,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode(JSON.stringify({
              error: 'payment_required',
              message: 'Seller not ready, try again later',
            })),
          });
        }
        return;
      }

      // Check budget before routing — reject if buyer hasn't authorized enough
      if (this._sellerPaymentManager) {
        const session = this._sellerPaymentManager.getSessionByPeer(buyerPeerId);
        if (session) {
          const accepted = this._sellerPaymentManager.getAcceptedCumulative(session.sessionId);
          const spent = this._sellerPaymentManager.getCumulativeSpend(session.sessionId);
          if (accepted > 0n && spent >= accepted) {
            // Budget exhausted — no remaining authorized balance
            const reserveMax = this._sellerPaymentManager.getReserveMax(session.sessionId);
            if (reserveMax > 0n && accepted >= reserveMax) {
              // Truly exhausted (at reserve cap) — settle so buyer can start a new session
              debugLog(`[Node] Session fully exhausted for ${buyerPeerId.slice(0, 12)}... (spent=${spent} >= accepted=${accepted} >= reserveMax=${reserveMax}) — settling and returning 402`);
              void this._sellerPaymentManager.settleSession(buyerPeerId).catch((err) => {
                debugWarn(`[Node] Failed to settle exhausted session: ${err instanceof Error ? err.message : err}`);
              });
            } else {
              debugLog(`[Node] Budget exhausted for ${buyerPeerId.slice(0, 12)}... (spent=${spent} >= accepted=${accepted}) — returning 402, awaiting NeedAuth response`);
            }
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 402,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(JSON.stringify({ error: 'payment_required' })),
            });
            return;
          }
        }
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
          responseBody = response.body ?? new Uint8Array(0);
          debugLog(`[Node] Provider responded: status=${statusCode} (${Date.now() - startTime}ms, ${responseBody.length}b) bodyType=${typeof response.body} hasBody=${!!response.body}`);
          if (!streamedResponseStarted) {
            // Inject cost headers before sending response (non-streamed only)
            const responseToSend = this._injectCostHeaders(response, provider, request, buyerPeerId);
            mux.sendProxyResponse(responseToSend);
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
          responseBody,
        );

        // Inject cost headers and record spend for cumulative voucher model
        if (this._sellerPaymentManager?.hasSession(buyerPeerId)) {
          let usage = parseResponseUsage(responseBody);
          // Fall back to byte-based estimation when provider doesn't report usage
          if (usage.inputTokens === 0 && usage.outputTokens === 0) {
            usage = {
              inputTokens: Math.ceil(request.body.length / 4),
              outputTokens: Math.ceil(responseBody.length / 4),
            };
          }
          const costUsdc = computeCostUsdc(usage.inputTokens, usage.outputTokens, requestPricing);
          const session = this._sellerPaymentManager.getSessionByPeer(buyerPeerId);
          if (session) {
            this._sellerPaymentManager.recordSpend(session.sessionId, costUsdc);
            const cumulativeSpend = this._sellerPaymentManager.getCumulativeSpend(session.sessionId);
            debugLog(`[Node] Cost recorded: buyer=${buyerPeerId.slice(0, 12)}... cost=${costUsdc} cumulative=${cumulativeSpend} (in=${usage.inputTokens} out=${usage.outputTokens})`);

            // Check if remaining budget is running low; proactively request more auth
            const accepted = this._sellerPaymentManager.getAcceptedCumulative(session.sessionId);
            const remainingBudget = accepted - cumulativeSpend;
            const estimatedNextRequestCost = costUsdc > 0n ? costUsdc : 1n;
            if (remainingBudget < estimatedNextRequestCost) {
              // Ask for just enough to cover the next request, not 2x
              const requiredAmount = cumulativeSpend + estimatedNextRequestCost;
              debugLog(`[Node] Budget low for ${buyerPeerId.slice(0, 12)}... remaining=${remainingBudget} estimated=${estimatedNextRequestCost} — sending NeedAuth (required=${requiredAmount})`);
              paymentMux.sendNeedAuth({
                channelId: session.sessionId,
                requiredCumulativeAmount: requiredAmount.toString(),
                currentAcceptedCumulative: accepted.toString(),
                deposit: session.authMax ?? '0',
              });
            }
          }
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
  /** Fallback token estimation from byte lengths (~4 bytes per token). */
  private _estimateTokens(inputBytes: number, outputBytes: number): TokenCount {
    const inputTokens = Math.max(1, Math.round(inputBytes / 4));
    const outputTokens = Math.max(1, Math.round(outputBytes / 4));
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, method: 'content-length', confidence: 'low' };
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
    responseBody: Uint8Array,
  ): Promise<void> {
    if (!this._identity) return;

    const sellerPeerId = this._identity.peerId;
    const isSSE = request.headers["accept"]?.includes("text/event-stream") ?? false;

    // Use actual token counts from provider response when available,
    // falling back to byte-based estimation.
    const providerUsage = parseResponseUsage(responseBody);
    let tokens: TokenCount;
    if (providerUsage.inputTokens > 0 || providerUsage.outputTokens > 0) {
      const totalTokens = providerUsage.inputTokens + providerUsage.outputTokens;
      tokens = {
        inputTokens: providerUsage.inputTokens,
        outputTokens: providerUsage.outputTokens,
        totalTokens,
        method: 'provider-usage',
        confidence: 'high',
      };
      debugLog(`[Node] Metering: provider-usage tokens=${totalTokens} (in=${providerUsage.inputTokens} out=${providerUsage.outputTokens})`);
    } else {
      tokens = this._estimateTokens(inputBytes, outputBytes);
      debugLog(`[Node] Metering: estimated tokens=${tokens.totalTokens} from ${inputBytes}+${outputBytes} bytes`);
    }

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

    // Initialize DepositsClient
    if (payments.rpcUrl && payments.depositsAddress && payments.usdcAddress) {
      this._depositsClient = new DepositsClient({
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.depositsAddress,
        usdcAddress: payments.usdcAddress,
      });
      debugLog(`[Node] DepositsClient initialized (contract=${payments.depositsAddress.slice(0, 10)}...)`);
    }

    // Initialize SessionsClient
    if (payments.rpcUrl && payments.sessionsAddress) {
      this._sessionsClient = new SessionsClient({
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.sessionsAddress,
      });
      debugLog(`[Node] SessionsClient initialized (contract=${payments.sessionsAddress.slice(0, 10)}...)`);
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

    // Initialize StatsClient
    if (payments.rpcUrl && payments.statsAddress) {
      this._statsClient = new StatsClient({
        rpcUrl: payments.rpcUrl,
        contractAddress: payments.statsAddress,
      });
      debugLog(`[Node] StatsClient initialized (contract=${payments.statsAddress.slice(0, 10)}...)`);
    }

    // Initialize SessionStore for persistent payment sessions (shared instance)
    const paymentsDir = join(dataDir, "payments");
    if (!this._sessionStore) {
      try {
        this._sessionStore = new SessionStore(paymentsDir);
        debugLog("[Node] SessionStore initialized");
      } catch (err) {
        debugWarn(`[Node] SessionStore unavailable: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Initialize SellerPaymentManager for seller role
    if (this._config.role === 'seller' && this._identity && this._sessionStore &&
        payments.rpcUrl && payments.sessionsAddress) {
      const sellerConfig: SellerPaymentConfig = {
        rpcUrl: payments.rpcUrl,
        sessionsContractAddress: payments.sessionsAddress,
        chainId: payments.chainId ?? 8453,
        dataDir: paymentsDir,
        ...(payments.minBudgetPerRequest ? { minBudgetPerRequest: payments.minBudgetPerRequest } : {}),
      };
      this._sellerPaymentManager = new SellerPaymentManager(this._identity, sellerConfig, this._sessionStore);
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

    pmux.onAuthAck((payload) => {
      bpm.handleAuthAck(peerId, payload);
    });

    pmux.onNeedAuth((payload) => {
      void bpm.handleNeedAuth(peerId, payload, pmux);
    });

    pmux.onPaymentRequired((payload) => {
      const pending = this._pendingPaymentRequired.get(peerId);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingPaymentRequired.delete(peerId);
        pending.resolve(payload);
      } else {
        // Buffer: 402 and PaymentRequired can arrive in the same I/O tick,
        // before _doNegotiatePayment registers its listener.
        this._bufferedPaymentRequired.set(peerId, payload);
        debugLog(`[Node] PaymentRequired from ${peerId.slice(0, 12)}... buffered (listener not yet registered)`);
      }
    });

    return pmux;
  }

  /**
   * Wait for the seller's PaymentRequired message, sign a SpendingAuth with
   * the seller's real requirements, and wait for AuthAck.
   * Uses a per-peer mutex so concurrent requests wait for the first negotiation.
   */

  /** Read requireManualApproval from config.json so changes take effect without restart. */
  private async _isManualApprovalEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this._manualApprovalCache && now - this._manualApprovalCache.at < 5_000) {
      return this._manualApprovalCache.value;
    }

    try {
      const configPath = this._config.configPath
        ?? join(this._config.dataDir ?? join(homedir(), '.antseed'), 'config.json');
      const raw = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const buyer = parsed.buyer && typeof parsed.buyer === 'object' ? parsed.buyer as Record<string, unknown> : {};
      const value = Boolean(buyer.requireManualApproval);
      this._manualApprovalCache = { value, at: now };
      return value;
    } catch {
      const value = Boolean(this._config.requireManualApproval);
      this._manualApprovalCache = { value, at: now };
      return value;
    }
  }

  /**
   * Wait for the seller's PaymentRequired payload for a given peer.
   * Returns a buffered payload immediately when available, otherwise waits up to timeoutMs.
   */
  private async _awaitPaymentRequired(
    peerId: PeerId,
    conn: PeerConnection,
    timeoutMs: number,
  ): Promise<PaymentRequiredPayload | null> {
    const buffered = this._bufferedPaymentRequired.get(peerId);
    if (buffered) {
      return buffered;
    }

    // Ensure the buyer-side PaymentMux exists before waiting so incoming frames
    // are captured even when 402 and PaymentRequired arrive close together.
    this._getOrCreateBuyerPaymentMux(peerId, conn);

    return await new Promise<PaymentRequiredPayload | null>((resolve) => {
      const already = this._bufferedPaymentRequired.get(peerId);
      if (already) {
        resolve(already);
        return;
      }

      const existing = this._pendingPaymentRequired.get(peerId);
      if (existing) {
        const wrapper = {
          resolve: (payload: PaymentRequiredPayload) => {
            clearTimeout(existing.timer);
            clearTimeout(wrapper.timer);
            if (this._pendingPaymentRequired.get(peerId) === wrapper) {
              this._pendingPaymentRequired.delete(peerId);
            }
            existing.resolve(payload);
            resolve(payload);
          },
          reject: (err: Error) => {
            clearTimeout(existing.timer);
            clearTimeout(wrapper.timer);
            if (this._pendingPaymentRequired.get(peerId) === wrapper) {
              this._pendingPaymentRequired.delete(peerId);
            }
            existing.reject(err);
            resolve(null);
          },
          timer: setTimeout(() => {
            clearTimeout(existing.timer);
            if (this._pendingPaymentRequired.get(peerId) === wrapper) {
              this._pendingPaymentRequired.delete(peerId);
            }
            resolve(null);
          }, timeoutMs),
        };
        this._pendingPaymentRequired.set(peerId, wrapper);
        return;
      }

      const timer = setTimeout(() => {
        if (this._pendingPaymentRequired.get(peerId)?.timer === timer) {
          this._pendingPaymentRequired.delete(peerId);
        }
        resolve(null);
      }, timeoutMs);
      this._pendingPaymentRequired.set(peerId, {
        resolve: (payload) => {
          clearTimeout(timer);
          if (this._pendingPaymentRequired.get(peerId)?.timer === timer) {
            this._pendingPaymentRequired.delete(peerId);
          }
          resolve(payload);
        },
        reject: () => {
          clearTimeout(timer);
          if (this._pendingPaymentRequired.get(peerId)?.timer === timer) {
            this._pendingPaymentRequired.delete(peerId);
          }
          resolve(null);
        },
        timer,
      });
    });
  }

  /**
   * Apply a pre-signed SpendingAuth from the x-antseed-spending-auth header.
   * Sends it to the seller via PaymentMux and waits for AuthAck.
   */
  private async _applyExternalSpendingAuth(
    peer: PeerInfo,
    conn: PeerConnection,
    headerValue: string,
  ): Promise<void> {
    const pmux = this._getOrCreateBuyerPaymentMux(peer.peerId, conn);

    let payload: {
      channelId: string;
      cumulativeAmount: string;
      metadataHash: string;
      metadata: string;
      spendingAuthSig: string;
      reserveSalt?: string;
      reserveMaxAmount?: string;
      reserveDeadline?: number;
    };
    try {
      const decoded = Buffer.from(headerValue, 'base64').toString('utf-8');
      payload = JSON.parse(decoded);
    } catch {
      throw new Error('Invalid x-antseed-spending-auth header: failed to decode');
    }

    debugLog(`[Node] External SpendingAuth: channel=${payload.channelId.slice(0, 18)}... amount=${payload.cumulativeAmount}`);

    // Store session so handleAuthAck can find it
    if (this._sessionStore) {
      const reserveDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
      this._sessionStore.upsertSession({
        sessionId: payload.channelId,
        peerId: peer.peerId,
        role: 'buyer',
        sellerEvmAddr: peerIdToAddress(peer.peerId),
        buyerEvmAddr: this._identity?.wallet.address ?? '',
        nonce: 0,
        authMax: payload.cumulativeAmount,
        deadline: reserveDeadline,
        previousSessionId: '0x' + '0'.repeat(64),
        previousConsumption: '0',
        tokensDelivered: '0',
        requestCount: 0,
        reservedAt: Date.now(),
        settledAt: null,
        settledAmount: null,
        status: 'active',
        latestBuyerSig: null,
        latestSpendingAuthSig: null,
        latestMetadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Send the pre-signed SpendingAuth to the seller
    pmux.sendSpendingAuth(payload);
    debugLog(`[Node] External SpendingAuth sent to seller ${peer.peerId.slice(0, 12)}..., waiting for AuthAck...`);

    await this._waitForLockConfirmation(peer.peerId);
    debugLog(`[Node] AuthAck received from seller ${peer.peerId.slice(0, 12)}...`);
    this._buyerLockedPeers.add(peer.peerId);

    this.emit('payment:signed', {
      peerId: peer.peerId,
      sellerEvmAddr: peerIdToAddress(peer.peerId),
      amount: payload.cumulativeAmount,
    });
  }

  private async _negotiatePayment(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    // Per-peer mutex: if another request is already negotiating, wait for it
    const existing = this._paymentNegotiationLocks.get(peer.peerId);
    if (existing) {
      await existing;
      return;
    }

    const negotiation = this._doNegotiatePayment(peer, conn);
    this._paymentNegotiationLocks.set(peer.peerId, negotiation);
    try {
      await negotiation;
    } finally {
      this._paymentNegotiationLocks.delete(peer.peerId);
    }
  }

  private async _doNegotiatePayment(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    const bpm = this._buyerPaymentManager;
    if (!bpm) {
      throw new Error('Payment negotiation unavailable — no sessions contract configured');
    }

    // If already locked from a previous successful negotiation, skip
    if (this._buyerLockedPeers.has(peer.peerId)) return;

    const pmux = this._getOrCreateBuyerPaymentMux(peer.peerId, conn);

    // Check if PaymentRequired was already buffered (arrives in same I/O tick as 402)
    const buffered = this._bufferedPaymentRequired.get(peer.peerId);
    if (buffered) {
      this._bufferedPaymentRequired.delete(peer.peerId);
      debugLog(`[Node] Using buffered PaymentRequired from ${peer.peerId.slice(0, 12)}...`);
    }

    const PAYMENT_REQUIRED_TIMEOUT_MS = 10_000;
    const requirements = buffered ?? await new Promise<PaymentRequiredPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingPaymentRequired.delete(peer.peerId);
        reject(new Error(`PaymentRequired timeout from seller ${peer.peerId.slice(0, 12)}...`));
      }, PAYMENT_REQUIRED_TIMEOUT_MS);
      this._pendingPaymentRequired.set(peer.peerId, { resolve, reject, timer });
    });

    debugLog(`[Node] PaymentRequired from ${peer.peerId.slice(0, 12)}...: minBudgetPerRequest=${requirements.minBudgetPerRequest} suggested=${requirements.suggestedAmount}`);

    // Validate that seller's per-request minimum is within buyer's configured limit
    const minBudgetPerRequest = BigInt(requirements.minBudgetPerRequest);
    if (minBudgetPerRequest > bpm.maxPerRequestUsdc) {
      throw new Error(
        `Seller ${peer.peerId.slice(0, 12)}... minBudgetPerRequest=${minBudgetPerRequest} exceeds buyer maxPerRequestUsdc=${bpm.maxPerRequestUsdc}`,
      );
    }

    // Cap amount at buyer's maxReserveAmountUsdc
    let amount: bigint;
    try {
      amount = BigInt(requirements.suggestedAmount);
    } catch {
      throw new Error(`Invalid suggestedAmount from seller ${peer.peerId.slice(0, 12)}...: "${requirements.suggestedAmount}"`);
    }
    if (amount > bpm.maxReserveAmountUsdc) {
      amount = bpm.maxReserveAmountUsdc;
    }
    if (amount <= 0n) {
      throw new Error(`Invalid reserve amount for payment to ${peer.peerId.slice(0, 12)}...`);
    }

    const approvalInfo = {
      peerId: peer.peerId,
      sellerEvmAddr: peerIdToAddress(peer.peerId),
      minBudgetPerRequest: requirements.minBudgetPerRequest,
      suggestedAmount: amount.toString(),
    };

    this.emit('payment:required', approvalInfo);

    // Extract pricing from seller's PaymentRequired payload or peer metadata
    const pricing = (requirements.inputUsdPerMillion != null || requirements.outputUsdPerMillion != null)
      ? {
          inputUsdPerMillion: requirements.inputUsdPerMillion ?? peer.defaultInputUsdPerMillion ?? 0,
          outputUsdPerMillion: requirements.outputUsdPerMillion ?? peer.defaultOutputUsdPerMillion ?? 0,
        }
      : (peer.defaultInputUsdPerMillion != null || peer.defaultOutputUsdPerMillion != null)
        ? {
            inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
            outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
          }
        : undefined;

    try {
      await bpm.authorizeSpending(peer.peerId, pmux, minBudgetPerRequest, pricing);
      debugLog(`[Node] SpendingAuth sent to seller ${peer.peerId.slice(0, 12)}..., waiting for AuthAck...`);

      await this._waitForLockConfirmation(peer.peerId);
      debugLog(`[Node] AuthAck received from seller ${peer.peerId.slice(0, 12)}...`);
      this._buyerLockedPeers.add(peer.peerId);

      // Notify listeners what was signed
      this.emit('payment:signed', {
        peerId: peer.peerId,
        sellerEvmAddr: peerIdToAddress(peer.peerId),
        amount: amount.toString(),
      });
    } catch (err) {
      debugWarn(`[Node] Payment negotiation failed for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      throw err;
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
   * Clean up buyer payment sessions on shutdown.
   * Sessions are persisted in SessionStore and will be resumed on next connect.
   */
  private async _endAllBuyerSessions(): Promise<void> {
    const bpm = this._buyerPaymentManager;
    if (!bpm) return;
    // Sessions persist in SQLite; no explicit end needed.
    // The buyer will reference them as previousSession on next connect.
    debugLog(`[Node] Buyer sessions persisted for next reconnection`);
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

  /**
   * Inject cost headers into a non-streamed response before sending to buyer.
   */
  private _injectCostHeaders(
    response: SerializedHttpResponse,
    provider: Provider,
    request: SerializedHttpRequest,
    buyerPeerId: string,
  ): SerializedHttpResponse {
    const spm = this._sellerPaymentManager;
    if (!spm || !spm.hasSession(buyerPeerId)) return response;

    const usage = parseResponseUsage(response.body);
    const pricing = this._resolveProviderPricing(provider, request);
    const costUsdc = computeCostUsdc(usage.inputTokens, usage.outputTokens, pricing);
    const session = spm.getSessionByPeer(buyerPeerId);
    const cumulativeCost = session ? spm.getCumulativeSpend(session.sessionId) : 0n;

    return {
      requestId: response.requestId,
      statusCode: response.statusCode,
      body: response.body ?? new Uint8Array(0),
      headers: {
        ...response.headers,
        'x-antseed-input-tokens': String(usage.inputTokens),
        'x-antseed-output-tokens': String(usage.outputTokens),
        'x-antseed-cost': costUsdc.toString(),
        'x-antseed-cumulative-cost': cumulativeCost.toString(),
      },
    };
  }

  /**
   * Parse seller cost headers from a response and store them for per-request auth.
   */
  private _parseCostHeaders(peerId: string, response: SerializedHttpResponse): void {
    const costHeader = response.headers['x-antseed-cost'];
    if (!costHeader) return;

    try {
      // Preserve content and latency from the estimate if already set
      const existing = this._lastResponseCost.get(peerId);
      this._lastResponseCost.set(peerId, {
        costUsdc: BigInt(costHeader),
        inputTokens: BigInt(response.headers['x-antseed-input-tokens'] ?? '0'),
        outputTokens: BigInt(response.headers['x-antseed-output-tokens'] ?? '0'),
        cumulativeCost: BigInt(response.headers['x-antseed-cumulative-cost'] ?? '0'),
        inputContent: existing?.inputContent ?? new Uint8Array(0),
        outputContent: existing?.outputContent ?? response.body,
        latencyMs: existing?.latencyMs ?? 0,
      });
    } catch {
      // Ignore malformed headers
    }
  }

  /**
   * Estimate cost from response body when seller cost headers are missing
   * (e.g., streaming responses where _injectCostHeaders is not called).
   * Uses parseResponseUsage to extract token counts from the response body,
   * then computes cost using the peer's announced pricing.
   */
  private _estimateCostFromResponse(peer: PeerInfo, response: SerializedHttpResponse): void {
    const inputPricePerM = peer.defaultInputUsdPerMillion;
    const outputPricePerM = peer.defaultOutputUsdPerMillion;
    if (inputPricePerM == null && outputPricePerM == null) return;

    const usage = parseResponseUsage(response.body);
    // If no token counts found in the response body, fall back to byte-based estimate
    let inputTokens = usage.inputTokens;
    let outputTokens = usage.outputTokens;
    if (inputTokens === 0 && outputTokens === 0 && response.body.length > 0) {
      // Rough estimate: ~4 bytes per token for output
      outputTokens = Math.ceil(response.body.length / 4);
    }

    const pricing = {
      inputUsdPerMillion: inputPricePerM ?? 0,
      outputUsdPerMillion: outputPricePerM ?? 0,
    };
    const costUsdc = computeCostUsdc(inputTokens, outputTokens, pricing);

    this._lastResponseCost.set(peer.peerId, {
      costUsdc,
      inputTokens: BigInt(inputTokens),
      outputTokens: BigInt(outputTokens),
      cumulativeCost: 0n, // Unknown for estimated costs
      inputContent: new Uint8Array(0), // Placeholder — overwritten with req.body below
      outputContent: response.body,
      latencyMs: 0, // Placeholder — overwritten below
    });

    debugLog(
      `[Node] Estimated cost for ${peer.peerId.slice(0, 12)}...: ` +
      `cost=${costUsdc} (in=${inputTokens} out=${outputTokens}, estimated=${usage.inputTokens === 0 && usage.outputTokens === 0})`,
    );
  }

  /**
   * Sign and send a per-request SpendingAuth before sending the next request to a seller.
   */
  private async _sendPerRequestAuth(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    const bpm = this._buyerPaymentManager;
    if (!bpm) return;

    const pmux = this._getOrCreateBuyerPaymentMux(peer.peerId, conn);

    // Get raw content, seller-claimed cost, and latency from the previous response
    const lastCost = this._lastResponseCost.get(peer.peerId);
    const inputBytes = lastCost?.inputContent ?? 0;
    const outputBytes = lastCost?.outputContent ?? 0;
    const sellerClaimedCost = lastCost?.costUsdc;
    const latencyMs = lastCost?.latencyMs ?? 0;

    try {
      const { payload, topUpNeeded } = await bpm.signPerRequestAuth(
        peer.peerId,
        { inputBytes, outputBytes, sellerClaimedCost },
        latencyMs > 0 ? BigInt(latencyMs) : undefined,
      );
      pmux.sendSpendingAuth(payload);
      debugLog(`[Node] Per-request SpendingAuth sent to ${peer.peerId.slice(0, 12)}... cumulative=${payload.cumulativeAmount}`);

      if (topUpNeeded) {
        debugLog(`[Node] Reserve top-up needed for ${peer.peerId.slice(0, 12)}...`);
        await bpm.topUpReserve(peer.peerId, pmux);
      }
    } catch (err) {
      debugWarn(`[Node] Failed to send per-request SpendingAuth: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
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

import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Identity, IdentityStore } from "./p2p/identity.js";
import { loadOrCreateIdentity } from "./p2p/identity.js";
import type { PeerId } from "./types/peer.js";
import type { PeerInfo, TokenPricingUsdPerMillion } from "./types/peer.js";
import { peerIdToAddress } from "./types/peer.js";
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
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
  type SellerContractConfig,
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
  CHANNEL_STATUS,
} from "./payments/index.js";
import { debugLog, debugWarn } from "./utils/debug.js";
import { parsePublicAddress } from "./discovery/public-address.js";
import { BuyerPaymentManager, type BuyerPaymentConfig } from "./payments/buyer-payment-manager.js";
import { BuyerPaymentNegotiator } from "./payments/buyer-payment-negotiator.js";
import { SellerAddressResolver } from "./discovery/seller-address-resolver.js";
import { Contract as EthersContract } from "ethers";
import { SellerPaymentManager, type SellerPaymentConfig } from "./payments/seller-payment-manager.js";
import { IdentityClient } from "./payments/evm/identity-client.js";
import { SellerRequestHandler } from "./seller-request-handler.js";
import {
  BuyerRequestHandler,
  type RequestStreamCallbacks,
  type RequestStreamResponseMetadata,
  type RequestExecutionOptions,
} from "./buyer-request-handler.js";

export type { Provider, ProviderStreamCallbacks };
export type { Router };
export type { BuyerPaymentConfig };
export type { SellerSessionSnapshot };
export type { RequestStreamCallbacks, RequestStreamResponseMetadata, RequestExecutionOptions };

export interface NodePaymentsConfig {
  /** Enable seller-side payment channels and automatic settlement. */
  enabled?: boolean;
  /** Payment method used for settlement. Default: "crypto" */
  paymentMethod?: PaymentMethod;
  /** Platform fee rate in [0,1]. Default: 0.05 */
  platformFeeRate?: number;
  /** Idle time before calling settle() to collect earnings (channel stays open). Default: 10 min. */
  settlementIdleMs?: number;
  /** Idle time before calling close() to end the channel entirely. Default: 12 hours. */
  closeIdleMs?: number;
  /** Default deposit amount in USDC units. Default: "1" */
  defaultDepositAmountUSDC?: string;
  /** Optional seller wallet address for auto-funded deposit. */
  sellerWalletAddress?: string;
  /** Settlement backend configuration (crypto). */
  paymentConfig?: PaymentConfig | null;
  /** Base JSON-RPC URL (e.g. http://127.0.0.1:8545 for anvil) */
  rpcUrl?: string;
  /** Additional RPC endpoints for transparent failover via ethers FallbackProvider (quorum=1). */
  fallbackRpcUrls?: string[];
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
  /** Default maximum USDC per spending auth. Default: 500000 ($0.50) */
  defaultMaxAmountUsdc?: string;
  /** Default auth duration in seconds. Default: 90000 */
  defaultAuthDurationSecs?: number;
  /** Minimum USDC per request (base units) for seller. Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Minimum unsettled delta (base units) required before idle settle submits a tx. Default: "2000" (~$0.002). */
  minSettleDelta?: string;
  /** Maximum USDC the buyer authorizes per single request (base units). Default: "500000" ($0.50). */
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
  /** Override the DHT operation timeout in ms. Defaults to DEFAULT_DHT_CONFIG.operationTimeoutMs. */
  dhtOperationTimeoutMs?: number;
  /** Optional seller-side payment runtime wiring. */
  payments?: NodePaymentsConfig;
  /** Pluggable identity storage backend. When set, takes precedence over dataDir for identity loading. */
  identityStore?: IdentityStore;
  /** Optional explicit config.json path for runtime config reloads. */
  configPath?: string;
  /**
   * Optional on-chain seller contract (e.g. DiemStakingProxy). When set, the
   * announcer publishes it in metadata; buyers verify the binding by calling
   * `sellerContract.isOperator(peerAddress)`.
   */
  sellerContract?: SellerContractConfig;
}

export interface BuyerUsageChannelPoint {
  reservedAt: number;
  updatedAt: number;
  requestCount: number;
  inputTokens: string;
  outputTokens: string;
}

export interface BuyerUsageTotals {
  totalRequests: number;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalSettlements: number;
  uniqueSellers: number;
  activeChannels: number;
  channels: BuyerUsageChannelPoint[];
}

const EMPTY_BUYER_USAGE: BuyerUsageTotals = {
  totalRequests: 0,
  totalInputTokens: '0',
  totalOutputTokens: '0',
  totalSettlements: 0,
  uniqueSellers: 0,
  activeChannels: 0,
  channels: [],
};

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
  private _sellerAddressResolver: SellerAddressResolver | null = null;
  private _identityClient: IdentityClient | null = null;
  private _paymentMuxes = new Map<PeerId, PaymentMux>();
  /** Seller-side request handler (provider matching, execution, load tracking). */
  private _sellerHandler: SellerRequestHandler | null = null;
  /** Buyer-side payment manager (initialized when buyer has payment config). */
  private _buyerPaymentManager: BuyerPaymentManager | null = null;
  /** Buyer-side payment negotiation (402 handling, SpendingAuth, cost tracking). */
  private _buyerNegotiator: BuyerPaymentNegotiator | null = null;
  /** Buyer-side request execution (streaming, timeouts, 402 retry). */
  private _buyerHandler: BuyerRequestHandler | null = null;
  /** Seller-side payment manager (initialized when seller has payment config). */
  private _sellerPaymentManager: SellerPaymentManager | null = null;
  /** Shared channel store for payment persistence. */
  private _channelStore: ChannelStore | null = null;
  /** Periodic timeout checker interval. */
  private _timeoutCheckerInterval: ReturnType<typeof setInterval> | null = null;
  /** Block cursor for CloseRequested event polling. */
  private _closeRequestedFromBlock: number = 0;
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

    // Give in-transit NeedAuth messages time to arrive on the DataChannel,
    // then wait for their handlers to finish. This ensures the seller has a
    // valid SpendingAuth for settlement before we close the connection.
    if (this._buyerNegotiator) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      await this._buyerNegotiator.drainPendingNeedAuth();
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
    this._sellerAddressResolver = null;
    this._buyerPaymentManager = null;
    this._buyerNegotiator = null;
    this._buyerHandler = null;
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

    // Always enumerate via subnet+wildcard. Service filtering is metadata
    // driven — announcing per-service DHT topics did O(services) work per
    // reannounce cycle, recreated the K-closest saturation problem on every
    // popular service infohash, and was already an opportunistic optimisation
    // (the production proxy never used it; the CLI always re-filtered
    // metadata-side anyway). The signed metadata document carries the full
    // service catalog, so we filter against that after enumeration.
    const results = await this._peerLookup.findAll();
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

    const filtered = service ? peers.filter((p) => peerOffersService(p, service)) : peers;

    // On-chain enrichment runs after the metadata filter so we don't waste
    // RPC calls on peers we'll discard.
    await this._enrichPeersWithOnChainStats(filtered);

    for (const p of filtered) {
      debugLog(`[Node]   peer ${p.peerId.slice(0, 12)}... providers=[${p.providers.join(",")}] addr=${p.publicAddress ?? "?"}`);
    }
    return filtered;
  }

  /**
   * Look up a single peer by its peerId via the per-peer DHT topic.
   * Much cheaper and more deterministic than walking the wildcard topic:
   * one infohash lookup, return the first endpoint that serves matching
   * signed metadata. Falls back to wildcard discovery for compatibility with
   * old sellers that do not announce per-peer topics yet.
   * Returns `null` if the peer is not currently announcing
   * (or if its metadata is stale / signature-invalid).
   *
   * The returned `PeerInfo` is on-chain-enriched the same way `discoverPeers`
   * enriches its results, so volume / last-settled / ghost counts are
   * available when chain RPC is configured.
   */
  async findPeer(peerId: string): Promise<PeerInfo | null> {
    if (!this._peerLookup) {
      throw new Error("Node not started or not in buyer mode");
    }
    const normalized = peerId.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(normalized)) {
      return null;
    }

    debugLog(`[Node] findPeer(${normalized.slice(0, 12)}...) via per-peer DHT topic`);
    let results = await this._peerLookup.findByPeerId(normalized);
    if (results.length === 0) {
      debugLog(`[Node]   per-peer topic empty; falling back to wildcard scan`);
      results = (await this._peerLookup.findAll()).filter(
        (r) => r.metadata.peerId.toLowerCase() === normalized,
      );
      if (results.length === 0) {
        debugLog(`[Node]   wildcard fallback empty; not found`);
        return null;
      }
    }

    // Multiple endpoints can legitimately announce for the same peerId
    // (multi-homed seller). The lookup already filtered to those whose
    // served metadata matches the id; pick the freshest by timestamp.
    const best = results.reduce((acc, r) =>
      r.metadata.timestamp > acc.metadata.timestamp ? r : acc,
    );
    const peer = this._lookupResultToPeerInfo(best);
    await this._enrichPeersWithOnChainStats([peer]);
    return peer;
  }

  /**
   * Verify claimed on-chain stats against actual contract data, and
   * populate volume / last-settled which are never announced by sellers.
   *
   * Concurrency is capped so a wildcard DHT lookup returning hundreds of
   * peers doesn't fan out into hundreds of simultaneous eth_calls (resolver
   * isOperator + getAgentId + getAgentStats per peer). Most RPC endpoints
   * will rate-limit past ~10-20 concurrent calls; we stay well under that.
   *
   * Mutates the supplied peers in place. No-op when chain clients aren't
   * configured — callers can safely invoke this regardless.
   */
  private async _enrichPeersWithOnChainStats(peers: PeerInfo[]): Promise<void> {
    if (!this._channelsClient || !this._stakingClient || peers.length === 0) {
      return;
    }
    const channelsClient = this._channelsClient;
    const stakingClient = this._stakingClient;
    const resolver = this._sellerAddressResolver;
    const DISCOVERY_RPC_CONCURRENCY = 8;
    // Throttle on-chain reads across rapid discovery cycles. 60s is short
    // enough that freshness feels real-time in the UI, and long enough that
    // back-to-back `discoverPeers()` calls don't hammer the RPC endpoint.
    const ON_CHAIN_STATS_TTL_MS = 60_000;
    const nowMs = Date.now();
    const queue = peers.slice();
    const verifyOne = async (p: PeerInfo): Promise<void> => {
      if (
        typeof p.onChainStatsFetchedAt === 'number'
        && nowMs - p.onChainStatsFetchedAt < ON_CHAIN_STATS_TTL_MS
      ) {
        return;
      }
      try {
        const evmAddress = resolver
          ? await resolver.resolveSellerAddress(p.peerId, p.metadata)
          : peerIdToAddress(p.peerId);
        const agentId = await stakingClient.getAgentId(evmAddress);
        const stats = await channelsClient.getAgentStats(agentId);
        p.onChainChannelCount = stats.channelCount;
        p.onChainGhostCount = stats.ghostCount;
        // totalVolumeUsdc is base-6 USDC. Clamp to safe-int range before
        // narrowing to Number — ~9M USDC fits Number.MAX_SAFE_INTEGER.
        const volumeMicros = stats.totalVolumeUsdc;
        p.onChainTotalVolumeUsdcMicros = volumeMicros <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(volumeMicros)
          : Number.MAX_SAFE_INTEGER;
        p.onChainLastSettledAtSec = stats.lastSettledAt;
        p.onChainStatsFetchedAt = Date.now();
      } catch {
        // Per-peer verification failure — keep whatever seller metadata claimed
        // (channelCount/ghostCount); volume/lastSettled remain undefined.
      }
    };
    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < Math.min(DISCOVERY_RPC_CONCURRENCY, queue.length); i++) {
      workers.push((async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          await verifyOne(next);
        }
      })());
    }
    await Promise.all(workers);
  }

  /**
   * Eagerly open a connection to a peer and wire up the mux.
   * Subsequent sendRequest / sendRequestStream calls will reuse this connection.
   */
  async connectToPeer(peer: PeerInfo): Promise<void> {
    const conn = await this._getOrCreateConnection(peer);
    this._getOrCreateMux(peer.peerId, conn);
    const negotiator = this._buyerNegotiator;
    if (negotiator) {
      this._paymentMuxes.set(peer.peerId, negotiator.getOrCreatePaymentMux(peer.peerId, conn));
    }
  }

  /**
   * Query session stats for a specific seller peer.
   * Combines channel store data (authoritative payment/session info) with
   * metering events when available.
   */
  getMeteringStatsByPeer(sellerPeerId: string): {
    // Current session
    totalRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reservedUsdc: string | null;
    consumedUsdc: string | null;
    channelStatus: string | null;
    reservedAt: number | null;
    // Lifetime totals (across all sessions with this peer)
    lifetimeSessions: number;
    lifetimeRequests: number;
    lifetimeInputTokens: number;
    lifetimeOutputTokens: number;
    lifetimeTotalTokens: number;
    lifetimeAuthorizedUsdc: string;
    lifetimeFirstSessionAt: number | null;
    lifetimeLastSessionAt: number | null;
  } | null {
    const buyerAddress = this._identity?.wallet.address ?? null;
    const channel = (buyerAddress != null)
      ? (
        this._channelStore?.getActiveChannelByPeerAndBuyer(sellerPeerId, 'buyer', buyerAddress)
        ?? this._channelStore?.getLatestChannelByPeerAndBuyer(sellerPeerId, 'buyer', buyerAddress)
      )
      : (
        this._channelStore?.getActiveChannelByPeer(sellerPeerId, 'buyer')
        ?? this._channelStore?.getLatestChannel(sellerPeerId, 'buyer')
      )
      ?? null;

    const lifetime = (buyerAddress != null)
      ? this._channelStore?.getTotalsByPeerAndBuyer(sellerPeerId, 'buyer', buyerAddress)
      : this._channelStore?.getTotalsByPeer(sellerPeerId, 'buyer')
      ?? null;

    const liveTotals = this._buyerPaymentManager?.getResponseTokenTotals(sellerPeerId);
    const inputTokens = (liveTotals != null) ? liveTotals.input
      : (channel != null) ? Number(channel.tokensDelivered || '0')
      : 0;
    const outputTokens = (liveTotals != null) ? liveTotals.output
      : (channel != null) ? Number(channel.previousConsumption || '0')
      : 0;

    return {
      totalRequests: channel?.requestCount ?? 0,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      reservedUsdc: this._buyerPaymentManager?.getReserveCeiling(sellerPeerId)?.toString() ?? null,
      consumedUsdc: channel?.authMax ?? null,
      channelStatus: channel?.status ?? null,
      reservedAt: channel?.reservedAt ?? null,
      lifetimeSessions: lifetime?.totalSessions ?? 0,
      lifetimeRequests: lifetime?.totalRequests ?? 0,
      lifetimeInputTokens: lifetime?.totalInputTokens ?? 0,
      lifetimeOutputTokens: lifetime?.totalOutputTokens ?? 0,
      lifetimeTotalTokens: (lifetime?.totalInputTokens ?? 0) + (lifetime?.totalOutputTokens ?? 0),
      lifetimeAuthorizedUsdc: (lifetime?.totalAuthorizedUsdc ?? 0n).toString(),
      lifetimeFirstSessionAt: lifetime?.firstSessionAt ?? null,
      lifetimeLastSessionAt: lifetime?.lastSessionAt ?? null,
    };
  }

  /**
   * Return active buyer-side channels for the current identity's EVM address.
   * Combines the persistent ChannelStore (session metadata + cumulative signed
   * amount) with the in-memory reserve ceiling tracked by BuyerPaymentManager.
   *
   * Note on field semantics (buyer side, base-6 USDC strings):
   *   - reserveMax: current reserve ceiling — what the buyer authorized the
   *     seller to lock via ReserveAuth. Lives only in memory on the payment
   *     manager; falls back to stored authMax if unavailable.
   *   - cumulativeSigned (stored as authMax): rolling total of SpendingAuth
   *     amounts signed so far. Upper bound of what the seller can settle.
   */
  getActiveBuyerChannels(): Array<{
    channelId: string;
    peerId: string;
    seller: string;
    buyer: string;
    reserveMax: string;
    cumulativeSigned: string;
    deadline: number;
    reservedAt: number;
    status: string;
    requestCount: number;
    tokensDelivered: string;
  }> {
    const buyerAddress = this._identity?.wallet.address ?? null;
    if (!buyerAddress || !this._channelStore) return [];
    const stored = this._channelStore.getActiveChannelsByBuyer('buyer', buyerAddress);
    return stored.map((c) => {
      const liveReserve = this._buyerPaymentManager?.getReserveCeiling(c.peerId);
      const reserveMax = (liveReserve != null && liveReserve > 0n)
        ? liveReserve.toString()
        : c.authMax;
      return {
        channelId: c.sessionId,
        peerId: c.peerId,
        seller: c.sellerEvmAddr,
        buyer: c.buyerEvmAddr,
        reserveMax,
        cumulativeSigned: c.authMax,
        deadline: c.deadline,
        reservedAt: c.reservedAt,
        status: c.status,
        requestCount: c.requestCount,
        tokensDelivered: c.tokensDelivered,
      };
    });
  }

  /** All buyer channels (any local status), used for history views. */
  getAllBuyerChannels(): Array<{
    channelId: string;
    peerId: string;
    seller: string;
    buyer: string;
    reserveMax: string;
    cumulativeSigned: string;
    deadline: number;
    reservedAt: number;
    status: string;
    requestCount: number;
    tokensDelivered: string;
  }> {
    const buyerAddress = this._identity?.wallet.address ?? null;
    if (!buyerAddress || !this._channelStore) return [];
    const stored = this._channelStore.getAllChannelsByBuyer('buyer', buyerAddress);
    return stored.map((c) => ({
      channelId: c.sessionId,
      peerId: c.peerId,
      seller: c.sellerEvmAddr,
      buyer: c.buyerEvmAddr,
      reserveMax: c.authMax,
      cumulativeSigned: c.authMax,
      deadline: c.deadline,
      reservedAt: c.reservedAt,
      status: c.status,
      requestCount: c.requestCount,
      tokensDelivered: c.tokensDelivered,
    }));
  }

  /**
   * On buyer rows in payment_channels, `tokensDelivered` stores cumulative
   * input tokens and `previousConsumption` stores cumulative output tokens —
   * columns are semantically overloaded vs seller rows. Set in
   * buyer-payment-manager.recordAndPersistTokens.
   */
  getBuyerUsageTotals(): BuyerUsageTotals {
    const buyerAddress = this._identity?.wallet.address ?? null;
    if (!buyerAddress || !this._channelStore) return EMPTY_BUYER_USAGE;
    const stored = this._channelStore.getAllChannelsByBuyer('buyer', buyerAddress);
    let totalRequests = 0;
    let totalInput = 0n;
    let totalOutput = 0n;
    let totalSettlements = 0;
    let activeChannels = 0;
    const sellers = new Set<string>();
    const channels: BuyerUsageChannelPoint[] = [];
    for (const c of stored) {
      totalRequests += c.requestCount;
      try { totalInput += BigInt(c.tokensDelivered || '0'); } catch { /* skip */ }
      try { totalOutput += BigInt(c.previousConsumption || '0'); } catch { /* skip */ }
      if (c.status === CHANNEL_STATUS.SETTLED) totalSettlements += 1;
      if (c.status === CHANNEL_STATUS.ACTIVE) activeChannels += 1;
      if (c.peerId) sellers.add(c.peerId);
      channels.push({
        reservedAt: c.reservedAt,
        updatedAt: c.updatedAt,
        requestCount: c.requestCount,
        inputTokens: c.tokensDelivered || '0',
        outputTokens: c.previousConsumption || '0',
      });
    }
    return {
      totalRequests,
      totalInputTokens: totalInput.toString(),
      totalOutputTokens: totalOutput.toString(),
      totalSettlements,
      uniqueSellers: sellers.size,
      activeChannels,
      channels,
    };
  }

  async sendRequest(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    if (!this._buyerHandler) throw new Error("Node not started or not in buyer mode");
    return this._buyerHandler.sendRequest(peer, req, undefined, options);
  }

  async sendRequestStream(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    callbacks: RequestStreamCallbacks,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    if (!this._buyerHandler) throw new Error("Node not started or not in buyer mode");
    return this._buyerHandler.sendRequest(peer, req, callbacks, options);
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
      { settlementIdleMs: this._config.payments?.settlementIdleMs, closeIdleMs: this._config.payments?.closeIdleMs },
      {
        onSessionUpdated: (snapshot) => this.emit("session:updated", snapshot),
        onSessionFinalized: (info) => this.emit("session:finalized", info),
      },
    );

    await this._initializePayments(dataDir);

    // Wire idle session events to on-chain settlement
    if (this._sellerPaymentManager) {
      const spm = this._sellerPaymentManager;
      this.on("session:finalized", (info: { buyerPeerId: string; reason: string }) => {
        if (info.reason === "idle-settle") {
          debugLog(`[Node] Idle settle for buyer ${info.buyerPeerId.slice(0, 12)}... — settling channel (keeping open)`);
          void spm.settleSession(info.buyerPeerId, { settleOnly: true });
        } else if (info.reason === "idle-timeout") {
          debugLog(`[Node] Idle timeout for buyer ${info.buyerPeerId.slice(0, 12)}... — closing channel`);
          void spm.settleSession(info.buyerPeerId, { cleanupOnFailure: true });
        }
      });
    }

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
          pricing: {
            defaults: {
              inputUsdPerMillion: p.pricing.defaults.inputUsdPerMillion,
              outputUsdPerMillion: p.pricing.defaults.outputUsdPerMillion,
            },
            ...(p.pricing.services ? { services: { ...p.pricing.services } } : {}),
          },
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
        ...(this._config.sellerContract ? { sellerContract: this._config.sellerContract } : {}),
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
          ...(payments.fallbackRpcUrls ? { fallbackRpcUrls: payments.fallbackRpcUrls } : {}),
          depositsContractAddress: payments.depositsAddress,
          channelsContractAddress: payments.channelsAddress,
          usdcAddress: payments.usdcAddress,
          identityRegistryAddress: payments.identityRegistryAddress ?? '',
          chainId: payments.chainId ?? 8453,
          defaultAuthDurationSecs: payments.defaultAuthDurationSecs ?? 900, // 15 min — seller must call reserve() promptly
          maxPerRequestUsdc: BigInt(payments.maxPerRequestUsdc ?? "500000"),  // $0.50 default — covers most LLM requests
          maxReserveAmountUsdc: BigInt(payments.maxReserveAmountUsdc ?? "1000000"),  // $1.00 default per session (matches FIRST_SIGN_CAP)
          dataDir: paymentsDir,
        };
        this._buyerPaymentManager = new BuyerPaymentManager(identity, buyerPaymentConfig, this._channelStore, this._sellerAddressResolver ?? undefined);
        debugLog(`[Node] Buyer payment manager initialized (wallet=${identity.wallet.address.slice(0, 10)}... chainId=${buyerPaymentConfig.chainId} deposits=${buyerPaymentConfig.depositsContractAddress.slice(0, 10)}...)`);

        // Create negotiator that wraps the BPM with 402 handling and per-request auth
        this._buyerNegotiator = new BuyerPaymentNegotiator(
          identity,
          this._buyerPaymentManager,
          this._depositsClient,
          this._channelsClient,
          this._channelStore,
          {},
          this,
          this._sellerAddressResolver ?? undefined,
        );
        debugLog(`[Node] Buyer payment negotiator initialized`);
      }
    }

    // Create buyer request handler
    this._buyerHandler = new BuyerRequestHandler(
      {
        requestTimeoutMs: this._config.requestTimeoutMs,
        maxStreamBufferBytes: this._config.maxStreamBufferBytes,
        maxStreamDurationMs: this._config.maxStreamDurationMs,
      },
      {
        negotiator: this._buyerNegotiator,
        getConnection: (peer) => this._getOrCreateConnection(peer),
        getMux: (peerId, conn) => this._getOrCreateMux(peerId, conn),
        registerPaymentMux: (peerId, pmux) => this._paymentMuxes.set(peerId, pmux),
      },
    );

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

  private async _initializePayments(dataDir: string): Promise<void> {
    const payments = this._config.payments;
    if (!payments || !payments.enabled) {
      return;
    }

    const fallbackRpcUrls = payments.fallbackRpcUrls;

    // Initialize DepositsClient
    if (payments.rpcUrl && payments.depositsAddress && payments.usdcAddress) {
      this._depositsClient = new DepositsClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.depositsAddress,
        usdcAddress: payments.usdcAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
      });
      debugLog(`[Node] DepositsClient initialized (contract=${payments.depositsAddress.slice(0, 10)}...)`);
    }

    // Initialize ChannelsClient
    if (payments.rpcUrl && payments.channelsAddress) {
      this._channelsClient = new ChannelsClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.channelsAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
      });
      debugLog(`[Node] ChannelsClient initialized (contract=${payments.channelsAddress.slice(0, 10)}...)`);

      const channelsClientRef = this._channelsClient;
      const isOperatorAbi = ["function isOperator(address) view returns (bool)"];
      const SELLER_CONTRACTS_MAX = 256;
      const sellerContracts = new Map<string, EthersContract>();
      this._sellerAddressResolver = new SellerAddressResolver({
        isOperator: async (sellerContract: string, peerAddress: string) => {
          let contract = sellerContracts.get(sellerContract);
          if (contract) {
            sellerContracts.delete(sellerContract);
            sellerContracts.set(sellerContract, contract);
          } else {
            contract = new EthersContract(sellerContract, isOperatorAbi, channelsClientRef!.provider);
            if (sellerContracts.size >= SELLER_CONTRACTS_MAX) {
              const oldest = sellerContracts.keys().next().value;
              if (oldest !== undefined) sellerContracts.delete(oldest);
            }
            sellerContracts.set(sellerContract, contract);
          }
          return await contract.getFunction("isOperator")(peerAddress) as boolean;
        },
      });
      debugLog(`[Node] SellerAddressResolver initialized`);
    }

    // Initialize StakingClient
    if (payments.rpcUrl && payments.stakingAddress && payments.usdcAddress) {
      this._stakingClient = new StakingClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.stakingAddress,
        usdcAddress: payments.usdcAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
      });
      debugLog(`[Node] StakingClient initialized (contract=${payments.stakingAddress.slice(0, 10)}...)`);
    }

    // Initialize IdentityClient (ERC-8004 IdentityRegistry)
    if (payments.rpcUrl && payments.identityRegistryAddress) {
      this._identityClient = new IdentityClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.identityRegistryAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
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
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        channelsContractAddress: payments.channelsAddress,
        chainId: payments.chainId ?? 8453,
        dataDir: paymentsDir,
        ...(payments.minBudgetPerRequest ? { minBudgetPerRequest: payments.minBudgetPerRequest } : {}),
        ...(payments.minSettleDelta ? { minSettleDelta: payments.minSettleDelta } : {}),
      };
      this._sellerPaymentManager = new SellerPaymentManager(this._identity, sellerConfig, this._channelStore);
      debugLog(`[Node] SellerPaymentManager initialized`);

      // Startup recovery: validate hydrated channels against on-chain state, then check timeouts
      await this._sellerPaymentManager.validateHydratedChannels();
      await this._sellerPaymentManager.checkTimeouts();

      // Initialize CloseRequested polling cursor to current block
      try {
        this._closeRequestedFromBlock = await this._sellerPaymentManager.channelsClient.getBlockNumber();
      } catch {
        this._closeRequestedFromBlock = 0;
      }

      // Start periodic timeout checker + CloseRequested poller (every 60s)
      this._timeoutCheckerInterval = setInterval(() => {
        void this._sellerPaymentManager?.checkTimeouts();
        if (this._sellerPaymentManager) {
          void this._sellerPaymentManager.pollCloseRequested(this._closeRequestedFromBlock).then((nextBlock) => {
            this._closeRequestedFromBlock = nextBlock;
          });
        }
      }, 60_000);
      if (typeof (this._timeoutCheckerInterval as { unref?: () => void }).unref === "function") {
        (this._timeoutCheckerInterval as { unref: () => void }).unref();
      }
    }

    if (!this._metering) {
      // Metering storage is only initialized for sellers — buyers don't need it.
      if (this._config.role === 'seller') {
        debugWarn("[Node] Payments enabled but metering storage is unavailable; skipping balance manager wiring");
      }
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
      const provName = providerAnnouncement.provider;
      const serviceEntries: Record<string, TokenPricingUsdPerMillion> = {};
      for (const service of providerAnnouncement.services) {
        serviceEntries[service] =
          providerAnnouncement.servicePricing?.[service] ?? providerAnnouncement.defaultPricing;
      }

      const existing = providerPricingEntries[provName];
      if (existing) {
        // Merge services from duplicate provider names
        Object.assign(existing.services ?? {}, serviceEntries);
        if (!existing.services && Object.keys(serviceEntries).length > 0) {
          existing.services = serviceEntries;
        }
      } else {
        providerPricingEntries[provName] = {
          defaults: {
            inputUsdPerMillion: providerAnnouncement.defaultPricing.inputUsdPerMillion,
            outputUsdPerMillion: providerAnnouncement.defaultPricing.outputUsdPerMillion,
            ...(providerAnnouncement.defaultPricing.cachedInputUsdPerMillion != null
              ? { cachedInputUsdPerMillion: providerAnnouncement.defaultPricing.cachedInputUsdPerMillion }
              : {}),
          },
          ...(Object.keys(serviceEntries).length > 0 ? { services: serviceEntries } : {}),
        };
      }

      if (providerAnnouncement.serviceCategories && Object.keys(providerAnnouncement.serviceCategories).length > 0) {
        const existingCats = providerServiceCategoryEntries[provName];
        const newEntries = Object.fromEntries(
          Object.entries(providerAnnouncement.serviceCategories)
            .map(([service, categories]) => [service, [...categories]]),
        );
        if (existingCats) {
          Object.assign(existingCats.services, newEntries);
        } else {
          providerServiceCategoryEntries[provName] = { services: newEntries };
        }
      }

      if (providerAnnouncement.serviceApiProtocols && Object.keys(providerAnnouncement.serviceApiProtocols).length > 0) {
        const existingProtos = providerServiceApiProtocolEntries[provName];
        const newEntries = Object.fromEntries(
          Object.entries(providerAnnouncement.serviceApiProtocols)
            .map(([service, protocols]) => [service, [...protocols]]),
        );
        if (existingProtos) {
          Object.assign(existingProtos.services, newEntries);
        } else {
          providerServiceApiProtocolEntries[provName] = { services: newEntries };
        }
      }
    }

    const hasProviderPricing = Object.keys(providerPricingEntries).length > 0;
    const hasProviderServiceCategories = Object.keys(providerServiceCategoryEntries).length > 0;
    const hasProviderServiceApiProtocols = Object.keys(providerServiceApiProtocolEntries).length > 0;

    return {
      peerId: result.metadata.peerId,
      displayName: result.metadata.displayName,
      lastSeen: result.metadata.timestamp,
      metadata: result.metadata,
      providers,
      publicAddress: this._resolvePublicAddress(result),
      ...(hasProviderPricing ? { providerPricing: providerPricingEntries } : {}),
      ...(hasProviderServiceCategories ? { providerServiceCategories: providerServiceCategoryEntries } : {}),
      ...(hasProviderServiceApiProtocols ? { providerServiceApiProtocols: providerServiceApiProtocolEntries } : {}),
      defaultInputUsdPerMillion: firstProvider?.defaultPricing.inputUsdPerMillion,
      defaultOutputUsdPerMillion: firstProvider?.defaultPricing.outputUsdPerMillion,
      defaultCachedInputUsdPerMillion: firstProvider?.defaultPricing.cachedInputUsdPerMillion,
      maxConcurrency: firstProvider?.maxConcurrency,
      currentLoad: firstProvider?.currentLoad,
      // channelCount/ghostCount are taken from seller-announced metadata as a
      // starting value. `discoverPeers`' verifyOne then reads the contract
      // directly and overwrites these fields with the authoritative values
      // (and populates volume + lastSettled, which sellers never announce).
      onChainChannelCount: result.metadata.onChainChannelCount,
      onChainGhostCount: result.metadata.onChainGhostCount,
    };
  }

}

function parsePeerAddress(address: string): { host: string; port: number } {
  const parts = address.split(":");
  return { host: parts[0]!, port: parseInt(parts[1] ?? "6882", 10) };
}

/**
 * Predicate used by `discoverPeers(service)` to filter the enumerated peer
 * list against an optional service hint. Matches case-insensitively against
 * either a provider name (e.g. `openai`) or any service name announced in
 * the peer's signed metadata across all of its providers. Returns true when
 * `service` is empty/whitespace so the caller can skip the filter.
 */
function peerOffersService(peer: PeerInfo, service: string): boolean {
  const needle = service.trim().toLowerCase();
  if (needle.length === 0) return true;
  for (const provider of peer.providers) {
    if (provider.trim().toLowerCase() === needle) return true;
  }
  if (peer.providerPricing) {
    for (const entry of Object.values(peer.providerPricing)) {
      if (!entry.services) continue;
      for (const serviceName of Object.keys(entry.services)) {
        if (serviceName.trim().toLowerCase() === needle) return true;
      }
    }
  }
  return false;
}

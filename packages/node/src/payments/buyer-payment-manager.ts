import { randomBytes } from 'node:crypto';
import { type AbstractSigner } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  NeedAuthPayload,
} from '../types/protocol.js';
import { DepositsClient } from './evm/deposits-client.js';
import {
  signSpendingAuth,
  signReserveAuth,
  makeChannelsDomain,
  computeMetadataHash,
  encodeMetadata,
  ZERO_METADATA,
  ZERO_METADATA_HASH,
  computeChannelId,
} from './evm/signatures.js';
import type { SpendingAuthMessage, ReserveAuthMessage, SpendingAuthMetadata } from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { peerIdToAddress } from '../types/peer.js';
import { ChannelStore, type StoredChannel } from './channel-store.js';
import { estimateCostFromBytes, computeCostUsdc, type ServicePricing } from './pricing.js';

// ── Response cost header constants ───────────────────────────────
const HEADER_COST = 'x-antseed-cost';
const HEADER_INPUT_TOKENS = 'x-antseed-input-tokens';
const HEADER_OUTPUT_TOKENS = 'x-antseed-output-tokens';

/** Default tolerance: accept seller claims up to 1.4x buyer's bytes/4 estimate. */
const DEFAULT_COST_TOLERANCE = 1.4;
/** Fraction of reserve ceiling at which to signal a top-up is needed. */
/** Must match or exceed contract's TOP_UP_SETTLED_THRESHOLD_BPS (85%). */
const DEFAULT_TOPUP_THRESHOLD = 0.85;

export interface BuyerPaymentConfig {
  rpcUrl: string;
  depositsContractAddress: string;
  channelsContractAddress: string;
  usdcAddress: string;
  identityRegistryAddress: string;
  chainId: number;
  defaultAuthDurationSecs: number;
  /**
   * Max unverified exposure (overdraft limit) in USDC base units.
   * The buyer will never sign more than verifiedCost + maxPerRequestUsdc.
   * Default: 500000 ($0.50).
   */
  maxPerRequestUsdc: bigint;
  /** Max USDC to reserve per ReserveAuth signature (base units). Default: 1000000 ($1.00). */
  maxReserveAmountUsdc: bigint;
  /** Max ratio of seller-claimed cost to buyer's bytes/4 estimate. Default: 1.4. */
  costToleranceMultiplier?: number;
  dataDir: string;
}

/** Result of signPerRequestAuth — includes the payload and whether a reserve top-up is needed. */
export interface PerRequestAuthResult {
  payload: SpendingAuthPayload;
  topUpNeeded: boolean;
}

/**
 * Manages buyer-side payment sessions using EIP-712 SpendingAuth
 * with cumulative authorization, bytes/4 cost verification, and overdraft control.
 */
export class BuyerPaymentManager {
  private readonly _identity: Identity;
  private _signer: AbstractSigner;
  private readonly _depositsClient: DepositsClient;
  private readonly _config: BuyerPaymentConfig;
  private readonly _channelStore: ChannelStore;
  /** In-memory map of active confirmed sessions by seller peerId for fast lookups. */
  private readonly _confirmedPeers = new Set<string>();
  /** Peers that explicitly rejected our spending auth. */
  private readonly _rejectedPeers = new Set<string>();

  /** sellerPeerId -> cumulative USDC amount in the latest SpendingAuth */
  private readonly _cumulativeAmount = new Map<string, bigint>();

  /** sellerPeerId -> cumulative metadata for SpendingAuth */
  private readonly _metadata = new Map<string, SpendingAuthMetadata>();

  /** sellerPeerId -> buyer-verified cumulative cost from bytes/4 */
  private readonly _verifiedCost = new Map<string, bigint>();

  /** sellerPeerId -> full pricing map (defaults + per-service overrides from peer metadata / 402) */
  private readonly _sessionPricing = new Map<string, { defaults: ServicePricing; services: Record<string, ServicePricing> }>();

  /** Cumulative response token totals per seller, tracked independently of signing metadata. */
  private readonly _responseTokenTotals = new Map<string, { input: number; output: number; requests: number }>();

  /** sellerPeerId -> current on-chain reserve ceiling (can grow with top-ups) */
  private readonly _currentReserveCeiling = new Map<string, bigint>();

  /** sellerPeerId -> salt used in the current reserve */
  private readonly _reserveSalt = new Map<string, string>();

  /** Cached EIP-712 domain — static for the lifetime of this manager. */
  private readonly _channelsDomain: ReturnType<typeof makeChannelsDomain>;

  constructor(identity: Identity, config: BuyerPaymentConfig, channelStore: ChannelStore) {
    this._identity = identity;
    this._config = config;
    this._signer = identity.wallet;
    this._depositsClient = new DepositsClient({
      rpcUrl: config.rpcUrl,
      contractAddress: config.depositsContractAddress,
      usdcAddress: config.usdcAddress,
    });
    this._channelStore = channelStore;
    this._channelsDomain = makeChannelsDomain(config.chainId, config.channelsContractAddress);

    // Hydrate cumulative maps from persisted active sessions
    this._hydrateFromStore();
  }

  /** Hydrate cumulative tracking maps from persisted active buyer sessions. */
  private _hydrateFromStore(): void {
    const activeChannels = this._channelStore.getActiveChannelsByBuyer('buyer', this._identity.wallet.address);
    for (const channel of activeChannels) {
      const peerId = channel.peerId;
      this._cumulativeAmount.set(peerId, BigInt(channel.authMax));
      this._metadata.set(peerId, {
        cumulativeInputTokens: BigInt(channel.tokensDelivered),
        cumulativeOutputTokens: BigInt(channel.previousConsumption),
        cumulativeRequestCount: BigInt(channel.requestCount),
      });
      // verifiedCost and pricing are not persisted — start from 0 on hydration.
      // This is conservative: the buyer treats all previously-signed amounts as unverified.
    }
  }

  get signer(): AbstractSigner {
    return this._signer;
  }

  setSigner(signer: AbstractSigner): void {
    this._signer = signer;
  }

  get depositsClient(): DepositsClient {
    return this._depositsClient;
  }

  private get _costTolerance(): number {
    return this._config.costToleranceMultiplier ?? DEFAULT_COST_TOLERANCE;
  }

  private _getCeiling(sellerPeerId: string): bigint {
    return this._currentReserveCeiling.get(sellerPeerId) ?? this._config.maxReserveAmountUsdc;
  }

  /** Clean up all in-memory state for a seller when the session ends. */
  cleanupSession(sellerPeerId: string): void {
    this._cumulativeAmount.delete(sellerPeerId);
    this._metadata.delete(sellerPeerId);
    this._verifiedCost.delete(sellerPeerId);
    this._sessionPricing.delete(sellerPeerId);
    this._currentReserveCeiling.delete(sellerPeerId);
    this._reserveSalt.delete(sellerPeerId);
    this._confirmedPeers.delete(sellerPeerId);
    this._rejectedPeers.delete(sellerPeerId);
    this._responseTokenTotals.delete(sellerPeerId);
  }

  getActiveSession(sellerPeerId: string): StoredChannel | null {
    return this._channelStore.getActiveChannelByPeerAndBuyer(sellerPeerId, 'buyer', this._identity.wallet.address);
  }

  retireSession(
    sellerPeerId: string,
    status: Extract<StoredChannel['status'], 'settled' | 'timeout' | 'ghost'>,
    settledAmount?: bigint,
  ): void {
    const session = this.getActiveSession(sellerPeerId);
    if (session) {
      this._channelStore.updateChannelStatus(
        session.sessionId,
        status,
        settledAmount !== undefined ? settledAmount.toString() : undefined,
      );
    }
    this.cleanupSession(sellerPeerId);
  }

  canReplayReserveAuth(sellerPeerId: string): boolean {
    return this._reserveSalt.has(sellerPeerId);
  }

  async resendCurrentSpendingAuth(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<string> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      throw new Error(`[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}...`);
    }

    const cumulativeAmount = this._cumulativeAmount.get(sellerPeerId) ?? BigInt(session.authMax);
    const currentMeta = this._metadata.get(sellerPeerId) ?? ZERO_METADATA;
    const metadataHashHex = computeMetadataHash(currentMeta);
    const encodedMetadata = encodeMetadata(currentMeta);

    const metadataMsg: SpendingAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount,
      metadataHash: metadataHashHex,
    };
    const spendingAuthSig = await signSpendingAuth(this._signer, this._channelsDomain, metadataMsg);

    paymentMux.sendSpendingAuth({
      channelId: session.sessionId,
      cumulativeAmount: cumulativeAmount.toString(),
      metadataHash: metadataHashHex,
      metadata: encodedMetadata,
      spendingAuthSig,
    });

    return session.sessionId;
  }

  async resendReserveAuth(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<string> {
    const session = this.getActiveSession(sellerPeerId);
    const salt = this._reserveSalt.get(sellerPeerId);
    if (!session || !salt) {
      throw new Error(`[BuyerPayment] No replayable reserve for seller ${sellerPeerId.slice(0, 12)}...`);
    }

    // Force a fresh AuthAck after replaying the reserve path.
    this._confirmedPeers.delete(sellerPeerId);

    const maxAmount = this._currentReserveCeiling.get(sellerPeerId) ?? this._config.maxReserveAmountUsdc;
    const deadline = Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;
    const reserveMsg: ReserveAuthMessage = {
      channelId: session.sessionId,
      maxAmount,
      deadline: BigInt(deadline),
    };
    const reserveAuthSig = await signReserveAuth(this._signer, this._channelsDomain, reserveMsg);

    paymentMux.sendSpendingAuth({
      channelId: session.sessionId,
      cumulativeAmount: session.authMax,
      metadataHash: ZERO_METADATA_HASH,
      metadata: encodeMetadata(this._metadata.get(sellerPeerId) ?? ZERO_METADATA),
      spendingAuthSig: reserveAuthSig,
      reserveSalt: salt,
      reserveMaxAmount: maxAmount.toString(),
      reserveDeadline: deadline,
    });

    return session.sessionId;
  }

  // ── Spending Authorization ────────────────────────────────────

  /**
   * Sign and send an initial EIP-712 SpendingAuth to a seller.
   * The initial cumulativeAmount is set to the seller's minBudgetPerRequest.
   *
   * @param pricing Token pricing from the seller's 402 / peer metadata.
   * @param pricingMap Full pricing map (defaults + per-service) from peer metadata. If provided,
   *   merges with existing session pricing. The `pricing` arg is used as the service-specific
   *   override for the service that triggered the 402.
   */
  async authorizeSpending(
    sellerPeerId: string,
    paymentMux: PaymentMux,
    minBudgetPerRequest: bigint,
    reserveAmountOrPricing?: bigint | ServicePricing,
    pricingArg?: ServicePricing,
    pricingMap?: { defaults: ServicePricing; services: Record<string, ServicePricing> },
  ): Promise<string> {
    const sellerEvmAddr = peerIdToAddress(sellerPeerId);
    const reserveAmount = typeof reserveAmountOrPricing === 'bigint'
      ? reserveAmountOrPricing
      : this._config.maxReserveAmountUsdc;
    const pricing = typeof reserveAmountOrPricing === 'bigint'
      ? pricingArg
      : reserveAmountOrPricing;

    // Budget validation: reject if seller demands more than buyer's overdraft limit
    if (minBudgetPerRequest > this._config.maxPerRequestUsdc) {
      debugWarn(
        `[BuyerPayment] Seller ${sellerPeerId.slice(0, 12)}... minBudgetPerRequest=${minBudgetPerRequest} exceeds maxPerRequestUsdc=${this._config.maxPerRequestUsdc} — not authorizing`,
      );
      return '';
    }

    // Clear confirmation state so we wait for a fresh AuthAck on the new session
    this._confirmedPeers.delete(sellerPeerId);

    // Store full pricing map (defaults + all per-service overrides).
    // Merge 402-negotiated pricing on top of peer-metadata defaults so
    // the seller's live rate takes precedence over cached peer metadata.
    if (pricingMap) {
      const mergedDefaults = pricing
        ? { ...pricingMap.defaults, ...pricing }
        : pricingMap.defaults;
      this._sessionPricing.set(sellerPeerId, { defaults: mergedDefaults, services: pricingMap.services });
    } else if (pricing) {
      // Legacy: single pricing, store as defaults
      const existing = this._sessionPricing.get(sellerPeerId);
      this._sessionPricing.set(sellerPeerId, {
        defaults: pricing,
        services: existing?.services ?? {},
      });
    }

    // Generate random salt and compute deterministic channelId
    const salt = '0x' + randomBytes(32).toString('hex');
    const buyerEvmAddr = this._identity.wallet.address;
    const channelId = computeChannelId(buyerEvmAddr, sellerEvmAddr, salt);
    const deadline = Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;

    debugLog(`[BuyerPayment] authorizeSpending: channel=${channelId.slice(0, 18)}... seller=${sellerPeerId.slice(0, 12)}... amount=${minBudgetPerRequest}`);

    // Sign ReserveAuth — binds channelId, maxAmount, deadline on-chain
    const channelsDomain = this._channelsDomain;
    const maxAmount = reserveAmount;
    const reserveMsg: ReserveAuthMessage = {
      channelId,
      maxAmount,
      deadline: BigInt(deadline),
    };
    const reserveAuthSig = await signReserveAuth(this._signer, channelsDomain, reserveMsg);

    // Initialize state for this session
    this._cumulativeAmount.set(sellerPeerId, minBudgetPerRequest);
    this._metadata.set(sellerPeerId, { ...ZERO_METADATA });
    this._verifiedCost.set(sellerPeerId, 0n);
    this._currentReserveCeiling.set(sellerPeerId, maxAmount);
    this._reserveSalt.set(sellerPeerId, salt);

    // Store session
    const now = Date.now();
    const session: StoredChannel = {
      sessionId: channelId,
      peerId: sellerPeerId,
      role: 'buyer',
      sellerEvmAddr: peerIdToAddress(sellerPeerId),
      buyerEvmAddr: this._identity.wallet.address,
      nonce: 0,
      authMax: minBudgetPerRequest.toString(),
      deadline,
      previousSessionId: '0x' + '0'.repeat(64),
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: 'active',
      latestBuyerSig: null,
      latestSpendingAuthSig: null,
      latestMetadata: null,
      createdAt: now,
      updatedAt: now,
    };
    this._channelStore.upsertChannel(session);

    // Send SpendingAuth via PaymentMux — reserve carries ReserveAuth sig
    paymentMux.sendSpendingAuth({
      channelId,
      cumulativeAmount: minBudgetPerRequest.toString(),
      metadataHash: ZERO_METADATA_HASH,
      metadata: encodeMetadata(ZERO_METADATA),
      spendingAuthSig: reserveAuthSig,
      reserveSalt: salt,
      reserveMaxAmount: maxAmount.toString(),
      reserveDeadline: deadline,
    });

    return channelId;
  }

  // ── AuthAck handler ───────────────────────────────────────────

  handleAuthAck(sellerPeerId: string, payload: AuthAckPayload): void {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] AuthAck for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }
    if (session.sessionId !== payload.channelId) {
      debugWarn(`[BuyerPayment] AuthAck channel mismatch: expected=${session.sessionId.slice(0, 18)}... got=${payload.channelId.slice(0, 18)}...`);
      return;
    }

    this._confirmedPeers.add(sellerPeerId);
    debugLog(`[BuyerPayment] AuthAck confirmed: channel=${session.sessionId.slice(0, 18)}...`);
  }

  // ── Buyer-side cost verification ──────────────────────────────

  /**
   * Estimate tokens and cost from response content without updating state.
   */
  private _estimateResponseCost(
    sellerPeerId: string,
    inputBytes: Uint8Array,
    outputBytes: Uint8Array,
    service?: string,
  ): { cost: bigint; inputTokens: number; outputTokens: number } | null {
    const pricing = this.getSessionPricing(sellerPeerId, service);
    if (!pricing) return null;
    return estimateCostFromBytes(inputBytes, outputBytes, pricing);
  }

  /**
   * Accumulate a cost estimate into verifiedCost.
   */
  private _accumulateVerifiedCost(
    sellerPeerId: string,
    estimate: { cost: bigint; inputTokens: number; outputTokens: number },
  ): bigint {
    const prev = this._verifiedCost.get(sellerPeerId) ?? 0n;
    const newVerified = prev + estimate.cost;
    this._verifiedCost.set(sellerPeerId, newVerified);
    return newVerified;
  }

  /**
   * Record response content and update the buyer's verified cost.
   * Call this after receiving each response from the seller.
   *
   * NOTE: Do not call this AND signPerRequestAuth for the same response —
   * signPerRequestAuth already updates verifiedCost internally.
   *
   * @returns The updated verified cost and estimated tokens, or null if no pricing is available.
   */
  recordResponseBytes(
    sellerPeerId: string,
    inputBytes: Uint8Array,
    outputBytes: Uint8Array,
  ): { verifiedCost: bigint; inputTokens: number; outputTokens: number } | null {
    const estimate = this._estimateResponseCost(sellerPeerId, inputBytes, outputBytes);
    if (!estimate) return null;

    const newVerified = this._accumulateVerifiedCost(sellerPeerId, estimate);

    const inSize = inputBytes.length;
    const outSize = outputBytes.length;
    debugLog(
      `[BuyerPayment] recordResponseBytes: seller=${sellerPeerId.slice(0, 12)}... ` +
      `in=${inSize}B→${estimate.inputTokens}tok out=${outSize}B→${estimate.outputTokens}tok ` +
      `requestCost=${estimate.cost} verifiedCost=${newVerified}`,
    );

    return { verifiedCost: newVerified, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens };
  }

  // ── Per-request authorization (overdraft model) ─────────────

  /**
   * Compute the max signable cumulative amount based on the overdraft model:
   * maxSignable = verifiedCost + maxPerRequestUsdc, capped at reserve ceiling.
   */
  private _maxSignable(sellerPeerId: string): bigint {
    const verified = this._verifiedCost.get(sellerPeerId) ?? 0n;
    const ceiling = this._getCeiling(sellerPeerId);
    const maxSignable = verified + this._config.maxPerRequestUsdc;
    return maxSignable < ceiling ? maxSignable : ceiling;
  }

  /**
   * Check whether the current cumulative amount is approaching the reserve ceiling
   * and a top-up should be triggered.
   */
  private _needsTopUp(sellerPeerId: string): boolean {
    const ceiling = this._getCeiling(sellerPeerId);
    const current = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    const threshold = BigInt(Math.floor(Number(ceiling) * DEFAULT_TOPUP_THRESHOLD));
    return current >= threshold;
  }

  /**
   * Sign an updated SpendingAuth after receiving a response.
   *
   * The buyer uses the seller's claimed cost to advance the cumulative amount,
   * but validates it against the buyer's bytes/4 estimate. If the seller's claim
   * exceeds the buyer's estimate by more than the configured tolerance, the buyer
   * caps at tolerance * buyerEstimate. The cumulative is also capped at the
   * overdraft limit (verifiedCost + maxPerRequestUsdc) and the reserve ceiling.
   *
   * @param sellerPeerId Seller peer ID.
   * @param responseStats Byte counts from the last response and seller's claimed cost.
   * @returns The signed payload and whether a reserve top-up is needed.
   */
  async signPerRequestAuth(
    sellerPeerId: string,
    responseStats: {
      inputBytes: Uint8Array;
      outputBytes: Uint8Array;
      sellerClaimedCost?: bigint;
      reportedInputTokens?: bigint;
      reportedOutputTokens?: bigint;
      reportedCachedInputTokens?: bigint;
      service?: string;
    },
  ): Promise<PerRequestAuthResult> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      throw new Error(`[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}... — call authorizeSpending() first`);
    }

    // Prefer reported token counts (from seller headers or buyer's parsed response usage)
    // over byte-based estimation. Byte estimation inflates tokens due to JSON/SSE overhead.
    const hasReportedTokens = (responseStats.reportedInputTokens != null && responseStats.reportedInputTokens > 0n) ||
      (responseStats.reportedOutputTokens != null && responseStats.reportedOutputTokens > 0n);

    let estimatedInputTokens: bigint;
    let estimatedOutputTokens: bigint;
    let buyerEstimatedRequestCost: bigint;

    if (hasReportedTokens) {
      estimatedInputTokens = responseStats.reportedInputTokens ?? 0n;
      estimatedOutputTokens = responseStats.reportedOutputTokens ?? 0n;
      const cachedInputTokens = responseStats.reportedCachedInputTokens ?? 0n;
      // For cost estimation, split total input into fresh vs cached.
      // If cached tokens are reported, fresh = total - cached (OpenAI-style totals)
      // or fresh = total (Anthropic-style where total is already fresh-only).
      // Since the seller reports the split, trust the cached count and subtract.
      const freshInputTokens = cachedInputTokens > 0n
        ? BigInt(Math.max(0, Number(estimatedInputTokens) - Number(cachedInputTokens)))
        : estimatedInputTokens;
      // Compute cost from reported tokens using service-specific pricing
      const pricing = this.getSessionPricing(sellerPeerId, responseStats.service);
      if (pricing) {
        const cost = computeCostUsdc(Number(freshInputTokens), Number(estimatedOutputTokens), pricing, Number(cachedInputTokens));
        buyerEstimatedRequestCost = cost;
        this._accumulateVerifiedCost(sellerPeerId, { cost, inputTokens: Number(estimatedInputTokens), outputTokens: Number(estimatedOutputTokens) });
      } else {
        buyerEstimatedRequestCost = 0n;
      }
      debugLog(
        `[BuyerPayment] Using reported tokens: in=${estimatedInputTokens} cached=${cachedInputTokens} out=${estimatedOutputTokens} cost=${buyerEstimatedRequestCost}`,
      );
    } else {
      // Fall back to byte-based estimation
      const estimate = this._estimateResponseCost(sellerPeerId, responseStats.inputBytes, responseStats.outputBytes, responseStats.service);
      estimatedInputTokens = estimate ? BigInt(estimate.inputTokens) : 0n;
      estimatedOutputTokens = estimate ? BigInt(estimate.outputTokens) : 0n;
      buyerEstimatedRequestCost = estimate ? estimate.cost : 0n;
      if (estimate) {
        this._accumulateVerifiedCost(sellerPeerId, estimate);
      }
      debugLog(
        `[BuyerPayment] Byte-estimated tokens (no reported): in=${estimatedInputTokens} out=${estimatedOutputTokens} cost=${buyerEstimatedRequestCost}`,
      );
    }

    // Determine the accepted cost for this request:
    // When the seller reports a cost within tolerance, accept the seller's claim so the
    // buyer doesn't underpay due to minor parsing differences. Only cap when the seller's
    // claim exceeds the tolerance threshold.
    let acceptedCost: bigint;
    if (responseStats.sellerClaimedCost != null && responseStats.sellerClaimedCost > 0n) {
      if (buyerEstimatedRequestCost > 0n) {
        const maxAcceptable = BigInt(Math.ceil(Number(buyerEstimatedRequestCost) * this._costTolerance));
        if (responseStats.sellerClaimedCost > maxAcceptable) {
          debugWarn(
            `[BuyerPayment] Seller claimed ${responseStats.sellerClaimedCost} exceeds ${this._costTolerance}x buyer estimate ${buyerEstimatedRequestCost} — capping at ${maxAcceptable}`,
          );
          acceptedCost = maxAcceptable;
        } else {
          // Seller's claim is within tolerance — accept it as-is
          acceptedCost = responseStats.sellerClaimedCost;
        }
      } else {
        // No buyer estimate available — accept seller's claim
        acceptedCost = responseStats.sellerClaimedCost;
      }
    } else {
      acceptedCost = buyerEstimatedRequestCost;
    }
    // Minimum 1 base unit for monotonicity
    if (acceptedCost === 0n) acceptedCost = 1n;

    // Update cumulative metadata
    const prev = this._metadata.get(sellerPeerId) ?? ZERO_METADATA;
    const newMeta: SpendingAuthMetadata = {
      cumulativeInputTokens: prev.cumulativeInputTokens + estimatedInputTokens,
      cumulativeOutputTokens: prev.cumulativeOutputTokens + estimatedOutputTokens,
      cumulativeRequestCount: prev.cumulativeRequestCount + 1n,
    };
    this._metadata.set(sellerPeerId, newMeta);

    // Advance cumulative amount by the accepted cost, then add overdraft headroom
    // for the next request (so the seller has budget to serve it).
    // maxSignable already caps at reserve ceiling, so one cap is sufficient
    const prevAmount = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    const maxSignable = this._maxSignable(sellerPeerId);
    let newAmount = prevAmount + acceptedCost;
    if (newAmount > maxSignable) newAmount = maxSignable;
    // Ensure monotonic increase (at least +1 per request)
    if (newAmount <= prevAmount) newAmount = prevAmount + 1n;
    if (newAmount > maxSignable) newAmount = maxSignable;
    this._cumulativeAmount.set(sellerPeerId, newAmount);

    debugLog(
      `[BuyerPayment] signPerRequestAuth #${newMeta.cumulativeRequestCount}: ` +
      `thisReq in=${estimatedInputTokens} out=${estimatedOutputTokens} | ` +
      `cumulative in=${newMeta.cumulativeInputTokens} out=${newMeta.cumulativeOutputTokens} | ` +
      `acceptedCost=${acceptedCost} cumulativeAmount=${newAmount}`,
    );

    // Compute metadata hash and encode metadata
    const metadataHashHex = computeMetadataHash(newMeta);
    const encodedMetadata = encodeMetadata(newMeta);

    // Sign EIP-712 SpendingAuth
    const channelsDomain = this._channelsDomain;
    const metadataMsg: SpendingAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount: newAmount,
      metadataHash: metadataHashHex,
    };
    const spendingAuthSig = await signSpendingAuth(this._signer, channelsDomain, metadataMsg);

    // Persist updated cumulative values to ChannelStore
    this._channelStore.upsertChannel({
      ...session,
      authMax: newAmount.toString(),
      requestCount: Number(newMeta.cumulativeRequestCount),
      updatedAt: Date.now(),
    });

    const payload: SpendingAuthPayload = {
      channelId: session.sessionId,
      cumulativeAmount: newAmount.toString(),
      metadataHash: metadataHashHex,
      metadata: encodedMetadata,
      spendingAuthSig,
    };

    const topUpNeeded = this._needsTopUp(sellerPeerId);

    return { payload, topUpNeeded };
  }

  // ── NeedAuth handler ───────────────────────────────────────────

  /**
   * Handle seller-initiated NeedAuth messages when the seller's budget runs out mid-session.
   * Caps the signed amount at verifiedCost + maxPerRequestUsdc (overdraft model).
   */
  async handleNeedAuth(
    sellerPeerId: string,
    payload: NeedAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] NeedAuth for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    const requiredCumulativeAmount = BigInt(payload.requiredCumulativeAmount);
    const currentCumulative = this._cumulativeAmount.get(sellerPeerId) ?? 0n;

    // Reject stale/lower NeedAuth (monotonicity guard)
    if (requiredCumulativeAmount <= currentCumulative) {
      debugLog(
        `[BuyerPayment] NeedAuth stale: required=${requiredCumulativeAmount} <= current=${currentCumulative} — ignoring`,
      );
      return;
    }

    // Cap at overdraft limit: verifiedCost + maxPerRequestUsdc
    let maxSignable = this._maxSignable(sellerPeerId);
    const reserveCeiling = this._getCeiling(sellerPeerId);
    if (requiredCumulativeAmount > maxSignable && maxSignable >= reserveCeiling) {
      try {
        await this.topUpReserve(sellerPeerId, paymentMux);
      } catch (err) {
        debugWarn(`[BuyerPayment] NeedAuth: topUpReserve failed: ${err instanceof Error ? err.message : err}`);
      }
      maxSignable = this._maxSignable(sellerPeerId);
    }
    if (maxSignable <= currentCumulative) {
      debugWarn(
        `[BuyerPayment] NeedAuth: maxSignable=${maxSignable} <= currentCumulative=${currentCumulative} — cannot authorize more (overdraft limit reached)`,
      );
      return;
    }

    // Sign up to the lesser of what the seller asks and what we allow
    const effectiveAmount = requiredCumulativeAmount < maxSignable ? requiredCumulativeAmount : maxSignable;

    debugLog(`[BuyerPayment] NeedAuth: channel=${session.sessionId.slice(0, 18)}... required=${requiredCumulativeAmount} effective=${effectiveAmount}`);

    // Update cumulative amount
    this._cumulativeAmount.set(sellerPeerId, effectiveAmount);

    // Sign SpendingAuth with the effective amount and current metadata
    const currentMeta = this._metadata.get(sellerPeerId) ?? ZERO_METADATA;
    const metadataHashHex = computeMetadataHash(currentMeta);
    const encodedMetadata = encodeMetadata(currentMeta);

    const channelsDomain = this._channelsDomain;
    const metadataMsg: SpendingAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount: effectiveAmount,
      metadataHash: metadataHashHex,
    };
    const spendingAuthSig = await signSpendingAuth(this._signer, channelsDomain, metadataMsg);

    // Persist updated values
    this._channelStore.upsertChannel({
      ...session,
      authMax: effectiveAmount.toString(),
      updatedAt: Date.now(),
    });

    // Send via PaymentMux
    try {
      paymentMux.sendSpendingAuth({
        channelId: session.sessionId,
        cumulativeAmount: effectiveAmount.toString(),
        metadataHash: metadataHashHex,
        metadata: encodedMetadata,
        spendingAuthSig,
      });
      debugLog(`[BuyerPayment] NeedAuth responded: new cumulativeAmount=${effectiveAmount}`);
    } catch {
      debugLog(`[BuyerPayment] NeedAuth: connection closed before SpendingAuth could be sent`);
    }
  }

  // ── Reserve top-up ─────────────────────────────────────────────

  /**
   * Sign a new ReserveAuth with a higher maxAmount to extend the session's reserve ceiling.
   * The seller must call reserve() on-chain again with the new signature.
   * Note: requires contract support for top-up (increaseDeposit on existing channelId).
   */
  async topUpReserve(
    sellerPeerId: string,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] topUpReserve: no active session for ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    const prevCeiling = this._getCeiling(sellerPeerId);
    const newCeiling = prevCeiling + this._config.maxReserveAmountUsdc;
    const deadline = Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;

    debugLog(`[BuyerPayment] topUpReserve: channel=${session.sessionId.slice(0, 18)}... ceiling ${prevCeiling} → ${newCeiling}`);

    // Sign ReserveAuth with new maxAmount
    const channelsDomain = this._channelsDomain;
    const reserveMsg: ReserveAuthMessage = {
      channelId: session.sessionId,
      maxAmount: newCeiling,
      deadline: BigInt(deadline),
    };
    const reserveAuthSig = await signReserveAuth(this._signer, channelsDomain, reserveMsg);

    const currentCumulative = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    const currentMeta = this._metadata.get(sellerPeerId) ?? ZERO_METADATA;
    const metadataHashHex = computeMetadataHash(currentMeta);
    const encodedMetadata = encodeMetadata(currentMeta);

    const salt = this._reserveSalt.get(sellerPeerId) ?? '0x' + '00'.repeat(32);

    // Send ReserveAuth sig with reserve fields (same pattern as initial authorizeSpending).
    // The seller uses this to call topUp() on-chain with the new maxAmount.
    try {
      paymentMux.sendSpendingAuth({
        channelId: session.sessionId,
        cumulativeAmount: currentCumulative.toString(),
        metadataHash: metadataHashHex,
        metadata: encodedMetadata,
        spendingAuthSig: reserveAuthSig,
        reserveSalt: salt,
        reserveMaxAmount: newCeiling.toString(),
        reserveDeadline: deadline,
      });
      // Only commit the new ceiling after the message is delivered
      this._currentReserveCeiling.set(sellerPeerId, newCeiling);
      debugLog(`[BuyerPayment] topUpReserve sent: newCeiling=${newCeiling}`);
    } catch {
      debugLog(`[BuyerPayment] topUpReserve: connection closed before ReserveAuth could be sent`);
    }
  }

  // ── Queries ───────────────────────────────────────────────────

  /** Max USDC overdraft (unverified exposure) from buyer config. */
  get maxPerRequestUsdc(): bigint {
    return this._config.maxPerRequestUsdc;
  }

  /** Max USDC per ReserveAuth signature from buyer config. */
  get maxReserveAmountUsdc(): bigint {
    return this._config.maxReserveAmountUsdc;
  }

  /** Current buyer-verified cost for a seller. */
  getVerifiedCost(sellerPeerId: string): bigint {
    return this._verifiedCost.get(sellerPeerId) ?? 0n;
  }

  /** Current reserve ceiling for a seller (may be higher than initial after top-ups). */
  getReserveCeiling(sellerPeerId: string): bigint {
    return this._currentReserveCeiling.get(sellerPeerId) ?? this._config.maxReserveAmountUsdc;
  }

  /** Current cumulative signed amount for a seller. */
  getCumulativeAmount(sellerPeerId: string): bigint {
    return this._cumulativeAmount.get(sellerPeerId) ?? 0n;
  }

  /** Live cumulative token counts for a seller (in-memory, always up-to-date). */
  getCumulativeTokens(sellerPeerId: string): { inputTokens: bigint; outputTokens: bigint } {
    const meta = this._metadata.get(sellerPeerId) ?? ZERO_METADATA;
    return { inputTokens: meta.cumulativeInputTokens, outputTokens: meta.cumulativeOutputTokens };
  }

  /**
   * Accumulate response token counts and persist to the channel store.
   * Tracks its own running totals independently of signPerRequestAuth metadata,
   * so the persisted data is always up-to-date after each response.
   */
  recordAndPersistTokens(sellerPeerId: string, inputTokens: number, outputTokens: number): void {
    const session = this.getActiveSession(sellerPeerId);
    if (!session) return;

    const prev = this._responseTokenTotals.get(sellerPeerId) ?? { input: 0, output: 0, requests: 0 };
    debugLog(
      `[BuyerPayment] recordTokens: thisReq in=${inputTokens} out=${outputTokens} | ` +
      `prevTotal in=${prev.input} out=${prev.output} reqs=${prev.requests}`,
    );
    const totals = {
      input: prev.input + inputTokens,
      output: prev.output + outputTokens,
      requests: prev.requests + 1,
    };
    this._responseTokenTotals.set(sellerPeerId, totals);

    this._channelStore.upsertChannel({
      ...session,
      tokensDelivered: String(totals.input),
      previousConsumption: String(totals.output),
      requestCount: totals.requests,
      updatedAt: Date.now(),
    });
  }

  /** Get the live response token totals for a seller, or null if none recorded this session. */
  getResponseTokenTotals(sellerPeerId: string): { input: number; output: number; requests: number } | null {
    return this._responseTokenTotals.get(sellerPeerId) ?? null;
  }

  /** Get the session pricing for a seller+service. Resolves service-specific pricing first, then defaults. */
  getSessionPricing(sellerPeerId: string, service?: string): ServicePricing | null {
    const map = this._sessionPricing.get(sellerPeerId);
    if (!map) return null;
    if (service) {
      const servicePricing = map.services[service];
      if (servicePricing) return servicePricing;
    }
    return map.defaults;
  }

  /** Check if a session has been confirmed via AuthAck. */
  isAuthorized(sellerPeerId: string): boolean {
    return this._confirmedPeers.has(sellerPeerId);
  }

  /** Alias for isAuthorized (used by polling loop). */
  isLockConfirmed(sellerPeerId: string): boolean {
    return this.isAuthorized(sellerPeerId);
  }

  /** Check if the lock was explicitly rejected (not just never-contacted). */
  isLockRejected(sellerPeerId: string): boolean {
    return this._rejectedPeers.has(sellerPeerId);
  }

  /** Mark a peer as having rejected our spending auth. */
  markRejected(sellerPeerId: string): void {
    this._rejectedPeers.add(sellerPeerId);
    debugLog(`[BuyerPayment] Peer ${sellerPeerId.slice(0, 12)}... marked as rejected`);
  }

  getSessionHistory(sellerPeerId: string): StoredChannel[] {
    const session = this._channelStore.getLatestChannelByPeerAndBuyer(
      sellerPeerId,
      'buyer',
      this._identity.wallet.address,
    );
    return session ? [session] : [];
  }

  // ── Deposit operations ──────────────────────────────────────────

  async deposit(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Depositing ${amount} to deposits`);
    const buyer = this._identity.wallet.address;
    return this._depositsClient.deposit(this._signer, buyer, amount);
  }

  async withdraw(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Withdrawing ${amount} from deposits`);
    return this._depositsClient.withdraw(this._signer, this._identity.wallet.address, amount);
  }

  async getBalance(): Promise<{ available: bigint; reserved: bigint }> {
    const buyerAddr = this._identity.wallet.address;
    const info = await this._depositsClient.getBuyerBalance(buyerAddr);
    return { available: info.available, reserved: info.reserved };
  }

  // ── Response cost parsing ──────────────────────────────────────

  static parseResponseCost(
    headers: Record<string, string>,
  ): { cost: bigint; inputTokens: bigint; outputTokens: bigint } | null {
    const costStr = headers[HEADER_COST];
    if (costStr === undefined || costStr === '') return null;

    try {
      const cost = BigInt(costStr);

      const inputStr = headers[HEADER_INPUT_TOKENS];
      const inputTokens = inputStr !== undefined && inputStr !== '' ? BigInt(inputStr) : 0n;

      const outputStr = headers[HEADER_OUTPUT_TOKENS];
      const outputTokens = outputStr !== undefined && outputStr !== '' ? BigInt(outputStr) : 0n;

      return { cost, inputTokens, outputTokens };
    } catch {
      return null;
    }
  }
}

import type { Identity } from '../p2p/identity.js';
import type { PeerConnection } from '../p2p/connection-manager.js';
import { PaymentMux } from '../p2p/payment-mux.js';
import type { PeerInfo, PeerId } from '../types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import { PAYMENT_CODE_CHANNEL_EXHAUSTED, type PaymentRequiredPayload } from '../types/protocol.js';
import type { BuyerPaymentManager } from './buyer-payment-manager.js';
import type { DepositsClient } from './evm/deposits-client.js';
import type { ChannelsClient } from './evm/channels-client.js';
import type { ChannelStore } from './channel-store.js';
import { classifyOnChainChannel } from './channel-session-state.js';
import { peerIdToAddress } from '../types/peer.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import type { SellerAddressResolver } from '../discovery/seller-address-resolver.js';
import { SellerAuthorizationError } from '../discovery/seller-address-resolver.js';
import { parseResponseUsage } from '../utils/response-usage.js';
import { computeCostUsdc, type ServicePricing } from './pricing.js';
import { formatUsdc } from './usdc-utils.js';

export interface BuyerNegotiatorConfig {}

/** Emitter interface — subset of EventEmitter used by the negotiator. */
export interface NegotiationEmitter {
  emit(event: string, ...args: unknown[]): boolean;
}

/** Result of handling a 402 response. */
export type Handle402Result =
  | { action: 'return'; response: SerializedHttpResponse }
  | { action: 'retry' };

/** Per-peer cost tracking from the last response. */
interface LastResponseCost {
  costUsdc: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
  cumulativeCost: bigint;
  inputContent: Uint8Array;
  outputContent: Uint8Array;
  latencyMs: number;
  service?: string;
}

function parsePaymentRequiredBody(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Manages all buyer-side payment negotiation state and logic.
 *
 * Extracted from AntseedNode to separate buyer payment concerns
 * (402 handling, SpendingAuth negotiation, per-request auth, cost tracking)
 * from core node orchestration.
 */
export class BuyerPaymentNegotiator {
  private readonly _bpm: BuyerPaymentManager;
  private readonly _depositsClient: DepositsClient | null;
  private readonly _channelsClient: ChannelsClient | null;
  private readonly _channelStore: ChannelStore | null;
  private readonly _identity: Identity;
  private readonly _emit: NegotiationEmitter;
  private readonly _sellerAddressResolver?: SellerAddressResolver;

  /** Tracks which seller peers the buyer has already negotiated payment for. */
  private readonly _lockedPeers = new Set<string>();
  /** Pending PaymentRequired payloads from sellers, keyed by peerId. */
  private readonly _pendingPaymentRequired = new Map<string, {
    resolve: (payload: PaymentRequiredPayload) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** Buffered PaymentRequired that arrived before negotiation registered its listener. */
  private readonly _bufferedPaymentRequired = new Map<string, PaymentRequiredPayload>();
  /** Per-peer mutex to prevent concurrent payment negotiations. */
  private readonly _negotiationLocks = new Map<string, Promise<void>>();
  /** Peers that have sent their first request after session establishment. */
  private readonly _firstRequestSent = new Set<string>();
  /** Per-peer last response cost, raw content, and latency from the seller. */
  private readonly _lastResponseCost = new Map<string, LastResponseCost>();
  /** Buyer-side payment muxes keyed by seller peerId. */
  private readonly _muxes = new Map<PeerId, PaymentMux>();
  /** In-flight NeedAuth handlers keyed by seller peerId. */
  private readonly _pendingNeedAuth = new Map<string, Promise<void>>();

  constructor(
    identity: Identity,
    bpm: BuyerPaymentManager,
    depositsClient: DepositsClient | null,
    channelsClient: ChannelsClient | null,
    channelStore: ChannelStore | null,
    _config: BuyerNegotiatorConfig,
    emitter: NegotiationEmitter,
    sellerAddressResolver?: SellerAddressResolver,
  ) {
    this._identity = identity;
    this._bpm = bpm;
    this._depositsClient = depositsClient;
    this._channelsClient = channelsClient;
    this._channelStore = channelStore;
    this._emit = emitter;
    this._sellerAddressResolver = sellerAddressResolver;
  }

  get bpm(): BuyerPaymentManager {
    return this._bpm;
  }

  private async _resolveSellerAddr(peer: PeerInfo): Promise<string> {
    if (!this._sellerAddressResolver) return peerIdToAddress(peer.peerId);
    try {
      return await this._sellerAddressResolver.resolveSellerAddress(peer.peerId, peer.metadata);
    } catch (err) {
      if (err instanceof SellerAuthorizationError) {
        debugWarn(`[BuyerNegotiator] Dropping peer ${peer.peerId.slice(0, 12)}...: ${err.message}`);
      }
      throw err;
    }
  }

  getOrCreatePaymentMux(peerId: PeerId, conn: PeerConnection): PaymentMux {
    const existing = this._muxes.get(peerId);
    if (existing) return existing;

    const pmux = new PaymentMux(conn);
    this._muxes.set(peerId, pmux);

    pmux.onAuthAck((payload) => {
      this._bpm.handleAuthAck(peerId, payload);
    });

    pmux.onNeedAuth((payload) => {
      const p = this._bpm.handleNeedAuth(peerId, payload, pmux);
      this._pendingNeedAuth.set(peerId, p);
      p.finally(() => {
        if (this._pendingNeedAuth.get(peerId) === p) this._pendingNeedAuth.delete(peerId);
      });
    });

    pmux.onPaymentRequired((payload) => {
      const pending = this._pendingPaymentRequired.get(peerId);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingPaymentRequired.delete(peerId);
        pending.resolve(payload);
      } else {
        this._bufferedPaymentRequired.set(peerId, payload);
        debugLog(`[BuyerNegotiator] PaymentRequired from ${peerId.slice(0, 12)}... buffered`);
      }
    });

    return pmux;
  }

  getPaymentMux(peerId: PeerId): PaymentMux | undefined {
    return this._muxes.get(peerId);
  }

  // ── Pre-request auth ────────────────────────────────────────

  /**
   * If this peer has an active payment session, send a per-request SpendingAuth.
   * Handles first-request skip automatically (initial auth already sent during negotiation).
   * No-ops if the peer has no established session or if cost data was already
   * consumed by sendPostResponseAuth.
   */
  async preparePreRequestAuth(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    if (!this._lockedPeers.has(peer.peerId)) return;
    if (!this._firstRequestSent.has(peer.peerId)) {
      this._firstRequestSent.add(peer.peerId);
      return;
    }
    // Skip if cost data was already consumed by post-response auth
    if (!this._lastResponseCost.has(peer.peerId)) return;
    await this._sendPerRequestAuth(peer, conn);
  }

  /**
   * Send a SpendingAuth to the seller immediately after receiving a response.
   * This ensures the seller always has a valid SpendingAuth for close(),
   * even if the buyer disconnects before the next request.
   */
  async sendPostResponseAuth(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    if (!this._lockedPeers.has(peer.peerId)) return;
    if (!this._lastResponseCost.has(peer.peerId)) return;
    await this._sendPerRequestAuth(peer, conn);
  }

  private async _sendPerRequestAuth(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);

    const lastCost = this._lastResponseCost.get(peer.peerId);
    const inputBytes = lastCost?.inputContent ?? new Uint8Array(0);
    const outputBytes = lastCost?.outputContent ?? new Uint8Array(0);
    const sellerClaimedCost = lastCost?.costUsdc;
    const reportedInputTokens = lastCost?.inputTokens;
    const reportedOutputTokens = lastCost?.outputTokens;
    const reportedCachedInputTokens = lastCost?.cachedInputTokens;
    const service = lastCost?.service;
    try {
      const { payload, topUpNeeded } = await this._bpm.signPerRequestAuth(
        peer.peerId,
        { inputBytes, outputBytes, sellerClaimedCost, reportedInputTokens, reportedOutputTokens, reportedCachedInputTokens, service },
      );
      pmux.sendSpendingAuth(payload);
      // Release held content to free memory — no longer needed after signing
      this._lastResponseCost.delete(peer.peerId);
      debugLog(`[BuyerNegotiator] Per-request SpendingAuth sent to ${peer.peerId.slice(0, 12)}... cumulative=${payload.cumulativeAmount}`);

      if (topUpNeeded) {
        debugLog(`[BuyerNegotiator] Reserve top-up needed for ${peer.peerId.slice(0, 12)}...`);
        await this._bpm.topUpReserve(peer.peerId, pmux);
      }
    } catch (err) {
      debugWarn(`[BuyerNegotiator] Failed to send per-request SpendingAuth: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  async handle402(
    response: SerializedHttpResponse,
    peer: PeerInfo,
    conn: PeerConnection,
    req: SerializedHttpRequest,
  ): Promise<Handle402Result> {
    const hadLockedSession = this._lockedPeers.has(peer.peerId);
    const directPaymentBody = parsePaymentRequiredBody(response.body);
    const responseAlreadyHasRequirements = Boolean(directPaymentBody?.minBudgetPerRequest);
    const waitMs = 2_000;
    const buffered = responseAlreadyHasRequirements
      ? null
      : await this._awaitPaymentRequired(peer.peerId, conn, waitMs);
    if (buffered) this._bufferedPaymentRequired.delete(peer.peerId);

    // Stable machine-readable codes for the 402 body. Kept deliberately small
    // so callers (desktop UI, other SDK consumers) can switch on them without
    // being coupled to internal debug strings.
    type PaymentRequiredCode = 'insufficient_deposits';
    const returnPaymentRequired = (code: PaymentRequiredCode, debugReason: string): Handle402Result => {
      debugLog(`[BuyerNegotiator] Got 402 from ${peer.peerId.slice(0, 12)}... — returning to caller (${debugReason})`);
      // Always return a normalized buyer-authored body so the desktop UI can
      // render a proper "top up your deposits" CTA instead of the raw seller
      // 402 JSON (which leaks internal fields like requiredCumulativeAmount,
      // currentSpent, and per-service pricing).
      const req = buffered
        ?? (responseAlreadyHasRequirements && directPaymentBody != null
          ? {
            minBudgetPerRequest: directPaymentBody.minBudgetPerRequest != null
              ? String(directPaymentBody.minBudgetPerRequest)
              : undefined,
            suggestedAmount: directPaymentBody.suggestedAmount != null
              ? String(directPaymentBody.suggestedAmount)
              : undefined,
          }
          : null);
      const enrichedBody = JSON.stringify({
        error: 'payment_required',
        code,
        peerId: peer.peerId,
        ...(req?.minBudgetPerRequest != null ? { minBudgetPerRequest: req.minBudgetPerRequest } : {}),
        ...(req?.suggestedAmount != null ? { suggestedAmount: req.suggestedAmount } : {}),
        message: 'Deposits are insufficient to open a payment channel with this peer. Top up with "antseed buyer deposit <amount>" and retry.',
      });
      return {
        action: 'return',
        response: {
          ...response,
          headers: { ...response.headers, 'content-type': 'application/json' },
          body: new TextEncoder().encode(enrichedBody),
        },
      };
    };

    const returnNegotiationFailure = (reason: string, message: string, statusCode = 409): Handle402Result => {
      debugWarn(
        `[BuyerNegotiator] Auto-negotiation failed for ${peer.peerId.slice(0, 12)}... — ` +
        `${reason}; returning non-payment error to caller`,
      );
      return {
        action: 'return',
        response: {
          ...response,
          statusCode,
          headers: { ...response.headers, 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({
            error: 'payment_negotiation_failed',
            reason,
            message,
          })),
        },
      };
    };

    // Reconcile any active stored session before opening a fresh reserve.
    const existingSessionBudgetRequest = buffered
      ? BigInt(buffered.minBudgetPerRequest)
      : responseAlreadyHasRequirements && directPaymentBody?.minBudgetPerRequest != null
        ? BigInt(String(directPaymentBody.minBudgetPerRequest))
        : null;

    // Absolute cumulative target the seller needs us to sign to unblock the
    // channel (sent by the seller in the budget-exhausted branch). When
    // present we pass it through to extendCurrentSpendingAuth so the buyer
    // catches up in one step instead of creeping by minBudgetPerRequest and
    // repeatedly being rejected as underfunded.
    const requiredCumulativeTarget = buffered?.requiredCumulativeAmount != null
      ? safeBigInt(buffered.requiredCumulativeAmount)
      : responseAlreadyHasRequirements && directPaymentBody?.requiredCumulativeAmount != null
        ? safeBigInt(String(directPaymentBody.requiredCumulativeAmount))
        : null;

    // On-chain reserve ceiling the seller is willing to accept. Used to detect
    // permanently exhausted channels (where requiredCumulativeAmount > reserveMaxAmount)
    // so the buyer doesn't loop signing higher cumulatives the seller will reject.
    const sellerReserveMax = buffered?.reserveMaxAmount != null
      ? safeBigInt(buffered.reserveMaxAmount)
      : responseAlreadyHasRequirements && directPaymentBody?.reserveMaxAmount != null
        ? safeBigInt(String(directPaymentBody.reserveMaxAmount))
        : null;
    const channelExhausted = buffered?.code === PAYMENT_CODE_CHANNEL_EXHAUSTED
      || (responseAlreadyHasRequirements && directPaymentBody?.code === PAYMENT_CODE_CHANNEL_EXHAUSTED)
      || (requiredCumulativeTarget != null && sellerReserveMax != null && requiredCumulativeTarget > sellerReserveMax);

    const hasActiveSession = hadLockedSession || this._bpm.getActiveSession(peer.peerId) != null;

    if (channelExhausted && hasActiveSession) {
      debugLog(
        `[BuyerNegotiator] Channel exhausted for ${peer.peerId.slice(0, 12)}... ` +
        `(required=${requiredCumulativeTarget ?? 'n/a'} > reserveMax=${sellerReserveMax ?? 'n/a'}) — ` +
        `retiring session and renegotiating a fresh reserve`,
      );
      // 'ghost' rather than 'settled' — buyer hasn't observed the on-chain
      // settle land. Matches the other buyer-side give-up-locally callsites.
      this._bpm.retireSession(peer.peerId, 'ghost');
      this._lockedPeers.delete(peer.peerId);
      this._firstRequestSent.delete(peer.peerId);
    } else if (hasActiveSession) {
      const recovered = await this._recoverExistingSession(
        peer,
        conn,
        existingSessionBudgetRequest,
        requiredCumulativeTarget,
      );
      if (recovered) {
        return { action: 'retry' };
      }

      if (this._bpm.getActiveSession(peer.peerId)) {
        if (await this._canRetireStaleSessionWithoutOnChainProof()) {
          this._bpm.retireSession(peer.peerId, 'ghost');
        }
      }

      if (this._bpm.getActiveSession(peer.peerId)) {
        return returnNegotiationFailure(
          'existing_channel_still_active',
          'An existing payment channel could not be recovered automatically. Close or recover the channel and retry.',
        );
      }

      this._lockedPeers.delete(peer.peerId);
      this._firstRequestSent.delete(peer.peerId);
    }

    // Check if we can pay before attempting negotiation
    if (!this._depositsClient) {
      return returnNegotiationFailure(
        'deposits_not_configured',
        'Buyer deposits are not configured, so automatic payment negotiation is unavailable.',
        503,
      );
    }

    // Check on-chain balance
    try {
      const buyerAddr = this._identity.wallet.address;
      const balance = await this._depositsClient.getBuyerBalance(buyerAddr);
      if (balance.available <= 0n) {
        return returnPaymentRequired('insufficient_deposits', 'buyer deposits balance is zero');
      }
    } catch (err) {
      debugWarn(`[BuyerNegotiator] Failed to check buyer balance: ${err instanceof Error ? err.message : err}`);
    }

    // Re-buffer the PaymentRequired so _doNegotiatePayment can consume it
    if (buffered) {
      this._bufferedPaymentRequired.set(peer.peerId, buffered);
    } else if (responseAlreadyHasRequirements && directPaymentBody) {
      const bodyRequirements: PaymentRequiredPayload = {
        minBudgetPerRequest: String(directPaymentBody.minBudgetPerRequest ?? '10000'),
        suggestedAmount: String(directPaymentBody.suggestedAmount ?? '100000'),
        requestId: req.requestId,
        ...(directPaymentBody.inputUsdPerMillion != null ? { inputUsdPerMillion: Number(directPaymentBody.inputUsdPerMillion) } : {}),
        ...(directPaymentBody.outputUsdPerMillion != null ? { outputUsdPerMillion: Number(directPaymentBody.outputUsdPerMillion) } : {}),
        ...(directPaymentBody.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: Number(directPaymentBody.cachedInputUsdPerMillion) } : {}),
      };
      this._bufferedPaymentRequired.set(peer.peerId, bodyRequirements);
    }

    debugLog(`[BuyerNegotiator] Got 402 from ${peer.peerId.slice(0, 12)}... — auto-negotiating payment`);
    try {
      await this._negotiatePayment(peer, conn);
      debugLog(`[BuyerNegotiator] Payment negotiated with ${peer.peerId.slice(0, 12)}...`);
      return { action: 'retry' };
    } catch (err) {
      this._lockedPeers.delete(peer.peerId);
      throw err;
    }
  }

  estimateCostFromResponse(peer: PeerInfo, response: SerializedHttpResponse, service?: string): void {
    // Prefer session pricing (from PaymentRequired negotiation, includes service-specific rates)
    // over peer-level defaults which may be different from the actual service pricing.
    const sessionPricing = this._bpm.getSessionPricing(peer.peerId, service);
    const inputPricePerM = sessionPricing?.inputUsdPerMillion ?? peer.defaultInputUsdPerMillion;
    const outputPricePerM = sessionPricing?.outputUsdPerMillion ?? peer.defaultOutputUsdPerMillion;
    if (inputPricePerM == null && outputPricePerM == null) return;

    const usage = parseResponseUsage(response.body);
    // Don't estimate from body bytes — seller cost headers are authoritative.
    // The old body.length/4 fallback wildly inflated costs for SSE streaming responses.

    const pricing = {
      inputUsdPerMillion: inputPricePerM ?? 0,
      outputUsdPerMillion: outputPricePerM ?? 0,
      cachedInputUsdPerMillion: sessionPricing?.cachedInputUsdPerMillion,
    };
    const costUsdc = computeCostUsdc(usage.freshInputTokens, usage.outputTokens, pricing, usage.cachedInputTokens);

    this._lastResponseCost.set(peer.peerId, {
      costUsdc,
      inputTokens: BigInt(usage.inputTokens),
      outputTokens: BigInt(usage.outputTokens),
      cachedInputTokens: BigInt(usage.cachedInputTokens),
      cumulativeCost: 0n,
      inputContent: new Uint8Array(0),
      outputContent: response.body,
      latencyMs: 0,
      service,
    });

    debugLog(
      `[BuyerNegotiator] Estimated cost for ${peer.peerId.slice(0, 12)}...: ` +
      `cost=${costUsdc} (in=${usage.freshInputTokens} cached=${usage.cachedInputTokens} out=${usage.outputTokens})`,
    );

    this._bpm.recordAndPersistTokens(peer.peerId, usage.inputTokens, usage.outputTokens);
  }

  // parseCostHeaders removed — cost data now flows through NeedAuth on PaymentMux.

  recordResponseContent(peerId: string, reqBody: Uint8Array, resBody: Uint8Array, latencyMs: number): void {
    debugLog(
      `[BuyerNegotiator] recordResponseContent: reqBody=${reqBody.length}B resBody=${resBody.length}B latency=${latencyMs}ms`,
    );
    const existing = this._lastResponseCost.get(peerId);
    if (existing) {
      this._lastResponseCost.set(peerId, {
        ...existing,
        inputContent: reqBody,
        outputContent: resBody,
        latencyMs,
      });
    }
  }

  async applyExternalSpendingAuth(
    peer: PeerInfo,
    conn: PeerConnection,
    headerValue: string,
  ): Promise<void> {
    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);

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

    debugLog(`[BuyerNegotiator] External SpendingAuth: channel=${payload.channelId.slice(0, 18)}... amount=${payload.cumulativeAmount}`);

    const sellerEvmAddrExternal = await this._resolveSellerAddr(peer);

    // Store session so handleAuthAck can find it
    if (this._channelStore) {
      const reserveDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
      this._channelStore.upsertChannel({
        sessionId: payload.channelId,
        peerId: peer.peerId,
        role: 'buyer',
        sellerEvmAddr: sellerEvmAddrExternal,
        buyerEvmAddr: this._identity.wallet.address,
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

    pmux.sendSpendingAuth(payload);
    debugLog(`[BuyerNegotiator] External SpendingAuth sent to seller ${peer.peerId.slice(0, 12)}..., waiting for AuthAck...`);

    let reserveCtxAmount: bigint | undefined;
    try {
      reserveCtxAmount = payload.reserveMaxAmount != null
        ? BigInt(payload.reserveMaxAmount)
        : BigInt(payload.cumulativeAmount);
    } catch {
      reserveCtxAmount = undefined;
    }
    await this._waitForLockConfirmation(peer.peerId, { requestedReserve: reserveCtxAmount });
    debugLog(`[BuyerNegotiator] AuthAck received from seller ${peer.peerId.slice(0, 12)}...`);
    this._lockedPeers.add(peer.peerId);

    this._emit.emit('payment:signed', {
      peerId: peer.peerId,
      sellerEvmAddr: sellerEvmAddrExternal,
      amount: payload.cumulativeAmount,
    });
  }

  onPeerDisconnect(peerId: PeerId): void {
    this._muxes.delete(peerId);
    this._bufferedPaymentRequired.delete(peerId);

    // Cancel any in-flight PaymentRequired wait
    const pendingPR = this._pendingPaymentRequired.get(peerId);
    if (pendingPR) {
      clearTimeout(pendingPR.timer);
      this._pendingPaymentRequired.delete(peerId);
      pendingPR.reject(new Error(`Peer ${peerId.slice(0, 12)}... disconnected during payment negotiation`));
    }

    this._lockedPeers.delete(peerId);
    this._firstRequestSent.delete(peerId);
    this._lastResponseCost.delete(peerId);
  }

  /** Wait for in-flight NeedAuth handlers to complete (settlement safety). */
  async drainPendingNeedAuth(): Promise<void> {
    const pending = [...this._pendingNeedAuth.values()];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  cleanup(): void {
    this._lockedPeers.clear();
    this._firstRequestSent.clear();
    this._lastResponseCost.clear();
    this._muxes.clear();

    for (const [, pending] of this._pendingPaymentRequired) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Node stopped'));
    }
    this._pendingPaymentRequired.clear();
    this._bufferedPaymentRequired.clear();
    this._negotiationLocks.clear();
  }

  /**
   * Build the full pricing map from peer metadata (defaults + all per-service overrides).
   * This ensures the buyer knows pricing for every service the seller offers,
   * not just the one that triggered the 402.
   */
  private _buildPricingMap(peer: PeerInfo): { defaults: ServicePricing; services: Record<string, ServicePricing> } | undefined {
    const defaults: ServicePricing = {
      inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
      outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
      cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
    };
    if (defaults.inputUsdPerMillion === 0 && defaults.outputUsdPerMillion === 0 && !peer.providerPricing) {
      return undefined;
    }

    const services: Record<string, ServicePricing> = {};
    if (peer.providerPricing) {
      for (const entry of Object.values(peer.providerPricing)) {
        if (entry.services) {
          for (const [serviceName, sp] of Object.entries(entry.services)) {
            services[serviceName] = {
              inputUsdPerMillion: sp.inputUsdPerMillion,
              outputUsdPerMillion: sp.outputUsdPerMillion,
              cachedInputUsdPerMillion: sp.cachedInputUsdPerMillion,
            };
          }
        }
      }
    }

    return { defaults, services };
  }

  private async _negotiatePayment(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    // Per-peer mutex: if another request is already negotiating, wait for it
    const existing = this._negotiationLocks.get(peer.peerId);
    if (existing) {
      await existing;
      return;
    }

    const negotiation = this._doNegotiatePayment(peer, conn);
    this._negotiationLocks.set(peer.peerId, negotiation);
    try {
      await negotiation;
    } finally {
      this._negotiationLocks.delete(peer.peerId);
    }
  }

  private async _doNegotiatePayment(peer: PeerInfo, conn: PeerConnection): Promise<void> {
    if (this._lockedPeers.has(peer.peerId)) return;

    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);

    // Check if PaymentRequired was already buffered
    const buffered = this._bufferedPaymentRequired.get(peer.peerId);
    if (buffered) {
      this._bufferedPaymentRequired.delete(peer.peerId);
      debugLog(`[BuyerNegotiator] Using buffered PaymentRequired from ${peer.peerId.slice(0, 12)}...`);
    }

    const PAYMENT_REQUIRED_TIMEOUT_MS = 10_000;
    const requirements = buffered ?? await new Promise<PaymentRequiredPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingPaymentRequired.delete(peer.peerId);
        reject(new Error(`PaymentRequired timeout from seller ${peer.peerId.slice(0, 12)}...`));
      }, PAYMENT_REQUIRED_TIMEOUT_MS);
      this._pendingPaymentRequired.set(peer.peerId, { resolve, reject, timer });
    });

    debugLog(`[BuyerNegotiator] PaymentRequired from ${peer.peerId.slice(0, 12)}...: minBudgetPerRequest=${requirements.minBudgetPerRequest} suggested=${requirements.suggestedAmount}`);

    // Validate seller's per-request minimum
    const minBudgetPerRequest = BigInt(requirements.minBudgetPerRequest);
    if (minBudgetPerRequest > this._bpm.maxPerRequestUsdc) {
      throw new Error(
        `Seller ${peer.peerId.slice(0, 12)}... minBudgetPerRequest=${minBudgetPerRequest} exceeds buyer maxPerRequestUsdc=${this._bpm.maxPerRequestUsdc}`,
      );
    }

    // Cap amount at buyer's maxReserveAmountUsdc
    let amount: bigint;
    try {
      amount = BigInt(requirements.suggestedAmount);
    } catch {
      throw new Error(`Invalid suggestedAmount from seller ${peer.peerId.slice(0, 12)}...: "${requirements.suggestedAmount}"`);
    }
    if (amount > this._bpm.maxReserveAmountUsdc) {
      amount = this._bpm.maxReserveAmountUsdc;
    }
    if (amount <= 0n) {
      throw new Error(`Invalid reserve amount for payment to ${peer.peerId.slice(0, 12)}...`);
    }

    const sellerEvmAddr = await this._resolveSellerAddr(peer);

    this._emit.emit('payment:required', {
      peerId: peer.peerId,
      sellerEvmAddr,
      minBudgetPerRequest: requirements.minBudgetPerRequest,
      suggestedAmount: amount.toString(),
    });

    // Extract pricing from seller's PaymentRequired or peer metadata
    const pricing = (requirements.inputUsdPerMillion != null || requirements.outputUsdPerMillion != null)
      ? {
          inputUsdPerMillion: requirements.inputUsdPerMillion ?? peer.defaultInputUsdPerMillion ?? 0,
          outputUsdPerMillion: requirements.outputUsdPerMillion ?? peer.defaultOutputUsdPerMillion ?? 0,
          cachedInputUsdPerMillion: requirements.cachedInputUsdPerMillion ?? peer.defaultCachedInputUsdPerMillion,
        }
      : (peer.defaultInputUsdPerMillion != null || peer.defaultOutputUsdPerMillion != null)
        ? {
            inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
            outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
            cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
          }
        : undefined;

    // Build full pricing map from peer metadata (defaults + all per-service overrides)
    const pricingMap = this._buildPricingMap(peer);

    try {
      await this._bpm.authorizeSpending(peer.peerId, pmux, minBudgetPerRequest, amount, pricing, pricingMap, peer.metadata);
      debugLog(`[BuyerNegotiator] SpendingAuth sent to seller ${peer.peerId.slice(0, 12)}..., waiting for AuthAck...`);

      await this._waitForLockConfirmation(peer.peerId, { requestedReserve: amount, minBudgetPerRequest });
      debugLog(`[BuyerNegotiator] AuthAck received from seller ${peer.peerId.slice(0, 12)}...`);
      this._lockedPeers.add(peer.peerId);

      this._emit.emit('payment:signed', {
        peerId: peer.peerId,
        sellerEvmAddr,
        amount: amount.toString(),
      });
    } catch (err) {
      debugWarn(`[BuyerNegotiator] Payment negotiation failed for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  private async _awaitPaymentRequired(
    peerId: PeerId,
    conn: PeerConnection,
    timeoutMs: number,
  ): Promise<PaymentRequiredPayload | null> {
    const buffered = this._bufferedPaymentRequired.get(peerId);
    if (buffered) return buffered;

    // Ensure the buyer-side PaymentMux exists before waiting
    this.getOrCreatePaymentMux(peerId, conn);

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

  private async _recoverExistingSession(
    peer: PeerInfo,
    conn: PeerConnection,
    minBudgetPerRequest: bigint | null = null,
    targetCumulative: bigint | null = null,
  ): Promise<boolean> {
    const session = this._bpm.getActiveSession(peer.peerId);
    if (!session) {
      return false;
    }

    if (!this._channelsClient) {
      this._bpm.retireSession(peer.peerId, 'ghost');
      return false;
    }

    const onChain = await this._getOnChainSessionState(session.sessionId);
    if (onChain === null) {
      return false;
    }

    if (!onChain.exists) {
      if (this._bpm.canReplayReserveAuth(peer.peerId)) {
        const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);
        await this._bpm.resendReserveAuth(peer.peerId, pmux);
        await this._waitForLockConfirmation(peer.peerId, {
          minBudgetPerRequest: minBudgetPerRequest ?? undefined,
        });
        this._lockedPeers.add(peer.peerId);
        return true;
      }

      this._bpm.retireSession(peer.peerId, 'ghost');
      return false;
    }

    if (onChain.status === 'settled') {
      this._bpm.retireSession(peer.peerId, 'settled', onChain.channel.settled);
      return false;
    }

    if (onChain.status === 'timeout') {
      this._bpm.retireSession(peer.peerId, 'timeout');
      return false;
    }

    if (onChain.status !== 'active') {
      this._bpm.retireSession(peer.peerId, 'ghost');
      return false;
    }

    const pmux = this.getOrCreatePaymentMux(peer.peerId, conn);
    if (minBudgetPerRequest != null && minBudgetPerRequest > 0n) {
      const cumulativeBefore = this._bpm.getCumulativeAmount(peer.peerId);
      await this._bpm.extendCurrentSpendingAuth(
        peer.peerId,
        minBudgetPerRequest,
        pmux,
        targetCumulative != null && targetCumulative > 0n ? targetCumulative : undefined,
      );
      const cumulativeAfter = this._bpm.getCumulativeAmount(peer.peerId);
      if (cumulativeAfter <= cumulativeBefore) {
        // extendCurrentSpendingAuth was a no-op — the overdraft window and reserve ceiling
        // are both wedged. Retire the session so the caller negotiates a fresh channel
        // instead of spinning in an infinite 402 retry loop.
        debugWarn(
          `[BuyerNegotiator] extendCurrentSpendingAuth made no progress for ${peer.peerId.slice(0, 12)}... ` +
          `(cumulative=${cumulativeAfter}); retiring session`,
        );
        this._bpm.retireSession(peer.peerId, 'ghost');
        this._lockedPeers.delete(peer.peerId);
        this._firstRequestSent.delete(peer.peerId);
        return false;
      }
    } else {
      await this._bpm.resendCurrentSpendingAuth(peer.peerId, pmux);
    }
    await this._waitForLockConfirmation(peer.peerId, {
      minBudgetPerRequest: minBudgetPerRequest ?? undefined,
    });
    this._lockedPeers.add(peer.peerId);
    return true;
  }

  private async _canRetireStaleSessionWithoutOnChainProof(): Promise<boolean> {
    const depositsClient = this._depositsClient;
    if (!depositsClient) {
      return false;
    }

    try {
      const balance = await depositsClient.getBuyerBalance(this._identity.wallet.address);
      return balance.reserved === 0n;
    } catch (err) {
      debugWarn(
        `[BuyerNegotiator] Failed to verify buyer reserved balance while checking stale session: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  private async _getOnChainSessionState(channelId: string): Promise<
    | null
    | ReturnType<typeof classifyOnChainChannel>
  > {
    try {
      const channelsClient = this._channelsClient;
      if (!channelsClient) {
        return null;
      }

      return classifyOnChainChannel(await channelsClient.getSession(channelId));
    } catch (err) {
      debugWarn(`[BuyerNegotiator] Failed to load on-chain channel ${channelId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async _waitForLockConfirmation(
    sellerPeerId: string,
    ctx?: { requestedReserve?: bigint; minBudgetPerRequest?: bigint },
  ): Promise<void> {
    const pollIntervalMs = 200;
    const timeoutMs = 30_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this._bpm.isLockConfirmed(sellerPeerId)) return;
      if (this._bpm.isLockRejected(sellerPeerId)) {
        throw new Error(
          `Lock rejected by seller ${sellerPeerId.slice(0, 12)}...${this._buildLockFailureHint(ctx)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Lock confirmation timed out for seller ${sellerPeerId.slice(0, 12)}... (${timeoutMs}ms).${this._buildLockFailureHint(ctx)}`,
    );
  }

  /**
   * Build a human-readable hint appended to lock-confirmation failures,
   * listing the most likely causes so operators don't have to guess.
   *
   * Note: this intentionally does NOT call the buyer's RPC. The buyer's RPC
   * is typically less reliable than the seller's, and the seller is the one
   * making the on-chain call that is failing — it has the exact revert reason
   * and a fresh deposits snapshot. A follow-up will plumb a structured
   * AuthNack frame from the seller carrying that information; this hint
   * exists so the surrounding error shape is already in place when that
   * lands.
   */
  private _buildLockFailureHint(
    ctx?: { requestedReserve?: bigint; minBudgetPerRequest?: bigint },
  ): string {
    const lines: string[] = [];

    // We don't know the buyer's live balance here — only what we asked for.
    // The binding on-chain constraint is lockForChannel(buyer, maxAmount) in
    // reserve() / topUp(); settle()/close() cannot throw InsufficientBalance
    // because their charges come from already-locked reserve. So the ceiling
    // we need the buyer to have covered is requestedReserve.
    const reserve = ctx?.requestedReserve;
    const min = ctx?.minBudgetPerRequest;
    if (reserve != null && reserve > 0n) {
      lines.push(
        `- Deposits may be below the reserve ceiling the seller will lock ` +
        `(${formatUsdc(reserve)} USDC). The seller's on-chain reserve() reverts ` +
        `with InsufficientBalance before AuthAck. ` +
        `Check with "antseed buyer status"; top up with "antseed buyer deposit <amount>".`,
      );
    } else if (min != null && min > 0n) {
      lines.push(
        `- Deposits may be below seller minBudgetPerRequest (${formatUsdc(min)} USDC). ` +
        `Check with "antseed buyer status"; top up with "antseed buyer deposit <amount>".`,
      );
    }
    lines.push('- Seller may be overloaded or gated on subscription (try another peer).');
    lines.push('- Seller may be online but the payment process stalled (retry, or pin a different peer).');

    return `\nLikely causes:\n  ${lines.join('\n  ')}`;
  }

}

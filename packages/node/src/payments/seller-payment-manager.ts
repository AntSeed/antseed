import { type AbstractSigner, verifyTypedData } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  PaymentRequiredPayload,
} from '../types/protocol.js';
import { ChannelsClient } from './evm/channels-client.js';
import {
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  makeChannelsDomain,
  encodeMetadata,
  ZERO_METADATA,
} from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { peerIdToAddress } from '../types/peer.js';
import { ChannelStore, type StoredChannel } from './channel-store.js';

export interface SellerPaymentConfig {
  rpcUrl: string;
  channelsContractAddress: string;
  chainId: number;
  dataDir: string;
  /** Minimum USDC per request (base units). Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Whether to immediately settle when buyer disconnects. Default: true. */
  settleOnDisconnect?: boolean;
}

/** Default minimum budget per request: $0.50 USDC (base units). */
const DEFAULT_MIN_BUDGET_PER_REQUEST = '500000';

/** Stored auth entry for buyer's SpendingAuth signature. */
interface LatestAuth {
  spendingAuthSig: string;
  cumulativeAmount: bigint;
  metadataHash: string;
  metadata: string;
}

/**
 * Manages seller-side payment sessions.
 * The buyer sends a single SpendingAuth signature with a monotonically
 * increasing cumulativeAmount on every request.
 * The seller tracks spending locally and settles/closes via the contract at session end.
 */
export class SellerPaymentManager {
  private readonly _identity: Identity;
  private readonly _signer: AbstractSigner;
  private readonly _channelsClient: ChannelsClient;
  private readonly _config: SellerPaymentConfig;
  private readonly _channelStore: ChannelStore;
  /** In-memory cache of active buyer peerIds for fast has-session checks. */
  private readonly _activeBuyers = new Set<string>();
  /** Per-buyer mutex to prevent concurrent handleSpendingAuth for the same buyer. */
  private readonly _buyerLocks = new Map<string, Promise<void>>();

  /** channelId -> highest accepted cumulativeAmount from buyer's SpendingAuth */
  private readonly _acceptedCumulative = new Map<string, bigint>();

  /** channelId -> total USDC spent so far (sum of recordSpend calls) */
  private readonly _spent = new Map<string, bigint>();

  /** channelId -> on-chain reserveMaxAmount (budget ceiling from ReserveAuth) */
  private readonly _reserveMax = new Map<string, bigint>();

  /** channelId -> latest buyer-signed auth (both sigs + cumulative values + metadata) for settle/close */
  private readonly _latestAuth = new Map<string, LatestAuth>();

  /** channelId -> number of failed close() attempts. In-memory only; resets on node restart. */
  private readonly _closeRetryCount = new Map<string, number>();

  /** Max close() retries before giving up (buyer must requestClose on-chain) */
  private static readonly MAX_CLOSE_RETRIES = 3;

  constructor(identity: Identity, config: SellerPaymentConfig, channelStore: ChannelStore) {
    this._identity = identity;
    this._config = config;
    this._signer = identity.wallet;
    this._channelsClient = new ChannelsClient({
      rpcUrl: config.rpcUrl,
      contractAddress: config.channelsContractAddress,
    });
    this._channelStore = channelStore;

    // Hydrate from persisted channels
    const activeChannels = this._channelStore.getActiveChannels('seller');
    for (const channel of activeChannels) {
      this._activeBuyers.add(channel.peerId);
      this._acceptedCumulative.set(channel.sessionId, BigInt(channel.authMax));
      this._spent.set(channel.sessionId, BigInt(channel.tokensDelivered));
      // Hydrate reserveMax from previousConsumption (repurposed field)
      const storedReserveMax = BigInt(channel.previousConsumption || '0');
      if (storedReserveMax > 0n) {
        this._reserveMax.set(channel.sessionId, storedReserveMax);
      }
      // Hydrate latest auth sigs so close() works after restart
      if (channel.latestSpendingAuthSig) {
        this._latestAuth.set(channel.sessionId, {
          spendingAuthSig: channel.latestSpendingAuthSig,
          cumulativeAmount: BigInt(channel.authMax),
          metadataHash: '',
          metadata: channel.latestMetadata ?? '',
        });
      }
    }
  }

  get channelsClient(): ChannelsClient {
    return this._channelsClient;
  }

  // ── SpendingAuth handler ─────────────────────────────────────

  /**
   * Handle incoming SpendingAuth from a buyer.
   * First auth: verify SpendingAuth, reserve on-chain, send AuthAck.
   * Subsequent: verify SpendingAuth signature, validate monotonic increase, persist.
   */
  async handleSpendingAuth(
    buyerPeerId: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<'accepted' | 'reserved' | 'rejected'> {
    // Per-buyer mutex: serialize concurrent auths for the same buyer
    const existing = this._buyerLocks.get(buyerPeerId);
    let result: 'accepted' | 'reserved' | 'rejected' = 'rejected';
    const lock = (existing ?? Promise.resolve()).then(async () => {
      result = await this._handleSpendingAuthInner(buyerPeerId, payload, paymentMux);
    });
    this._buyerLocks.set(buyerPeerId, lock.catch(() => {}));
    await lock;
    return result;
  }

  private async _handleSpendingAuthInner(
    buyerPeerId: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<'accepted' | 'reserved' | 'rejected'> {
    const buyerEvmAddr = peerIdToAddress(buyerPeerId);
    try {
      const channelId = payload.channelId;
      const cumulativeAmount = BigInt(payload.cumulativeAmount);
      const existingCumulative = this._acceptedCumulative.get(channelId);

      const channelsDomain = makeChannelsDomain(this._config.chainId, this._config.channelsContractAddress);

      if (existingCumulative === undefined) {
        // ── First SpendingAuth: verify ReserveAuth and reserve on-chain ──
        // The buyer signs ReserveAuth(channelId, maxAmount, deadline) to bind escrow terms.
        const reserveMaxAmount = payload.reserveMaxAmount ? BigInt(payload.reserveMaxAmount) : cumulativeAmount;
        const reserveDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
        const reserveMsg = {
          channelId,
          maxAmount: reserveMaxAmount,
          deadline: BigInt(reserveDeadline),
        };
        const reserveRecovered = verifyTypedData(channelsDomain, RESERVE_AUTH_TYPES, reserveMsg, payload.spendingAuthSig);
        if (reserveRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid ReserveAuth signature: recovered=${reserveRecovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }
        debugLog(`[SellerPayment] ReserveAuth verified for buyer ${buyerPeerId.slice(0, 12)}...`);
        debugLog(`[SellerPayment] Reserving channel ${channelId.slice(0, 18)}... on-chain`);
        const reserveSalt = payload.reserveSalt ?? channelId;
        await this._channelsClient.reserve(
          this._signer,
          buyerEvmAddr,
          reserveSalt,
          reserveMaxAmount,
          BigInt(reserveDeadline),
          payload.spendingAuthSig,
        );

        // Store new session (sessionId field stores channelId for backward compat)
        const now = Date.now();
        const sellerEvmAddr = this._identity.wallet.address;
        const session: StoredChannel = {
          sessionId: channelId,
          peerId: buyerPeerId,
          role: 'seller',
          sellerEvmAddr,
          buyerEvmAddr,
          nonce: 0,
          authMax: payload.cumulativeAmount,
          previousConsumption: reserveMaxAmount.toString(), // repurposed: stores reserveMax
          deadline: reserveDeadline,
          previousSessionId: '',
          tokensDelivered: '0',
          requestCount: 0,
          reservedAt: now,
          settledAt: null,
          settledAmount: null,
          status: 'active',
          latestBuyerSig: payload.spendingAuthSig,
          latestSpendingAuthSig: payload.spendingAuthSig,
          latestMetadata: payload.metadata,
          createdAt: now,
          updatedAt: now,
        };
        this._channelStore.upsertChannel(session);

        // Initialize tracking maps
        this._acceptedCumulative.set(channelId, cumulativeAmount);
        this._reserveMax.set(channelId, reserveMaxAmount);
        this._spent.set(channelId, 0n);
        this._latestAuth.set(channelId, {
          spendingAuthSig: payload.spendingAuthSig,
          cumulativeAmount,
          metadataHash: payload.metadataHash,
          metadata: payload.metadata,
        });
        this._activeBuyers.add(buyerPeerId);

        // Send AuthAck
        paymentMux.sendAuthAck({
          channelId,
        });

        debugLog(`[SellerPayment] AuthAck sent for channel ${channelId.slice(0, 18)}...`);
        return 'reserved';
      } else if (
        payload.reserveMaxAmount
        && BigInt(payload.reserveMaxAmount) > (this._reserveMax.get(channelId) ?? 0n)
      ) {
        // ── Top-up: buyer is extending the reserve ceiling ──
        const newMaxAmount = BigInt(payload.reserveMaxAmount);
        const topUpDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
        const currentReserveMax = this._reserveMax.get(channelId) ?? 0n;

        // Verify as ReserveAuth (not SpendingAuth)
        const reserveMsg = {
          channelId,
          maxAmount: newMaxAmount,
          deadline: BigInt(topUpDeadline),
        };
        const recovered = verifyTypedData(channelsDomain, RESERVE_AUTH_TYPES, reserveMsg, payload.spendingAuthSig);
        if (recovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid top-up ReserveAuth signature: recovered=${recovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }

        // Call topUp() on-chain
        debugLog(`[SellerPayment] Top-up verified: channel=${channelId.slice(0, 18)}... ceiling ${currentReserveMax} → ${newMaxAmount}`);
        await this._channelsClient.topUp(
          this._signer,
          channelId,
          newMaxAmount,
          BigInt(topUpDeadline),
          payload.spendingAuthSig,
        );

        // Update tracking
        this._reserveMax.set(channelId, newMaxAmount);
        const session = this._channelStore.getChannel(channelId);
        if (session) {
          session.previousConsumption = newMaxAmount.toString(); // repurposed: stores reserveMax
          session.deadline = topUpDeadline;
          session.updatedAt = Date.now();
          this._channelStore.upsertChannel(session);
        }

        debugLog(`[SellerPayment] Top-up completed: channel=${channelId.slice(0, 18)}... new ceiling=${newMaxAmount}`);
        return 'accepted';
      } else {
        // ── Subsequent SpendingAuth: verify SpendingAuth signature ──
        const metadataMsg = {
          channelId,
          cumulativeAmount,
          metadataHash: payload.metadataHash,
        };
        const metadataRecovered = verifyTypedData(channelsDomain, SPENDING_AUTH_TYPES, metadataMsg, payload.spendingAuthSig);
        if (metadataRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid SpendingAuth signature: recovered=${metadataRecovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }

        // Validate monotonic (equal = idempotent retransmit)
        if (cumulativeAmount < existingCumulative) {
          debugWarn(
            `[SellerPayment] Rejecting non-monotonic SpendingAuth: ` +
            `new=${cumulativeAmount} existing=${existingCumulative} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }
        if (cumulativeAmount === existingCumulative) {
          debugLog(`[SellerPayment] Idempotent SpendingAuth (same cumulative=${cumulativeAmount}) — accepted`);
          return 'accepted';
        }

        // Reject if buyer's cumulative doesn't cover what the seller has already spent
        const spent = this._spent.get(channelId) ?? 0n;
        if (cumulativeAmount < spent) {
          debugWarn(
            `[SellerPayment] Rejecting underfunded SpendingAuth: ` +
            `cumulative=${cumulativeAmount} < spent=${spent} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }

        // Update tracking
        this._acceptedCumulative.set(channelId, cumulativeAmount);
        this._latestAuth.set(channelId, {
          spendingAuthSig: payload.spendingAuthSig,
          cumulativeAmount,
          metadataHash: payload.metadataHash,
          metadata: payload.metadata,
        });

        // Persist latest auth + sigs to ChannelStore
        const session = this._channelStore.getChannel(channelId);
        if (session) {
          session.authMax = payload.cumulativeAmount;
          session.latestBuyerSig = payload.spendingAuthSig;
          session.latestSpendingAuthSig = payload.spendingAuthSig;
          session.latestMetadata = payload.metadata;
          session.updatedAt = Date.now();
          this._channelStore.upsertChannel(session);
        }

        debugLog(`[SellerPayment] Budget updated: channel=${channelId.slice(0, 18)}... cumulative=${cumulativeAmount}`);
        return 'accepted';
      }
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to process SpendingAuth: ${err instanceof Error ? err.message : err}`);
      return 'rejected';
    }
  }

  // ── Per-request validation ──────────────────────────────────

  /**
   * Validate and accept a SpendingAuth attached to an incoming request.
   * Returns true if the buyer has sufficient budget to serve this request.
   */
  async validateAndAcceptAuth(
    buyerPeerId: string,
    auth: SpendingAuthPayload,
  ): Promise<boolean> {
    // Look up active session for this buyer
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, 'seller');
    if (!session) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: no active session for buyer ${buyerPeerId.slice(0, 12)}...`);
      return false;
    }

    const channelId = session.sessionId; // sessionId field stores channelId
    const existingCumulative = this._acceptedCumulative.get(channelId);
    if (existingCumulative === undefined) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: no tracked cumulative for channel ${channelId.slice(0, 18)}...`);
      return false;
    }

    // Verify AntSeed SpendingAuth signature
    const channelsDomain = makeChannelsDomain(this._config.chainId, this._config.channelsContractAddress);
    const metadataMsg = {
      channelId: auth.channelId,
      cumulativeAmount: BigInt(auth.cumulativeAmount),
      metadataHash: auth.metadataHash,
    };

    const buyerEvmAddr = peerIdToAddress(buyerPeerId);
    try {
      const recovered = verifyTypedData(channelsDomain, SPENDING_AUTH_TYPES, metadataMsg, auth.spendingAuthSig);
      if (recovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
        debugWarn(`[SellerPayment] validateAndAcceptAuth: invalid SpendingAuth signature`);
        return false;
      }
    } catch {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: SpendingAuth verification failed`);
      return false;
    }

    // Check monotonic: strictly greater, or equal (idempotent retransmit)
    const newCumulative = BigInt(auth.cumulativeAmount);
    if (newCumulative < existingCumulative) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: cumulative decreased from ${existingCumulative} to ${newCumulative}`);
      return false;
    }

    // Update if strictly greater
    if (newCumulative > existingCumulative) {
      this._acceptedCumulative.set(channelId, newCumulative);
      this._latestAuth.set(channelId, {
        spendingAuthSig: auth.spendingAuthSig,
        cumulativeAmount: newCumulative,
        metadataHash: auth.metadataHash,
        metadata: auth.metadata,
      });

      // Persist latest auth + sigs to ChannelStore
      const storedSession = this._channelStore.getChannel(channelId);
      if (storedSession) {
        storedSession.authMax = auth.cumulativeAmount;
        storedSession.latestBuyerSig = auth.spendingAuthSig;
        storedSession.latestSpendingAuthSig = auth.spendingAuthSig;
        storedSession.latestMetadata = auth.metadata;
        storedSession.updatedAt = Date.now();
        this._channelStore.upsertChannel(storedSession);
      }
    }

    // Check available budget
    const accepted = this._acceptedCumulative.get(channelId)!;
    const spent = this._spent.get(channelId) ?? 0n;
    return accepted >= spent;
  }

  // ── Spend tracking ──────────────────────────────────────────

  /**
   * Record USDC consumption after serving a request.
   */
  recordSpend(sessionId: string, costUsdc: bigint): void {
    const current = this._spent.get(sessionId);
    if (current === undefined) {
      debugWarn(`[SellerPayment] recordSpend: unknown channelId ${sessionId.slice(0, 18)}...`);
      return;
    }

    const newSpent = current + costUsdc;
    this._spent.set(sessionId, newSpent);

    // Persist spent amount to ChannelStore (using tokensDelivered field)
    this._channelStore.updateTokensDelivered(sessionId, newSpent.toString(), 0);
  }

  // ── Settlement ──────────────────────────────────────────────

  /**
   * Close a completed session on-chain using the latest buyer-signed dual signatures.
   * Uses close() for final settlement (releases remaining deposit to buyer).
   */
  async settleSession(buyerPeerId: string, { cleanupOnFailure = false } = {}): Promise<void> {
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, 'seller');
    if (!session) {
      debugWarn(`[SellerPayment] settleSession: no active session for buyer ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    const channelId = session.sessionId;
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;

    if (accepted === 0n) {
      // Session opened but no requests served — cannot close without a voucher.
      // Leave it for checkTimeouts(); buyer must call requestClose → withdraw on-chain.
      debugLog(`[SellerPayment] Zero-cumulative channel ${channelId.slice(0, 18)}... — deferring to timeout checker`);
    } else {
      const retries = this._closeRetryCount.get(channelId) ?? 0;
      if (retries >= SellerPaymentManager.MAX_CLOSE_RETRIES) {
        // Exhausted retries — give up on close(), fall back to timeout path
        debugWarn(`[SellerPayment] close() failed ${retries} times for ${channelId.slice(0, 18)}... — falling back to timeout path`);
        // Fall through to general cleanup below; buyer must requestClose on-chain
      } else {
        // Close with the latest buyer-signed auth (final settlement)
        const latestAuth = this._latestAuth.get(channelId);
        if (!latestAuth || !latestAuth.spendingAuthSig) {
          debugWarn(`[SellerPayment] No buyer signature stored for channel ${channelId.slice(0, 18)}... — cannot close`);
          return;
        }
        debugLog(`[SellerPayment] Closing channel ${channelId.slice(0, 18)}... cumulative=${latestAuth.cumulativeAmount} (attempt ${retries + 1}/${SellerPaymentManager.MAX_CLOSE_RETRIES})`);
        try {
          await this._channelsClient.close(
            this._signer,
            channelId,
            latestAuth.cumulativeAmount,
            latestAuth.metadata || encodeMetadata(ZERO_METADATA),
            latestAuth.spendingAuthSig,
          );
          this._channelStore.updateChannelStatus(channelId, 'settled', latestAuth.cumulativeAmount.toString());
          this._closeRetryCount.delete(channelId);
        } catch (err) {
          debugWarn(`[SellerPayment] Failed to close channel (attempt ${retries + 1}): ${err instanceof Error ? err.message : err}`);
          this._closeRetryCount.set(channelId, retries + 1);
          if (!cleanupOnFailure) {
            // Keep maps intact so checkTimeouts can retry
            return;
          }
          // Caller requested cleanup even on failure (e.g., disconnect handler)
        }
      }
    }

    // Clean up maps after successful close, zero-cumulative deferral, or exhausted retries
    this._acceptedCumulative.delete(channelId);
    this._spent.delete(channelId);
    this._latestAuth.delete(channelId);
    this._closeRetryCount.delete(channelId);
    this._activeBuyers.delete(buyerPeerId);
  }

  // ── Disconnect handling ───────────────────────────────────────

  onBuyerDisconnect(buyerPeerId: string): void {
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, 'seller');
    if (!session) return;

    const settleOnDisconnect = this._config.settleOnDisconnect ?? true;

    if (settleOnDisconnect) {
      const accepted = this._acceptedCumulative.get(session.sessionId) ?? 0n;
      if (accepted > 0n) {
        debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — closing channel immediately`);
        // Fire and forget settlement — clean up maps even if close() fails
        this.settleSession(buyerPeerId, { cleanupOnFailure: true }).catch((err) => {
          debugWarn(`[SellerPayment] Failed to close on disconnect: ${err instanceof Error ? err.message : err}`);
        });
        return;
      }
    }

    // Preserve session for reconnect; timeout checker handles ghost scenarios
    this._activeBuyers.delete(buyerPeerId);
    debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — channel ${session.sessionId.slice(0, 18)}... preserved for reconnect`);
  }

  // ── Stale session cleanup ────────────────────────────────────

  /**
   * Check for stale sessions and attempt to close them.
   * The seller can only close() with a valid SpendingAuth — it cannot
   * requestClose or withdraw (those are buyer-only on-chain).
   * If the seller has no auths, the session remains open until the buyer
   * calls requestClose → withdraw on-chain.
   * Called periodically and on startup for recovery.
   */
  async checkTimeouts(): Promise<void> {
    const nowSecs = Math.floor(Date.now() / 1000);
    const activeChannels = this._channelStore.getActiveChannels('seller');

    for (const channel of activeChannels) {
      const accepted = this._acceptedCumulative.get(channel.sessionId) ?? 0n;

      try {
        // If we have auths and the buyer is disconnected, try to close
        if (accepted > 0n && !this._activeBuyers.has(channel.peerId)) {
          debugLog(`[SellerPayment] Channel ${channel.sessionId.slice(0, 18)}... buyer disconnected — attempting close`);
          await this.settleSession(channel.peerId);
        }
        // If no auths and buyer disconnected, nothing the seller can do on-chain.
        // The buyer must call requestClose → withdraw. We just clean up locally
        // after a reasonable period (e.g. deadline passed).
        if (accepted === 0n && !this._activeBuyers.has(channel.peerId) && nowSecs > channel.deadline) {
          debugLog(`[SellerPayment] Channel ${channel.sessionId.slice(0, 18)}... no auths, past deadline — cleaning up locally`);
          this._channelStore.updateChannelStatus(channel.sessionId, 'timeout');
          this._acceptedCumulative.delete(channel.sessionId);
          this._spent.delete(channel.sessionId);
          this._latestAuth.delete(channel.sessionId);
          this._closeRetryCount.delete(channel.sessionId);
          this._reserveMax.delete(channel.sessionId);
          this._activeBuyers.delete(channel.peerId);
        }
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to process channel ${channel.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── Queries ───────────────────────────────────────────────────

  hasSession(buyerPeerId: string): boolean {
    return this._activeBuyers.has(buyerPeerId);
  }

  /** Get the active session for a buyer peer, or null. */
  getChannelByPeer(buyerPeerId: string): StoredChannel | null {
    return this._channelStore.getActiveChannelByPeer(buyerPeerId, 'seller');
  }

  /** Get total USDC spent for a session (sum of recordSpend calls). */
  getCumulativeSpend(sessionId: string): bigint {
    return this._spent.get(sessionId) ?? 0n;
  }

  /** Get the highest accepted cumulative amount for a session. */
  getAcceptedCumulative(sessionId: string): bigint {
    return this._acceptedCumulative.get(sessionId) ?? 0n;
  }

  /** Get the on-chain reserve budget ceiling for a session. */
  getReserveMax(sessionId: string): bigint {
    return this._reserveMax.get(sessionId) ?? 0n;
  }

  private static readonly DEFAULT_SUGGESTED_AMOUNT = 5_000_000n; // $5.00 — matches buyer's default maxReserveAmountUsdc

  /**
   * Build the PaymentRequired payload for a buyer that doesn't have a session.
   */
  getPaymentRequirements(
    requestId: string,
    buyerPeerId?: string,
    pricing?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number },
  ): PaymentRequiredPayload {
    const minBudgetPerRequest = this._config.minBudgetPerRequest ?? DEFAULT_MIN_BUDGET_PER_REQUEST;

    let suggestedAmount = SellerPaymentManager.DEFAULT_SUGGESTED_AMOUNT;
    if (buyerPeerId) {
      const priorSession = this._channelStore.getLatestChannel(buyerPeerId, 'seller');
      if (priorSession && priorSession.status === 'settled') {
        // Returning buyer with proven history — could use a different amount
        // For now, use the same default; config can override later
        suggestedAmount = SellerPaymentManager.DEFAULT_SUGGESTED_AMOUNT;
      }
    }

    return {
      minBudgetPerRequest,
      suggestedAmount: suggestedAmount.toString(),
      requestId,
      ...(pricing?.inputUsdPerMillion != null ? { inputUsdPerMillion: pricing.inputUsdPerMillion } : {}),
      ...(pricing?.outputUsdPerMillion != null ? { outputUsdPerMillion: pricing.outputUsdPerMillion } : {}),
    };
  }

  // ── CloseRequested handling ───────────────────────────────────

  /**
   * Handle a CloseRequested event for a channel this seller manages.
   * If the seller has a stored SpendingAuth, immediately close the channel
   * on-chain to claim earnings before the grace period expires.
   */
  async handleCloseRequested(channelId: string): Promise<void> {
    const latestAuth = this._latestAuth.get(channelId);
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;

    if (accepted > 0n && latestAuth?.spendingAuthSig) {
      debugLog(`[SellerPayment] CloseRequested for channel ${channelId.slice(0, 18)}... — closing with cumulative=${latestAuth.cumulativeAmount}`);
      try {
        await this._channelsClient.close(
          this._signer,
          channelId,
          latestAuth.cumulativeAmount,
          latestAuth.metadata || encodeMetadata(ZERO_METADATA),
          latestAuth.spendingAuthSig,
        );
        this._channelStore.updateChannelStatus(channelId, 'settled', latestAuth.cumulativeAmount.toString());
        debugLog(`[SellerPayment] Channel ${channelId.slice(0, 18)}... closed successfully after CloseRequested`);
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to close channel ${channelId.slice(0, 18)}... after CloseRequested: ${err instanceof Error ? err.message : err}`);
        return; // Will retry on next poll
      }
    } else {
      // No voucher — seller can't claim anything. Clean up locally;
      // buyer will withdraw after grace period.
      debugLog(`[SellerPayment] CloseRequested for channel ${channelId.slice(0, 18)}... — no SpendingAuth, cleaning up locally`);
      this._channelStore.updateChannelStatus(channelId, 'timeout');
    }

    // Clean up in-memory state
    this._acceptedCumulative.delete(channelId);
    this._spent.delete(channelId);
    this._latestAuth.delete(channelId);
    this._closeRetryCount.delete(channelId);
    this._reserveMax.delete(channelId);

    // Find and remove buyer from active set
    const channel = this._channelStore.getChannel(channelId);
    if (channel) {
      this._activeBuyers.delete(channel.peerId);
    }
  }

  /**
   * Poll for CloseRequested events and handle any that match active channels.
   * Returns the block number to use as the next fromBlock cursor.
   */
  async pollCloseRequested(fromBlock: number): Promise<number> {
    try {
      const events = await this._channelsClient.getCloseRequestedEvents(fromBlock, 'latest');
      const latestBlock = await this._channelsClient.getBlockNumber();

      for (const event of events) {
        // Only handle channels this seller is actively tracking
        if (this._acceptedCumulative.has(event.channelId) || this._channelStore.getChannel(event.channelId)?.status === 'active') {
          await this.handleCloseRequested(event.channelId);
        }
      }

      return latestBlock + 1;
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to poll CloseRequested events: ${err instanceof Error ? err.message : err}`);
      return fromBlock; // Retry from same block on next poll
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    // ChannelStore is shared with BuyerPaymentManager, closed from node.ts
  }
}

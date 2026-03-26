import { type AbstractSigner, verifyTypedData } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  PaymentRequiredPayload,
} from '../types/protocol.js';
import { SessionsClient } from './evm/sessions-client.js';
import { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
import {
  METADATA_AUTH_TYPES,
  TEMPO_VOUCHER_TYPES,
  makeSessionsDomain,
  makeTempoChannelDomain,
} from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { SessionStore, type StoredSession } from './session-store.js';

export interface SellerPaymentConfig {
  rpcUrl: string;
  sessionsContractAddress: string;
  streamChannelAddress: string;
  chainId: number;
  dataDir: string;
  /** Minimum USDC per request (base units). Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Whether to immediately settle when buyer disconnects. Default: true. */
  settleOnDisconnect?: boolean;
}

/** Default minimum budget per request: $0.01 USDC (base units). */
const DEFAULT_MIN_BUDGET_PER_REQUEST = '10000';

/** Stored auth entry for both Tempo voucher and AntSeed MetadataAuth signatures. */
interface LatestAuth {
  tempoVoucherSig: string;
  metadataAuthSig: string;
  cumulativeAmount: bigint;
  metadataHash: string;
  metadata: string;
}

/**
 * Manages seller-side payment sessions wrapping Tempo StreamChannel.
 * The buyer sends dual signatures (Tempo voucher + AntSeed MetadataAuth)
 * with a monotonically increasing cumulativeAmount on every request.
 * The seller tracks spending locally and settles/closes via the contract at session end.
 */
export class SellerPaymentManager {
  private readonly _identity: Identity;
  private readonly _signer: AbstractSigner;
  private readonly _sessionsClient: SessionsClient;
  private readonly _config: SellerPaymentConfig;
  private readonly _sessionStore: SessionStore;
  /** In-memory cache of active buyer peerIds for fast has-session checks. */
  private readonly _activeBuyers = new Set<string>();
  /** Per-buyer mutex to prevent concurrent handleSpendingAuth for the same buyer. */
  private readonly _buyerLocks = new Map<string, Promise<void>>();

  /** channelId -> highest accepted cumulativeAmount from buyer's SpendingAuth */
  private readonly _acceptedCumulative = new Map<string, bigint>();

  /** channelId -> total USDC spent so far (sum of recordSpend calls) */
  private readonly _spent = new Map<string, bigint>();

  /** channelId -> latest buyer-signed auth (both sigs + cumulative values + metadata) for settle/close */
  private readonly _latestAuth = new Map<string, LatestAuth>();

  constructor(identity: Identity, config: SellerPaymentConfig, sessionStore: SessionStore) {
    this._identity = identity;
    this._config = config;
    this._signer = identityToEvmWallet(identity);
    this._sessionsClient = new SessionsClient({
      rpcUrl: config.rpcUrl,
      contractAddress: config.sessionsContractAddress,
    });
    this._sessionStore = sessionStore;

    // Hydrate from persisted sessions
    const activeSessions = this._sessionStore.getActiveSessions('seller');
    for (const session of activeSessions) {
      this._activeBuyers.add(session.peerId);
      // Hydrate _acceptedCumulative from authMax (stores latest cumulativeAmount)
      this._acceptedCumulative.set(session.sessionId, BigInt(session.authMax));
      // Hydrate _spent from tokensDelivered (repurposed as spentAmount string)
      this._spent.set(session.sessionId, BigInt(session.tokensDelivered));
    }
  }

  get sessionsClient(): SessionsClient {
    return this._sessionsClient;
  }

  // ── SpendingAuth handler (dual-signature model) ─────────────

  /**
   * Handle incoming SpendingAuth from a buyer.
   * First auth: verify MetadataAuth, reserve on-chain, send AuthAck.
   * Subsequent: verify both signatures (Tempo voucher + MetadataAuth), validate monotonic increase, persist.
   */
  async handleSpendingAuth(
    buyerPeerId: string,
    buyerEvmAddr: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<'accepted' | 'reserved' | 'rejected'> {
    // Per-buyer mutex: serialize concurrent auths for the same buyer
    const existing = this._buyerLocks.get(buyerPeerId);
    let result: 'accepted' | 'reserved' | 'rejected' = 'rejected';
    const lock = (existing ?? Promise.resolve()).then(async () => {
      result = await this._handleSpendingAuthInner(buyerPeerId, buyerEvmAddr, payload, paymentMux);
    });
    this._buyerLocks.set(buyerPeerId, lock.catch(() => {}));
    await lock;
    return result;
  }

  private async _handleSpendingAuthInner(
    buyerPeerId: string,
    buyerEvmAddr: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<'accepted' | 'reserved' | 'rejected'> {
    try {
      const channelId = payload.channelId;
      const cumulativeAmount = BigInt(payload.cumulativeAmount);
      const existingCumulative = this._acceptedCumulative.get(channelId);

      // 1. Always verify AntSeed MetadataAuth signature
      const sessionsDomain = makeSessionsDomain(this._config.chainId, this._config.sessionsContractAddress);
      const metadataMsg = {
        channelId,
        cumulativeAmount,
        metadataHash: payload.metadataHash,
      };

      const metadataRecovered = verifyTypedData(sessionsDomain, METADATA_AUTH_TYPES, metadataMsg, payload.metadataAuthSig);
      if (metadataRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
        debugWarn(`[SellerPayment] Invalid MetadataAuth signature: recovered=${metadataRecovered} expected=${buyerEvmAddr}`);
        return 'rejected';
      }

      // 2. For subsequent auths, also verify Tempo voucher signature
      if (existingCumulative !== undefined && cumulativeAmount > 0n) {
        const tempoDomain = makeTempoChannelDomain(this._config.chainId, this._config.streamChannelAddress);
        const voucherMsg = {
          channelId,
          cumulativeAmount,
        };
        const voucherRecovered = verifyTypedData(tempoDomain, TEMPO_VOUCHER_TYPES, voucherMsg, payload.tempoVoucherSig);
        if (voucherRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid Tempo voucher signature: recovered=${voucherRecovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }
      }

      debugLog(`[SellerPayment] SpendingAuth verified for buyer ${buyerPeerId.slice(0, 12)}...`);

      if (existingCumulative === undefined) {
        // ── First SpendingAuth: reserve on-chain ──
        // The contract's reserve() only needs the MetadataAuth sig (cumulativeAmount=0).
        // No Tempo voucher is needed for reserve.
        debugLog(`[SellerPayment] Reserving channel ${channelId.slice(0, 18)}... on-chain`);
        const reserveMaxAmount = payload.reserveMaxAmount ? BigInt(payload.reserveMaxAmount) : cumulativeAmount;
        const reserveSalt = payload.reserveSalt ?? channelId; // salt should be provided by buyer
        const reserveDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
        await this._sessionsClient.reserve(
          this._signer,
          buyerEvmAddr,
          reserveSalt,
          reserveMaxAmount,
          BigInt(reserveDeadline),
          payload.metadataAuthSig,
        );

        // Store new session (sessionId field stores channelId for backward compat)
        const now = Date.now();
        const sellerEvmAddr = identityToEvmAddress(this._identity);
        const session: StoredSession = {
          sessionId: channelId,
          peerId: buyerPeerId,
          role: 'seller',
          sellerEvmAddr,
          buyerEvmAddr,
          nonce: 0,
          authMax: payload.cumulativeAmount,
          deadline: reserveDeadline,
          previousSessionId: '',
          previousConsumption: '0',
          tokensDelivered: '0',
          requestCount: 0,
          reservedAt: now,
          settledAt: null,
          settledAmount: null,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        this._sessionStore.upsertSession(session);

        // Initialize tracking maps
        this._acceptedCumulative.set(channelId, cumulativeAmount);
        this._spent.set(channelId, 0n);
        this._latestAuth.set(channelId, {
          tempoVoucherSig: payload.tempoVoucherSig,
          metadataAuthSig: payload.metadataAuthSig,
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
      } else {
        // ── Subsequent SpendingAuth: validate monotonic increase ──
        if (cumulativeAmount <= existingCumulative) {
          debugWarn(
            `[SellerPayment] Rejecting non-monotonic SpendingAuth: ` +
            `new=${cumulativeAmount} existing=${existingCumulative} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }

        // Update tracking
        this._acceptedCumulative.set(channelId, cumulativeAmount);
        this._latestAuth.set(channelId, {
          tempoVoucherSig: payload.tempoVoucherSig,
          metadataAuthSig: payload.metadataAuthSig,
          cumulativeAmount,
          metadataHash: payload.metadataHash,
          metadata: payload.metadata,
        });

        // Persist latest auth to SessionStore (authMax = latest cumulativeAmount)
        const session = this._sessionStore.getSession(channelId);
        if (session) {
          session.authMax = payload.cumulativeAmount;
          session.updatedAt = Date.now();
          this._sessionStore.upsertSession(session);
        }

        debugLog(`[SellerPayment] Budget updated: channel=${channelId.slice(0, 18)}... cumulative=${cumulativeAmount}`);
        // No on-chain call. No AuthAck.
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
    const session = this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
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

    // Verify AntSeed MetadataAuth signature
    const sessionsDomain = makeSessionsDomain(this._config.chainId, this._config.sessionsContractAddress);
    const metadataMsg = {
      channelId: auth.channelId,
      cumulativeAmount: BigInt(auth.cumulativeAmount),
      metadataHash: auth.metadataHash,
    };

    try {
      const recovered = verifyTypedData(sessionsDomain, METADATA_AUTH_TYPES, metadataMsg, auth.metadataAuthSig);
      if (recovered.toLowerCase() !== auth.buyerEvmAddr.toLowerCase()) {
        debugWarn(`[SellerPayment] validateAndAcceptAuth: invalid MetadataAuth signature`);
        return false;
      }
    } catch {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: MetadataAuth verification failed`);
      return false;
    }

    // Also verify Tempo voucher for non-zero amounts
    const newCumulative = BigInt(auth.cumulativeAmount);
    if (newCumulative > 0n) {
      const tempoDomain = makeTempoChannelDomain(this._config.chainId, this._config.streamChannelAddress);
      const voucherMsg = {
        channelId: auth.channelId,
        cumulativeAmount: newCumulative,
      };
      try {
        const recovered = verifyTypedData(tempoDomain, TEMPO_VOUCHER_TYPES, voucherMsg, auth.tempoVoucherSig);
        if (recovered.toLowerCase() !== auth.buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] validateAndAcceptAuth: invalid Tempo voucher signature`);
          return false;
        }
      } catch {
        debugWarn(`[SellerPayment] validateAndAcceptAuth: Tempo voucher verification failed`);
        return false;
      }
    }

    // Check monotonic: strictly greater, or equal (idempotent retransmit)
    if (newCumulative < existingCumulative) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: cumulative decreased from ${existingCumulative} to ${newCumulative}`);
      return false;
    }

    // Update if strictly greater
    if (newCumulative > existingCumulative) {
      this._acceptedCumulative.set(channelId, newCumulative);
      this._latestAuth.set(channelId, {
        tempoVoucherSig: auth.tempoVoucherSig,
        metadataAuthSig: auth.metadataAuthSig,
        cumulativeAmount: newCumulative,
        metadataHash: auth.metadataHash,
        metadata: auth.metadata,
      });

      // Persist latest auth to SessionStore
      const storedSession = this._sessionStore.getSession(channelId);
      if (storedSession) {
        storedSession.authMax = auth.cumulativeAmount;
        storedSession.updatedAt = Date.now();
        this._sessionStore.upsertSession(storedSession);
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

    // Persist spent amount to SessionStore (using tokensDelivered field)
    this._sessionStore.updateTokensDelivered(sessionId, newSpent.toString(), 0);
  }

  // ── Settlement ──────────────────────────────────────────────

  /**
   * Close a completed session on-chain using the latest buyer-signed dual signatures.
   * Uses close() for final settlement (releases remaining deposit to buyer).
   */
  async settleSession(buyerPeerId: string): Promise<void> {
    const session = this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
    if (!session) {
      debugWarn(`[SellerPayment] settleSession: no active session for buyer ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    const channelId = session.sessionId;
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;

    if (accepted === 0n) {
      // Session opened but no requests served — cannot close without a voucher.
      // Leave it for checkTimeouts() which uses requestClose → withdraw.
      debugLog(`[SellerPayment] Zero-cumulative channel ${channelId.slice(0, 18)}... — deferring to timeout checker`);
    } else {
      // Close with the latest buyer-signed auth (final settlement)
      const latestAuth = this._latestAuth.get(channelId);
      if (!latestAuth || !latestAuth.tempoVoucherSig || !latestAuth.metadataAuthSig) {
        debugWarn(`[SellerPayment] No buyer signatures stored for channel ${channelId.slice(0, 18)}... — cannot close`);
        return;
      }
      debugLog(`[SellerPayment] Closing channel ${channelId.slice(0, 18)}... cumulative=${latestAuth.cumulativeAmount}`);
      try {
        await this._sessionsClient.close(
          this._signer,
          channelId,
          latestAuth.cumulativeAmount,
          latestAuth.metadata,
          latestAuth.tempoVoucherSig,
          latestAuth.metadataAuthSig,
        );
        this._sessionStore.updateSessionStatus(channelId, 'settled', latestAuth.cumulativeAmount.toString());
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to close channel: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    // Clean up maps
    this._acceptedCumulative.delete(channelId);
    this._spent.delete(channelId);
    this._latestAuth.delete(channelId);
    this._activeBuyers.delete(buyerPeerId);
  }

  // ── Disconnect handling ───────────────────────────────────────

  onBuyerDisconnect(buyerPeerId: string): void {
    const session = this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
    if (!session) return;

    const settleOnDisconnect = this._config.settleOnDisconnect ?? true;

    if (settleOnDisconnect) {
      const accepted = this._acceptedCumulative.get(session.sessionId) ?? 0n;
      if (accepted > 0n) {
        debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — closing channel immediately`);
        // Fire and forget settlement
        this.settleSession(buyerPeerId).catch((err) => {
          debugWarn(`[SellerPayment] Failed to close on disconnect: ${err instanceof Error ? err.message : err}`);
        });
        return;
      }
    }

    // Preserve session for reconnect; timeout checker handles ghost scenarios
    this._activeBuyers.delete(buyerPeerId);
    debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — channel ${session.sessionId.slice(0, 18)}... preserved for reconnect`);
  }

  // ── Timeout management ────────────────────────────────────────

  /**
   * Check for and handle timed-out sessions.
   * For expired sessions: requestClose → withdraw (after Tempo grace period).
   * Called periodically and on startup for recovery.
   */
  async checkTimeouts(): Promise<void> {
    // Tempo has a 15-minute grace period after requestClose.
    // We use the session deadline as the trigger — once past deadline, call requestClose.
    // On the next check cycle (after 15 min), call withdraw.
    const TEMPO_GRACE_PERIOD_SECS = 15 * 60; // 15 minutes — matches Tempo default
    const nowSecs = Math.floor(Date.now() / 1000);
    const activeSessions = this._sessionStore.getActiveSessions('seller');

    for (const session of activeSessions) {
      const deadline = session.deadline;
      const accepted = this._acceptedCumulative.get(session.sessionId) ?? 0n;

      try {
        if (nowSecs > deadline) {
          // Past deadline: try to close normally if we have auths, otherwise requestClose→withdraw
          if (accepted > 0n) {
            // Try to close with latest auth first
            debugLog(`[SellerPayment] Channel ${session.sessionId.slice(0, 18)}... past deadline — attempting close`);
            await this.settleSession(session.peerId);
          } else {
            // No auths received — requestClose then withdraw
            const deadlinePlusGrace = deadline + TEMPO_GRACE_PERIOD_SECS;
            if (nowSecs >= deadlinePlusGrace) {
              // Grace period passed — withdraw
              debugLog(`[SellerPayment] Channel ${session.sessionId.slice(0, 18)}... past grace period — calling withdraw`);
              try {
                await this._sessionsClient.withdraw(this._signer, session.sessionId);
              } catch {
                // withdraw may fail if requestClose hasn't been called yet — try that first
                debugLog(`[SellerPayment] Withdraw failed, trying requestClose first for ${session.sessionId.slice(0, 18)}...`);
                await this._sessionsClient.requestClose(this._signer, session.sessionId);
                // Will withdraw on next cycle
                continue;
              }
              this._sessionStore.updateSessionStatus(session.sessionId, 'timeout');
              this._acceptedCumulative.delete(session.sessionId);
              this._spent.delete(session.sessionId);
              this._latestAuth.delete(session.sessionId);
              this._activeBuyers.delete(session.peerId);
            } else {
              // Call requestClose to start Tempo's grace period
              debugLog(`[SellerPayment] Channel ${session.sessionId.slice(0, 18)}... past deadline — calling requestClose`);
              try {
                await this._sessionsClient.requestClose(this._signer, session.sessionId);
              } catch {
                // May already have been requested — ignore
              }
            }
          }
        }
        // If deadline hasn't passed, skip — session is still active
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to process channel ${session.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── Queries ───────────────────────────────────────────────────

  hasSession(buyerPeerId: string): boolean {
    return this._activeBuyers.has(buyerPeerId);
  }

  /** Get the active session for a buyer peer, or null. */
  getSessionByPeer(buyerPeerId: string): StoredSession | null {
    return this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
  }

  /** Get total USDC spent for a session (sum of recordSpend calls). */
  getCumulativeSpend(sessionId: string): bigint {
    return this._spent.get(sessionId) ?? 0n;
  }

  /** Get the highest accepted cumulative amount for a session. */
  getAcceptedCumulative(sessionId: string): bigint {
    return this._acceptedCumulative.get(sessionId) ?? 0n;
  }

  private static readonly DEFAULT_SUGGESTED_AMOUNT = 100_000n; // $0.10

  /**
   * Build the PaymentRequired payload for a buyer that doesn't have a session.
   * Includes streamChannelAddress so the buyer can compute the Tempo voucher domain.
   */
  getPaymentRequirements(
    requestId: string,
    buyerPeerId?: string,
    pricing?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number },
  ): PaymentRequiredPayload {
    const sellerEvmAddr = identityToEvmAddress(this._identity);
    const minBudgetPerRequest = this._config.minBudgetPerRequest ?? DEFAULT_MIN_BUDGET_PER_REQUEST;

    let suggestedAmount = SellerPaymentManager.DEFAULT_SUGGESTED_AMOUNT;
    if (buyerPeerId) {
      const priorSession = this._sessionStore.getLatestSession(buyerPeerId, 'seller');
      if (priorSession && priorSession.status === 'settled') {
        // Returning buyer with proven history — could use a different amount
        // For now, use the same default; config can override later
        suggestedAmount = SellerPaymentManager.DEFAULT_SUGGESTED_AMOUNT;
      }
    }

    return {
      sellerEvmAddr,
      minBudgetPerRequest,
      suggestedAmount: suggestedAmount.toString(),
      requestId,
      streamChannelAddress: this._config.streamChannelAddress,
      ...(pricing?.inputUsdPerMillion != null ? { inputUsdPerMillion: pricing.inputUsdPerMillion } : {}),
      ...(pricing?.outputUsdPerMillion != null ? { outputUsdPerMillion: pricing.outputUsdPerMillion } : {}),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    // SessionStore is shared with BuyerPaymentManager, closed from node.ts
  }
}

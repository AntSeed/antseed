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
  SPENDING_AUTH_TYPES,
  makeSessionsDomain,
} from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { SessionStore, type StoredSession } from './session-store.js';

export interface SellerPaymentConfig {
  rpcUrl: string;
  sessionsContractAddress: string;
  chainId: number;
  dataDir: string;
  /** Minimum USDC per request (base units). Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Whether to immediately settle when buyer disconnects. Default: true. */
  settleOnDisconnect?: boolean;
}

/** Default minimum budget per request: $0.01 USDC (base units). */
const DEFAULT_MIN_BUDGET_PER_REQUEST = '10000';

/**
 * Manages seller-side payment sessions using cumulative streaming vouchers.
 * The buyer sends a SpendingAuth with a monotonically increasing cumulativeAmount
 * on every request. The seller tracks spending locally and settles once at session end.
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

  /** sessionId -> highest accepted cumulativeAmount from buyer's SpendingAuth */
  private readonly _acceptedCumulative = new Map<string, bigint>();

  /** sessionId -> total USDC spent so far (sum of recordSpend calls) */
  private readonly _spent = new Map<string, bigint>();

  /** sessionId -> latest buyer-signed SpendingAuth (sig + cumulative values) for settle() */
  private readonly _latestAuth = new Map<string, { buyerSig: string; cumulativeAmount: bigint; cumulativeInputTokens: bigint; cumulativeOutputTokens: bigint; nonce: bigint; deadline: bigint }>();

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

  // ── SpendingAuth handler (cumulative voucher model) ─────────

  /**
   * Handle incoming SpendingAuth from a buyer.
   * First auth: verify, reserve on-chain, send AuthAck.
   * Subsequent: verify, validate monotonic increase, persist.
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
      // 1. Verify EIP-712 signature
      const domain = makeSessionsDomain(this._config.chainId, this._config.sessionsContractAddress);
      const msg = {
        seller: identityToEvmAddress(this._identity),
        sessionId: payload.sessionId,
        cumulativeAmount: BigInt(payload.cumulativeAmount),
        cumulativeInputTokens: BigInt(payload.cumulativeInputTokens),
        cumulativeOutputTokens: BigInt(payload.cumulativeOutputTokens),
        nonce: payload.nonce,
        deadline: payload.deadline,
      };

      const recoveredAddr = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, payload.buyerSig);
      if (recoveredAddr.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
        debugWarn(`[SellerPayment] Invalid SpendingAuth signature: recovered=${recoveredAddr} expected=${buyerEvmAddr}`);
        return 'rejected';
      }

      debugLog(`[SellerPayment] SpendingAuth verified for buyer ${buyerPeerId.slice(0, 12)}...`);

      const sessionId = payload.sessionId;
      const cumulativeAmount = BigInt(payload.cumulativeAmount);
      const existingCumulative = this._acceptedCumulative.get(sessionId);

      if (existingCumulative === undefined) {
        // ── First SpendingAuth: reserve on-chain ──
        debugLog(`[SellerPayment] Reserving session ${sessionId.slice(0, 18)}... on-chain`);
        const reserveAmount = payload.reserveAmount ? BigInt(payload.reserveAmount) : cumulativeAmount;
        await this._sessionsClient.reserve(
          this._signer,
          buyerEvmAddr,
          sessionId,
          reserveAmount,
          BigInt(payload.nonce),
          BigInt(payload.deadline),
          payload.buyerSig,
        );

        // Store new session
        const now = Date.now();
        const sellerEvmAddr = identityToEvmAddress(this._identity);
        const session: StoredSession = {
          sessionId,
          peerId: buyerPeerId,
          role: 'seller',
          sellerEvmAddr,
          buyerEvmAddr,
          nonce: payload.nonce,
          authMax: payload.cumulativeAmount,
          deadline: payload.deadline,
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
        this._acceptedCumulative.set(sessionId, cumulativeAmount);
        this._spent.set(sessionId, 0n);
        this._latestAuth.set(sessionId, {
          buyerSig: payload.buyerSig,
          cumulativeAmount,
          cumulativeInputTokens: BigInt(payload.cumulativeInputTokens),
          cumulativeOutputTokens: BigInt(payload.cumulativeOutputTokens),
          nonce: BigInt(payload.nonce),
          deadline: BigInt(payload.deadline),
        });
        this._activeBuyers.add(buyerPeerId);

        // Send AuthAck
        paymentMux.sendAuthAck({
          sessionId,
          nonce: payload.nonce,
        });

        debugLog(`[SellerPayment] AuthAck sent for session ${sessionId.slice(0, 18)}...`);
        return 'reserved';
      } else {
        // ── Subsequent SpendingAuth: validate monotonic increase ──
        if (cumulativeAmount <= existingCumulative) {
          debugWarn(
            `[SellerPayment] Rejecting non-monotonic SpendingAuth: ` +
            `new=${cumulativeAmount} existing=${existingCumulative} session=${sessionId.slice(0, 18)}...`,
          );
          return 'rejected';
        }

        // Update tracking
        this._acceptedCumulative.set(sessionId, cumulativeAmount);
        this._latestAuth.set(sessionId, {
          buyerSig: payload.buyerSig,
          cumulativeAmount,
          cumulativeInputTokens: BigInt(payload.cumulativeInputTokens),
          cumulativeOutputTokens: BigInt(payload.cumulativeOutputTokens),
          nonce: BigInt(payload.nonce),
          deadline: BigInt(payload.deadline),
        });

        // Persist latest auth to SessionStore (authMax = latest cumulativeAmount)
        const session = this._sessionStore.getSession(sessionId);
        if (session) {
          session.authMax = payload.cumulativeAmount;
          session.updatedAt = Date.now();
          this._sessionStore.upsertSession(session);
        }

        debugLog(`[SellerPayment] Budget updated: session=${sessionId.slice(0, 18)}... cumulative=${cumulativeAmount}`);
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

    const sessionId = session.sessionId;
    const existingCumulative = this._acceptedCumulative.get(sessionId);
    if (existingCumulative === undefined) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: no tracked cumulative for session ${sessionId.slice(0, 18)}...`);
      return false;
    }

    // Verify EIP-712 signature
    const domain = makeSessionsDomain(this._config.chainId, this._config.sessionsContractAddress);
    const msg = {
      seller: identityToEvmAddress(this._identity),
      sessionId: auth.sessionId,
      cumulativeAmount: BigInt(auth.cumulativeAmount),
      cumulativeInputTokens: BigInt(auth.cumulativeInputTokens),
      cumulativeOutputTokens: BigInt(auth.cumulativeOutputTokens),
      nonce: auth.nonce,
      deadline: auth.deadline,
    };

    try {
      const recoveredAddr = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, auth.buyerSig);
      if (recoveredAddr.toLowerCase() !== auth.buyerEvmAddr.toLowerCase()) {
        debugWarn(`[SellerPayment] validateAndAcceptAuth: invalid signature`);
        return false;
      }
    } catch {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: signature verification failed`);
      return false;
    }

    const newCumulative = BigInt(auth.cumulativeAmount);

    // Check monotonic: strictly greater, or equal (idempotent retransmit)
    if (newCumulative < existingCumulative) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: cumulative decreased from ${existingCumulative} to ${newCumulative}`);
      return false;
    }

    // Update if strictly greater
    if (newCumulative > existingCumulative) {
      this._acceptedCumulative.set(sessionId, newCumulative);
      this._latestAuth.set(sessionId, {
        buyerSig: auth.buyerSig,
        cumulativeAmount: newCumulative,
        cumulativeInputTokens: BigInt(auth.cumulativeInputTokens),
        cumulativeOutputTokens: BigInt(auth.cumulativeOutputTokens),
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
      });

      // Persist latest auth to SessionStore
      const storedSession = this._sessionStore.getSession(sessionId);
      if (storedSession) {
        storedSession.authMax = auth.cumulativeAmount;
        storedSession.updatedAt = Date.now();
        this._sessionStore.upsertSession(storedSession);
      }
    }

    // Check available budget
    const accepted = this._acceptedCumulative.get(sessionId)!;
    const spent = this._spent.get(sessionId) ?? 0n;
    return accepted >= spent;
  }

  // ── Spend tracking ──────────────────────────────────────────

  /**
   * Record USDC consumption after serving a request.
   */
  recordSpend(sessionId: string, costUsdc: bigint): void {
    const current = this._spent.get(sessionId);
    if (current === undefined) {
      debugWarn(`[SellerPayment] recordSpend: unknown sessionId ${sessionId.slice(0, 18)}...`);
      return;
    }

    const newSpent = current + costUsdc;
    this._spent.set(sessionId, newSpent);

    // Persist spent amount to SessionStore (using tokensDelivered field)
    this._sessionStore.updateTokensDelivered(sessionId, newSpent.toString(), 0);
  }

  // ── Settlement ──────────────────────────────────────────────

  /**
   * Settle a completed session on-chain using the latest buyer-signed SpendingAuth.
   */
  async settleSession(buyerPeerId: string): Promise<void> {
    const session = this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
    if (!session) {
      debugWarn(`[SellerPayment] settleSession: no active session for buyer ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    const sessionId = session.sessionId;
    const accepted = this._acceptedCumulative.get(sessionId) ?? 0n;

    if (accepted === 0n) {
      // Session opened but no requests served — cannot call settleTimeout() here because
      // the contract requires deadline + CLOSE_GRACE_PERIOD to have passed.
      // Leave it for checkTimeouts() which validates the timeout threshold first.
      debugLog(`[SellerPayment] Zero-cumulative session ${sessionId.slice(0, 18)}... — deferring to timeout checker`);
    } else {
      // Settle with the latest buyer-signed auth
      const latestAuth = this._latestAuth.get(sessionId);
      if (!latestAuth || !latestAuth.buyerSig) {
        debugWarn(`[SellerPayment] No buyer signature stored for session ${sessionId.slice(0, 18)}... — cannot settle`);
        return;
      }
      debugLog(`[SellerPayment] Settling session ${sessionId.slice(0, 18)}... cumulative=${latestAuth.cumulativeAmount}`);
      try {
        await this._sessionsClient.settle(
          this._signer,
          sessionId,
          latestAuth.cumulativeAmount,
          latestAuth.cumulativeInputTokens,
          latestAuth.cumulativeOutputTokens,
          latestAuth.nonce,
          latestAuth.deadline,
          latestAuth.buyerSig,
        );
        this._sessionStore.updateSessionStatus(sessionId, 'settled', latestAuth.cumulativeAmount.toString());
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to settle session: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    // Clean up maps
    this._acceptedCumulative.delete(sessionId);
    this._spent.delete(sessionId);
    this._latestAuth.delete(sessionId);
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
        debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — settling immediately`);
        // Fire and forget settlement
        this.settleSession(buyerPeerId).catch((err) => {
          debugWarn(`[SellerPayment] Failed to settle on disconnect: ${err instanceof Error ? err.message : err}`);
        });
        return;
      }
    }

    // Preserve session for reconnect; timeout checker handles ghost scenarios
    this._activeBuyers.delete(buyerPeerId);
    debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — session ${session.sessionId.slice(0, 18)}... preserved for reconnect`);
  }

  // ── Timeout management ────────────────────────────────────────

  /**
   * Check for and settle timed-out sessions.
   * Called periodically and on startup for recovery.
   */
  async checkTimeouts(): Promise<void> {
    // Check all active sessions — use the session's actual deadline + CLOSE_GRACE_PERIOD (2h)
    // to determine if on-chain settleTimeout() will succeed, instead of a separate config timer.
    const CLOSE_GRACE_PERIOD_SECS = 2 * 60 * 60; // 2 hours — matches contract default
    const nowSecs = Math.floor(Date.now() / 1000);
    const activeSessions = this._sessionStore.getActiveSessions('seller');

    for (const session of activeSessions) {
      const deadline = session.deadline;
      const deadlinePlusGrace = deadline + CLOSE_GRACE_PERIOD_SECS;
      const accepted = this._acceptedCumulative.get(session.sessionId) ?? 0n;

      try {
        if (nowSecs >= deadlinePlusGrace) {
          // Past deadline + grace: settle() would revert (SessionExpired).
          // Must use settleTimeout() — releases full deposit, no payment to seller.
          debugLog(`[SellerPayment] Session ${session.sessionId.slice(0, 18)}... past grace period — calling settleTimeout`);
          await this._sessionsClient.settleTimeout(this._signer, session.sessionId);
          this._sessionStore.updateSessionStatus(session.sessionId, 'timeout');
          this._acceptedCumulative.delete(session.sessionId);
          this._spent.delete(session.sessionId);
          this._latestAuth.delete(session.sessionId);
          this._activeBuyers.delete(session.peerId);
        } else if (accepted > 0n) {
          // Before grace period but session has accepted cumulative.
          // Check if deadline is approaching — settle before it expires.
          const latestAuth = this._latestAuth.get(session.sessionId);
          const authDeadline = latestAuth ? Number(latestAuth.deadline) : deadline;
          if (nowSecs < authDeadline) {
            // Auth deadline still valid — settle to claim payment
            debugLog(`[SellerPayment] Session ${session.sessionId.slice(0, 18)}... settling before deadline (cumulative=${accepted})`);
            await this.settleSession(session.peerId);
          }
          // If auth deadline already passed, we can't settle — wait for grace period → settleTimeout
        }
        // If deadline hasn't passed and no accepted cumulative, skip — session is still active
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to process session ${session.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
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
   * Never returns null — no longer depends on on-chain data.
   * For returning buyers (proven history), uses the configured proven-sign amount.
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
      ...(pricing?.inputUsdPerMillion != null ? { inputUsdPerMillion: pricing.inputUsdPerMillion } : {}),
      ...(pricing?.outputUsdPerMillion != null ? { outputUsdPerMillion: pricing.outputUsdPerMillion } : {}),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    // SessionStore is shared with BuyerPaymentManager, closed from node.ts
  }
}

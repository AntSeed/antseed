import { createHash } from 'node:crypto';
import { type AbstractSigner, verifyTypedData } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  BuyerAckPayload,
} from '../types/protocol.js';
import { BaseEscrowClient } from './evm/escrow-client.js';
import { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
import {
  SPENDING_AUTH_TYPES,
  makeEscrowDomain,
  buildReceiptMessage,
  buildAckMessage,
  signMessageEd25519,
  verifyMessageEd25519,
} from './evm/signatures.js';
import { bytesToHex, hexToBytes } from '../utils/hex.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { SessionStore, type StoredSession } from './session-store.js';

export interface SellerPaymentConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress: string;
  chainId: number;
  dataDir: string;
  /** Timeout in seconds before a disconnected session is considered ghost. Default: 86400 (24h). */
  settleTimeoutSecs?: number;
}

/** Default settle timeout: 24 hours. */
const DEFAULT_SETTLE_TIMEOUT_SECS = 86400;

/**
 * Manages seller-side payment sessions using the settle-then-reserve
 * atomic flow with persistent session storage.
 */
export class SellerPaymentManager {
  private readonly _identity: Identity;
  private readonly _signer: AbstractSigner;
  private readonly _escrowClient: BaseEscrowClient;
  private readonly _config: SellerPaymentConfig;
  private readonly _sessionStore: SessionStore;
  /** In-memory cache of active buyer peerIds for fast has-session checks. */
  private readonly _activeBuyers = new Set<string>();

  constructor(identity: Identity, config: SellerPaymentConfig, sessionStore: SessionStore) {
    this._identity = identity;
    this._config = config;
    this._signer = identityToEvmWallet(identity);
    this._escrowClient = new BaseEscrowClient({
      rpcUrl: config.rpcUrl,
      contractAddress: config.contractAddress,
      usdcAddress: config.usdcAddress,
    });
    this._sessionStore = sessionStore;
  }

  get escrowClient(): BaseEscrowClient {
    return this._escrowClient;
  }

  // ── SpendingAuth handler (settle-then-reserve) ────────────────

  /**
   * Handle incoming SpendingAuth from a buyer.
   * 1. Verify EIP-712 signature
   * 2. Settle prior session if one exists
   * 3. Reserve new session on-chain
   * 4. Store and send AuthAck
   */
  async handleSpendingAuth(
    buyerPeerId: string,
    buyerEvmAddr: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    try {
      // 1. Verify EIP-712 signature
      const domain = makeEscrowDomain(this._config.chainId, this._config.contractAddress);
      const msg = {
        seller: identityToEvmAddress(this._identity),
        sessionId: payload.sessionId,
        maxAmount: BigInt(payload.maxAmountUsdc),
        nonce: payload.nonce,
        deadline: payload.deadline,
        previousConsumption: BigInt(payload.previousConsumption),
        previousSessionId: payload.previousSessionId,
      };

      const recoveredAddr = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, payload.buyerSig);
      if (recoveredAddr.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
        debugWarn(`[SellerPayment] Invalid SpendingAuth signature: recovered=${recoveredAddr} expected=${buyerEvmAddr}`);
        return;
      }

      debugLog(`[SellerPayment] SpendingAuth verified for buyer ${buyerPeerId.slice(0, 12)}...`);

      // 2. Settle prior session if exists
      const priorSession = this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
      if (priorSession && priorSession.status === 'active') {
        try {
          const prevConsumption = BigInt(payload.previousConsumption);
          debugLog(`[SellerPayment] Settling prior session ${priorSession.sessionId.slice(0, 18)}... tokens=${prevConsumption}`);
          await this._escrowClient.settle(this._signer, priorSession.sessionId, prevConsumption);
          this._sessionStore.updateSessionStatus(priorSession.sessionId, 'settled', prevConsumption.toString());
        } catch (err) {
          debugWarn(`[SellerPayment] Failed to settle prior session: ${err instanceof Error ? err.message : err}`);
          // Continue with reserve even if settle fails — the new auth itself
          // references previousConsumption for on-chain verification.
        }
      }

      // 3. Reserve new session on-chain
      const sellerEvmAddr = identityToEvmAddress(this._identity);
      debugLog(`[SellerPayment] Reserving session ${payload.sessionId.slice(0, 18)}... on-chain`);
      await this._escrowClient.reserve(
        this._signer,
        buyerEvmAddr,
        payload.sessionId,
        BigInt(payload.maxAmountUsdc),
        BigInt(payload.nonce),
        BigInt(payload.deadline),
        BigInt(payload.previousConsumption),
        payload.previousSessionId,
        payload.buyerSig,
      );

      // 4. Store new session
      const now = Date.now();
      const session: StoredSession = {
        sessionId: payload.sessionId,
        peerId: buyerPeerId,
        role: 'seller',
        sellerEvmAddr,
        buyerEvmAddr,
        nonce: payload.nonce,
        authMax: payload.maxAmountUsdc,
        deadline: payload.deadline,
        previousSessionId: payload.previousSessionId,
        previousConsumption: payload.previousConsumption,
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
      this._activeBuyers.add(buyerPeerId);

      // 5. Send AuthAck
      paymentMux.sendAuthAck({
        sessionId: payload.sessionId,
        nonce: payload.nonce,
      });

      debugLog(`[SellerPayment] AuthAck sent for session ${payload.sessionId.slice(0, 18)}...`);
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to process SpendingAuth: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Receipt sending ───────────────────────────────────────────

  /**
   * Send a bilateral receipt to the buyer after processing a request.
   * Also triggers TopUpRequest if consumption exceeds 80% of authMax.
   */
  async sendReceipt(
    buyerPeerId: string,
    paymentMux: PaymentMux,
    responseBody: Uint8Array,
    tokensDelivered: bigint,
  ): Promise<void> {
    const session = this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
    if (!session) {
      debugWarn(`[SellerPayment] No active session for buyer ${buyerPeerId.slice(0, 12)}... — skipping receipt`);
      return;
    }

    // Update tokens
    const newTotal = BigInt(session.tokensDelivered) + tokensDelivered;
    const newRequestCount = session.requestCount + 1;
    this._sessionStore.updateTokensDelivered(session.sessionId, newTotal.toString(), newRequestCount);

    // SHA-256 hash of response body
    const responseHash = createHash('sha256').update(responseBody).digest();

    // Build receipt message and sign with Ed25519
    const sessionIdBytes = hexToBytes(session.sessionId.replace(/^0x/, ''));
    const receiptMsg = buildReceiptMessage(
      sessionIdBytes,
      newTotal,
      newRequestCount,
      new Uint8Array(responseHash),
    );
    const sellerSig = await signMessageEd25519(this._identity, receiptMsg);

    paymentMux.sendSellerReceipt({
      sessionId: session.sessionId,
      runningTotal: newTotal.toString(),
      requestCount: newRequestCount,
      responseHash: bytesToHex(new Uint8Array(responseHash)),
      sellerSig: bytesToHex(sellerSig),
    });

    // Store receipt
    this._sessionStore.insertReceipt({
      sessionId: session.sessionId,
      runningTotal: newTotal.toString(),
      requestCount: newRequestCount,
      responseHash: bytesToHex(new Uint8Array(responseHash)),
      sellerSig: bytesToHex(sellerSig),
      buyerAckSig: null,
      createdAt: Date.now(),
    });

    debugLog(`[SellerPayment] Receipt sent: session=${session.sessionId.slice(0, 18)}... total=${newTotal} count=${newRequestCount}`);

    // TopUpRequest if > 80% consumed
    const authMax = BigInt(session.authMax);
    if (authMax > 0n && newTotal * 100n > authMax * 80n) {
      const additionalAmount = authMax; // Request same amount again
      paymentMux.sendTopUpRequest({
        sessionId: session.sessionId,
        currentUsed: newTotal.toString(),
        currentMax: authMax.toString(),
        requestedAdditional: additionalAmount.toString(),
      });
      debugLog(`[SellerPayment] TopUpRequest sent: session=${session.sessionId.slice(0, 18)}... (${newTotal}/${authMax})`);
    }
  }

  // ── BuyerAck handler ──────────────────────────────────────────

  async handleBuyerAck(buyerPeerId: string, payload: BuyerAckPayload): Promise<void> {
    const session = this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
    if (!session) {
      debugWarn(`[SellerPayment] BuyerAck for unknown buyer: ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    try {
      // Verify buyer's Ed25519 ack signature
      const buyerPublicKey = hexToBytes(buyerPeerId);
      const sessionIdBytes = hexToBytes(session.sessionId.replace(/^0x/, ''));
      const ackMsg = buildAckMessage(
        sessionIdBytes,
        BigInt(payload.runningTotal),
        payload.requestCount,
      );
      const sigBytes = hexToBytes(payload.buyerSig);
      const valid = await verifyMessageEd25519(buyerPublicKey, sigBytes, ackMsg);

      if (!valid) {
        debugWarn(`[SellerPayment] Invalid BuyerAck signature from ${buyerPeerId.slice(0, 12)}...`);
        return;
      }

      // Find the latest receipt for this session and store the ack
      const receipts = this._sessionStore.getReceipts(session.sessionId);
      const matchingReceipt = receipts.find(
        (r) => r.runningTotal === payload.runningTotal && r.requestCount === payload.requestCount,
      );
      if (matchingReceipt && matchingReceipt.id !== undefined) {
        this._sessionStore.updateReceiptAck(
          session.sessionId,
          payload.runningTotal,
          payload.requestCount,
          payload.buyerSig,
        );
      }

      debugLog(`[SellerPayment] BuyerAck received: session=${session.sessionId.slice(0, 18)}... count=${payload.requestCount} total=${payload.runningTotal}`);
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to process BuyerAck: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Disconnect handling ───────────────────────────────────────

  onBuyerDisconnect(buyerPeerId: string): void {
    const session = this._sessionStore.getActiveSessionByPeer(buyerPeerId, 'seller');
    if (!session) return;

    // Don't settle immediately — wait for buyer to return with next auth.
    // Session persists in store; timeout checker will handle ghost scenarios.
    this._activeBuyers.delete(buyerPeerId);
    debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — session ${session.sessionId.slice(0, 18)}... preserved for reconnect`);
  }

  // ── Timeout management ────────────────────────────────────────

  /**
   * Check for and settle timed-out sessions.
   * Called periodically and on startup for recovery.
   */
  async checkTimeouts(): Promise<void> {
    const timeoutSecs = this._config.settleTimeoutSecs ?? DEFAULT_SETTLE_TIMEOUT_SECS;
    const timedOut = this._sessionStore.getTimedOutSessions(timeoutSecs);

    for (const session of timedOut) {
      if (session.status !== 'active') continue;

      try {
        debugLog(`[SellerPayment] Settling timed-out session ${session.sessionId.slice(0, 18)}...`);
        await this._escrowClient.settleTimeout(this._signer, session.sessionId);
        this._sessionStore.updateSessionStatus(session.sessionId, 'timeout');
        this._activeBuyers.delete(session.peerId);
        debugLog(`[SellerPayment] Timed-out session ${session.sessionId.slice(0, 18)}... settled`);
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to settle timeout for ${session.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── Queries ───────────────────────────────────────────────────

  hasSession(buyerPeerId: string): boolean {
    return this._activeBuyers.has(buyerPeerId);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    // SessionStore is shared with BuyerPaymentManager, closed from node.ts
  }
}

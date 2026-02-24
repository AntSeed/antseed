import { randomBytes } from 'node:crypto';
import { type AbstractSigner, Wallet } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SessionLockConfirmPayload,
  SessionLockRejectPayload,
  SellerReceiptPayload,
  TopUpRequestPayload,
} from '../types/protocol.js';
import { BaseEscrowClient } from './evm/escrow-client.js';
import { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
import {
  buildLockMessageHash,
  buildSettlementMessageHash,
  buildExtendLockMessageHash,
  signMessageEcdsa,
  buildAckMessage,
  signMessageEd25519,
} from './evm/signatures.js';
import { bytesToHex, hexToBytes } from '../utils/hex.js';
import { debugLog, debugWarn } from '../utils/debug.js';

export interface BuyerPaymentConfig {
  /** Default lock amount in USDC base units (6 decimals). e.g. "1000000" = 1 USDC */
  defaultLockAmountUSDC: string;
  /** Base JSON-RPC endpoint */
  rpcUrl: string;
  /** Deployed AntseedEscrow contract address */
  contractAddress: string;
  /** USDC token contract address */
  usdcAddress: string;
  /** Auto-acknowledge seller receipts. Default: true */
  autoAck?: boolean;
  /** Auto-approve top-up requests. Default: true */
  autoTopUp?: boolean;
  /** Maximum total amount the buyer will commit per session (USDC base units). Default: "10000000" (10 USDC) */
  maxSessionBudgetUSDC?: string;
}

export type BuyerSessionStatus = 'pending' | 'confirmed' | 'active' | 'ending' | 'ended';

export interface BuyerSessionState {
  sessionId: string;
  sellerPeerId: string;
  sellerEvmAddress: string;
  lockedAmount: bigint;
  status: BuyerSessionStatus;
  txSignature: string | null;
  lastRunningTotal: bigint;
  lastRequestCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Manages buyer-side bilateral payment sessions across seller connections.
 *
 * Handles the full lifecycle: lock initiation, receipt acknowledgement,
 * top-up approval, and session settlement.
 */
export class BuyerPaymentManager {
  private readonly _identity: Identity;
  private _signer: AbstractSigner;
  private readonly _escrowClient: BaseEscrowClient;
  private readonly _config: BuyerPaymentConfig;
  private readonly _sessions = new Map<string, BuyerSessionState>();

  constructor(identity: Identity, config: BuyerPaymentConfig) {
    this._identity = identity;
    this._config = config;
    this._signer = identityToEvmWallet(identity);
    this._escrowClient = new BaseEscrowClient({
      rpcUrl: config.rpcUrl,
      contractAddress: config.contractAddress,
      usdcAddress: config.usdcAddress,
    });
  }

  get signer(): AbstractSigner {
    return this._signer;
  }

  /** @deprecated Use .signer instead */
  get wallet(): Wallet {
    return this._signer as Wallet;
  }

  /** Replace the signer at runtime (e.g. with a WalletConnect signer). */
  setSigner(signer: AbstractSigner): void {
    this._signer = signer;
  }

  get escrowClient(): BaseEscrowClient {
    return this._escrowClient;
  }

  /** Get a snapshot of all active sessions. */
  getActiveSessions(): BuyerSessionState[] {
    return [...this._sessions.values()].filter(
      (s) => s.status !== 'ended',
    );
  }

  /** Get the session for a given seller peer, if it exists. */
  getSession(sellerPeerId: string): BuyerSessionState | undefined {
    return this._sessions.get(sellerPeerId);
  }

  // ── Lock initiation ─────────────────────────────────────────────

  /**
   * Generate a session ID, sign a lock authorization, and send it
   * to the seller via PaymentMux.
   */
  async initiateLock(
    sellerPeerId: string,
    sellerEvmAddress: string,
    paymentMux: PaymentMux,
    lockAmount?: string,
  ): Promise<string> {
    const amount = lockAmount ?? this._config.defaultLockAmountUSDC;
    const amountBigInt = BigInt(amount);

    // Generate a 32-byte session ID as 0x-prefixed hex (bytes32)
    const sessionIdBytes = randomBytes(32);
    const sessionId = '0x' + sessionIdBytes.toString('hex');

    debugLog(`[BuyerPayment] Initiating lock: session=${sessionId.slice(0, 18)}... seller=${sellerPeerId.slice(0, 12)}... amount=${amount}`);

    // Sign the lock message with ECDSA (for on-chain verification)
    const messageHash = buildLockMessageHash(sessionId, sellerEvmAddress, amountBigInt);
    const buyerSig = await signMessageEcdsa(this._signer, messageHash);

    // Store session state
    const now = Date.now();
    const session: BuyerSessionState = {
      sessionId,
      sellerPeerId,
      sellerEvmAddress,
      lockedAmount: amountBigInt,
      status: 'pending',
      txSignature: null,
      lastRunningTotal: 0n,
      lastRequestCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this._sessions.set(sellerPeerId, session);

    // Send the lock auth message
    paymentMux.sendSessionLockAuth({
      sessionId,
      lockedAmount: amount,
      buyerSig,
    });

    return sessionId;
  }

  // ── Lock confirmation / rejection handlers ──────────────────────

  /**
   * Called when the seller confirms the lock was committed on-chain.
   */
  handleLockConfirm(sellerPeerId: string, payload: SessionLockConfirmPayload): void {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] Lock confirm for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }
    if (session.sessionId !== payload.sessionId) {
      debugWarn(`[BuyerPayment] Lock confirm session mismatch: expected=${session.sessionId.slice(0, 18)}... got=${payload.sessionId.slice(0, 18)}...`);
      return;
    }

    session.status = 'confirmed';
    session.txSignature = payload.txSignature;
    session.updatedAt = Date.now();
    debugLog(`[BuyerPayment] Lock confirmed: session=${session.sessionId.slice(0, 18)}... tx=${payload.txSignature.slice(0, 12)}...`);
  }

  /**
   * Called when the seller rejects the lock.
   */
  handleLockReject(sellerPeerId: string, payload: SessionLockRejectPayload): void {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] Lock reject for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    debugWarn(`[BuyerPayment] Lock rejected: session=${session.sessionId.slice(0, 18)}... reason=${payload.reason}`);
    this._sessions.delete(sellerPeerId);
  }

  // ── Receipt handling ────────────────────────────────────────────

  /**
   * Handle a running-total receipt from the seller.
   * If autoAck is enabled, automatically counter-sign and send BuyerAck.
   */
  async handleSellerReceipt(
    sellerPeerId: string,
    receipt: SellerReceiptPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] Receipt for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    if (session.status === 'confirmed') {
      session.status = 'active';
    }

    // Update running total
    session.lastRunningTotal = BigInt(receipt.runningTotal);
    session.lastRequestCount = receipt.requestCount;
    session.updatedAt = Date.now();

    debugLog(`[BuyerPayment] Receipt: session=${session.sessionId.slice(0, 18)}... total=${receipt.runningTotal} count=${receipt.requestCount}`);

    const autoAck = this._config.autoAck ?? true;
    if (autoAck) {
      // Build ack message and sign with Ed25519
      const sessionIdBytes = hexToBytes(session.sessionId.startsWith('0x') ? session.sessionId.slice(2) : session.sessionId);
      const ackMsg = buildAckMessage(
        sessionIdBytes,
        BigInt(receipt.runningTotal),
        receipt.requestCount,
      );
      const sigBytes = await signMessageEd25519(this._identity, ackMsg);
      const buyerSig = bytesToHex(sigBytes);

      paymentMux.sendBuyerAck({
        sessionId: session.sessionId,
        runningTotal: receipt.runningTotal,
        requestCount: receipt.requestCount,
        buyerSig,
      });

      debugLog(`[BuyerPayment] Auto-ack sent for session=${session.sessionId.slice(0, 18)}...`);
    }
  }

  // ── Top-up handling ─────────────────────────────────────────────

  /**
   * Handle a top-up request from the seller.
   * If autoTopUp is enabled and budget allows, sign and send TopUpAuth.
   * Otherwise, end the session.
   */
  async handleTopUpRequest(
    sellerPeerId: string,
    request: TopUpRequestPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] Top-up for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    const additionalAmount = BigInt(request.additionalAmount);
    const maxBudget = BigInt(this._config.maxSessionBudgetUSDC ?? '10000000');
    const newTotal = session.lockedAmount + additionalAmount;
    const autoTopUp = this._config.autoTopUp ?? true;

    debugLog(`[BuyerPayment] Top-up request: session=${session.sessionId.slice(0, 18)}... additional=${request.additionalAmount} newTotal=${newTotal}`);

    if (autoTopUp && newTotal <= maxBudget) {
      // Check on-chain balance
      const buyerAddr = identityToEvmAddress(this._identity);
      const account = await this._escrowClient.getBuyerAccount(buyerAddr);
      if (account.available >= additionalAmount) {
        // Sign extend-lock authorization
        const messageHash = buildExtendLockMessageHash(
          session.sessionId,
          session.sellerEvmAddress,
          additionalAmount,
        );
        const buyerSig = await signMessageEcdsa(this._signer, messageHash);

        session.lockedAmount = newTotal;
        session.updatedAt = Date.now();

        paymentMux.sendTopUpAuth({
          sessionId: session.sessionId,
          additionalAmount: request.additionalAmount,
          buyerSig,
        });

        debugLog(`[BuyerPayment] Top-up authorized: session=${session.sessionId.slice(0, 18)}...`);
        return;
      }

      debugWarn(`[BuyerPayment] Insufficient balance for top-up. Available=${account.available}, requested=${additionalAmount}`);
    }

    // Cannot or will not top up — end the session
    debugLog(`[BuyerPayment] Declining top-up, ending session=${session.sessionId.slice(0, 18)}...`);
    await this.endSession(sellerPeerId, paymentMux, 80);
  }

  // ── Session end ─────────────────────────────────────────────────

  /**
   * End a session with the given seller. Signs a settlement message
   * with ECDSA and sends SessionEnd.
   */
  async endSession(
    sellerPeerId: string,
    paymentMux: PaymentMux,
    score: number = 80,
  ): Promise<void> {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] Cannot end session for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    if (session.status === 'ending' || session.status === 'ended') {
      return;
    }

    session.status = 'ending';
    session.updatedAt = Date.now();

    debugLog(`[BuyerPayment] Ending session=${session.sessionId.slice(0, 18)}... total=${session.lastRunningTotal} score=${score}`);

    // Sign settlement message with ECDSA
    const messageHash = buildSettlementMessageHash(
      session.sessionId,
      session.lastRunningTotal,
      score,
    );
    const buyerSig = await signMessageEcdsa(this._signer, messageHash);

    paymentMux.sendSessionEnd({
      sessionId: session.sessionId,
      runningTotal: session.lastRunningTotal.toString(),
      requestCount: session.lastRequestCount,
      score,
      buyerSig,
    });

    session.status = 'ended';
    session.updatedAt = Date.now();
    debugLog(`[BuyerPayment] Session ended: ${session.sessionId.slice(0, 18)}...`);
  }

  // ── Escrow operations ───────────────────────────────────────────

  /**
   * Deposit USDC into the escrow contract.
   * @param amount Amount in USDC base units (6 decimals).
   */
  async deposit(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Depositing ${amount} to escrow`);
    return this._escrowClient.deposit(this._signer, amount);
  }

  /**
   * Withdraw USDC from the escrow contract.
   * @param amount Amount in USDC base units (6 decimals).
   */
  async withdraw(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Withdrawing ${amount} from escrow`);
    return this._escrowClient.withdraw(this._signer, amount);
  }

  /**
   * Get the buyer's on-chain escrow balance.
   */
  async getBalance(): Promise<{ deposited: bigint; committed: bigint; available: bigint }> {
    const buyerAddr = identityToEvmAddress(this._identity);
    return this._escrowClient.getBuyerAccount(buyerAddr);
  }

  // ── Dispute helpers ─────────────────────────────────────────────

  /**
   * Release an expired lock (buyer reclaims funds).
   */
  async releaseExpiredLock(sessionId: string): Promise<string> {
    debugLog(`[BuyerPayment] Releasing expired lock: session=${sessionId.slice(0, 18)}...`);
    return this._escrowClient.releaseExpiredLock(this._signer, sessionId);
  }

  /**
   * Respond to a dispute opened by the seller.
   */
  async respondToDispute(sessionId: string): Promise<string> {
    debugLog(`[BuyerPayment] Responding to dispute: session=${sessionId.slice(0, 18)}...`);
    return this._escrowClient.respondDispute(this._signer, sessionId);
  }

  /**
   * Check if a session lock has been confirmed (for polling).
   */
  isLockConfirmed(sellerPeerId: string): boolean {
    const session = this._sessions.get(sellerPeerId);
    return session?.status === 'confirmed' || session?.status === 'active';
  }

  /**
   * Check if a session lock has been rejected (for polling).
   */
  isLockRejected(sellerPeerId: string): boolean {
    return !this._sessions.has(sellerPeerId);
  }
}

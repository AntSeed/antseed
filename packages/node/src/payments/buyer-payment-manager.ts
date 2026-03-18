import { randomBytes } from 'node:crypto';
import { type AbstractSigner, encodeBytes32String } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  AuthAckPayload,
  SellerReceiptPayload,
  TopUpRequestPayload,
} from '../types/protocol.js';
import { BaseEscrowClient } from './evm/escrow-client.js';
import { IdentityClient } from './evm/identity-client.js';
import { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
import {
  signSpendingAuth,
  makeEscrowDomain,
  buildAckMessage,
  signMessageEd25519,
  verifyMessageEd25519,
  buildReceiptMessage,
} from './evm/signatures.js';
import type { SpendingAuthMessage } from './evm/signatures.js';
import { bytesToHex, hexToBytes } from '../utils/hex.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { SessionStore, type StoredSession } from './session-store.js';

export interface BuyerPaymentConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress: string;
  identityAddress: string;
  chainId: number;
  defaultMaxAmountUsdc: bigint;
  defaultAuthDurationSecs: number;
  autoAck: boolean;
  dataDir: string;
}

const ZERO_SESSION_ID = '0x' + '0'.repeat(64);

/**
 * Manages buyer-side payment sessions using EIP-712 SpendingAuth
 * with persistent session storage.
 */
export class BuyerPaymentManager {
  private readonly _identity: Identity;
  private _signer: AbstractSigner;
  private readonly _escrowClient: BaseEscrowClient;
  private readonly _config: BuyerPaymentConfig;
  private readonly _sessionStore: SessionStore;
  /** In-memory map of active confirmed sessions by seller peerId for fast lookups. */
  private readonly _confirmedPeers = new Set<string>();
  private _nonceCounter: number;

  constructor(identity: Identity, config: BuyerPaymentConfig, sessionStore: SessionStore) {
    this._identity = identity;
    this._config = config;
    this._signer = identityToEvmWallet(identity);
    this._escrowClient = new BaseEscrowClient({
      rpcUrl: config.rpcUrl,
      contractAddress: config.contractAddress,
      usdcAddress: config.usdcAddress,
    });
    this._sessionStore = sessionStore;

    // Restore nonce counter from persisted sessions to avoid duplicates across restarts
    this._nonceCounter = sessionStore.getMaxNonce('buyer');
  }

  get signer(): AbstractSigner {
    return this._signer;
  }

  setSigner(signer: AbstractSigner): void {
    this._signer = signer;
  }

  get escrowClient(): BaseEscrowClient {
    return this._escrowClient;
  }

  // ── Spending Authorization ────────────────────────────────────

  /**
   * Sign and send an EIP-712 SpendingAuth to a seller.
   * Loads the latest session to build the proof chain.
   */
  async authorizeSpending(
    sellerPeerId: string,
    sellerEvmAddr: string,
    paymentMux: PaymentMux,
    maxAmount?: bigint,
  ): Promise<string> {
    const amount = maxAmount ?? this._config.defaultMaxAmountUsdc;

    // Load latest session to build proof chain
    const latestSession = this._sessionStore.getLatestSession(sellerPeerId, 'buyer');
    const previousConsumption = latestSession
      ? BigInt(latestSession.tokensDelivered)
      : 0n;
    const previousSessionId = latestSession
      ? latestSession.sessionId
      : ZERO_SESSION_ID;

    // Generate a 32-byte session ID
    const sessionIdBytes = randomBytes(32);
    const sessionId = '0x' + sessionIdBytes.toString('hex');

    const nonce = ++this._nonceCounter;
    const deadline = Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;

    debugLog(`[BuyerPayment] authorizeSpending: session=${sessionId.slice(0, 18)}... seller=${sellerPeerId.slice(0, 12)}... amount=${amount}`);

    // Sign EIP-712 SpendingAuth
    const domain = makeEscrowDomain(this._config.chainId, this._config.contractAddress);
    const msg: SpendingAuthMessage = {
      seller: sellerEvmAddr,
      sessionId,
      maxAmount: amount,
      nonce,
      deadline,
      previousConsumption,
      previousSessionId,
    };
    const buyerSig = await signSpendingAuth(this._signer, domain, msg);
    const buyerEvmAddr = identityToEvmAddress(this._identity);

    // Store session
    const now = Date.now();
    const session: StoredSession = {
      sessionId,
      peerId: sellerPeerId,
      role: 'buyer',
      sellerEvmAddr,
      buyerEvmAddr,
      nonce,
      authMax: amount.toString(),
      deadline,
      previousSessionId,
      previousConsumption: previousConsumption.toString(),
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

    // Send SpendingAuth via PaymentMux
    paymentMux.sendSpendingAuth({
      sessionId,
      maxAmountUsdc: amount.toString(),
      nonce,
      deadline,
      buyerSig,
      buyerEvmAddr,
      previousConsumption: previousConsumption.toString(),
      previousSessionId,
    });

    return sessionId;
  }

  // ── AuthAck handler ───────────────────────────────────────────

  handleAuthAck(sellerPeerId: string, payload: AuthAckPayload): void {
    const session = this._sessionStore.getActiveSessionByPeer(sellerPeerId, 'buyer');
    if (!session) {
      debugWarn(`[BuyerPayment] AuthAck for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }
    if (session.sessionId !== payload.sessionId) {
      debugWarn(`[BuyerPayment] AuthAck session mismatch: expected=${session.sessionId.slice(0, 18)}... got=${payload.sessionId.slice(0, 18)}...`);
      return;
    }

    this._confirmedPeers.add(sellerPeerId);
    debugLog(`[BuyerPayment] AuthAck confirmed: session=${session.sessionId.slice(0, 18)}...`);
  }

  // ── Seller Receipt handler ────────────────────────────────────

  async handleSellerReceipt(
    sellerPeerId: string,
    receipt: SellerReceiptPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this._sessionStore.getActiveSessionByPeer(sellerPeerId, 'buyer');
    if (!session) {
      debugWarn(`[BuyerPayment] Receipt for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    // Verify seller's Ed25519 signature
    try {
      const sellerPublicKey = hexToBytes(sellerPeerId);
      const sessionIdBytes = hexToBytes(receipt.sessionId.replace(/^0x/, ''));
      const responseHashBytes = hexToBytes(receipt.responseHash);
      const receiptMsg = buildReceiptMessage(
        sessionIdBytes,
        BigInt(receipt.runningTotal),
        receipt.requestCount,
        responseHashBytes,
      );
      const sigBytes = hexToBytes(receipt.sellerSig);
      const valid = await verifyMessageEd25519(sellerPublicKey, sigBytes, receiptMsg);
      if (!valid) {
        debugWarn(`[BuyerPayment] Invalid seller receipt signature from ${sellerPeerId.slice(0, 12)}...`);
        return;
      }
    } catch (err) {
      debugWarn(`[BuyerPayment] Failed to verify receipt: ${err instanceof Error ? err.message : err}`);
      return;
    }

    // Validate monotonic increase: runningTotal must exceed previous
    const newTotal = BigInt(receipt.runningTotal);
    const prevTotal = BigInt(session.tokensDelivered);
    if (newTotal <= prevTotal) {
      debugWarn(`[BuyerPayment] Receipt runningTotal not monotonic: new=${newTotal} prev=${prevTotal}`);
      return;
    }

    // Validate receipt doesn't exceed authorized max
    const authMax = BigInt(session.authMax);
    if (newTotal > authMax) {
      debugWarn(`[BuyerPayment] Receipt runningTotal ${newTotal} exceeds authMax ${authMax}`);
      return;
    }

    // Update tokens delivered
    this._sessionStore.updateTokensDelivered(
      session.sessionId,
      receipt.runningTotal,
      receipt.requestCount,
    );

    debugLog(`[BuyerPayment] Receipt: session=${session.sessionId.slice(0, 18)}... total=${receipt.runningTotal} count=${receipt.requestCount}`);

    // Store receipt
    this._sessionStore.insertReceipt({
      sessionId: session.sessionId,
      runningTotal: receipt.runningTotal,
      requestCount: receipt.requestCount,
      responseHash: receipt.responseHash,
      sellerSig: receipt.sellerSig,
      buyerAckSig: null,
      createdAt: Date.now(),
    });

    // Auto-ack if configured
    if (this._config.autoAck) {
      const sessionIdBytes = hexToBytes(session.sessionId.replace(/^0x/, ''));
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

  // ── TopUp handler ─────────────────────────────────────────────

  async handleTopUpRequest(
    sellerPeerId: string,
    request: TopUpRequestPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this._sessionStore.getActiveSessionByPeer(sellerPeerId, 'buyer');
    if (!session) {
      debugWarn(`[BuyerPayment] Top-up for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    debugLog(`[BuyerPayment] TopUp request: session=${session.sessionId.slice(0, 18)}... currentUsed=${request.currentUsed} currentMax=${request.currentMax}`);

    // Sign a new SpendingAuth with increased cap
    const currentMax = BigInt(session.authMax);
    const additionalAmount = BigInt(request.requestedAdditional);
    const newMax = currentMax + additionalAmount;

    // The new auth embeds the current consumption as previousConsumption
    await this.authorizeSpending(
      sellerPeerId,
      session.sellerEvmAddr,
      paymentMux,
      newMax,
    );

    debugLog(`[BuyerPayment] TopUp authorized: new auth sent with max=${newMax}`);
  }

  // ── Queries ───────────────────────────────────────────────────

  isAuthorized(sellerPeerId: string): boolean {
    return this._confirmedPeers.has(sellerPeerId);
  }

  /** Check if a session has been confirmed (for polling). */
  isLockConfirmed(sellerPeerId: string): boolean {
    return this._confirmedPeers.has(sellerPeerId);
  }

  /** Check if no session exists (lock was rejected or never sent). */
  isLockRejected(sellerPeerId: string): boolean {
    const session = this._sessionStore.getActiveSessionByPeer(sellerPeerId, 'buyer');
    return !session;
  }

  getSessionHistory(sellerPeerId: string): StoredSession[] {
    // Return all sessions for this peer
    const sessions: StoredSession[] = [];
    let session = this._sessionStore.getLatestSession(sellerPeerId, 'buyer');
    while (session) {
      sessions.unshift(session);
      if (session.previousSessionId === ZERO_SESSION_ID) break;
      session = this._sessionStore.getSession(session.previousSessionId);
    }
    return sessions;
  }

  // ── Escrow operations ─────────────────────────────────────────

  async deposit(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Depositing ${amount} to escrow`);
    return this._escrowClient.deposit(this._signer, amount);
  }

  async withdraw(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Requesting withdrawal of ${amount} from escrow`);
    return this._escrowClient.requestWithdrawal(this._signer, amount);
  }

  async getBalance(): Promise<{ available: bigint; reserved: bigint }> {
    const buyerAddr = identityToEvmAddress(this._identity);
    const info = await this._escrowClient.getBuyerBalance(buyerAddr);
    return { available: info.available, reserved: info.reserved };
  }

  // ── Feedback (Task 6) ─────────────────────────────────────────

  async submitFeedback(
    sellerPeerId: string,
    qualityScore: number,
    identityClient: IdentityClient,
  ): Promise<string | null> {
    const session = this._sessionStore.getLatestSession(sellerPeerId, 'buyer');
    if (!session || session.status !== 'settled') return null;

    const tokenId = await identityClient.getTokenId(session.sellerEvmAddr);
    const tag = encodeBytes32String('quality');
    return identityClient.submitFeedback(this._signer, tokenId, qualityScore, tag);
  }

}

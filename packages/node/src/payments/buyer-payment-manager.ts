import { randomBytes } from 'node:crypto';
import { type AbstractSigner, Wallet } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  AuthAckPayload,
  TopUpRequestPayload,
  SellerReceiptPayload,
  BuyerAckPayload,
} from '../types/protocol.js';
import { EscrowClient } from './evm/escrow-client.js';
import { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
import {
  makeEscrowDomain,
  signSpendingAuth,
  buildAckMessage,
  signMessageEd25519,
} from './evm/signatures.js';
import { bytesToHex, hexToBytes } from '../utils/hex.js';
import { debugLog, debugWarn } from '../utils/debug.js';

export interface BuyerPaymentConfig {
  /** Chain ID for EIP-712 domain (8453 = Base mainnet, 84532 = Base Sepolia) */
  chainId: number;
  /** Base JSON-RPC endpoint */
  rpcUrl: string;
  /** Deployed AntseedEscrow contract address */
  contractAddress: string;
  /** USDC token contract address */
  usdcAddress: string;
  /**
   * Default SpendingAuth cap per session (USDC base units, 6 dec).
   * Default: 2_000_000 (2 USDC)
   */
  defaultAuthAmountUsdc?: bigint;
  /**
   * Auth validity window in seconds.
   * Default: 3600 (1 hour)
   */
  defaultAuthDurationSecs?: number;
  /**
   * Automatically approve TopUpRequests up to this total signed exposure per session.
   * Exposure is tracked as: initial auth cap + all approved top-up caps.
   * Default: 10_000_000 (10 USDC). Set to 0 to disable auto top-up.
   */
  maxSessionBudgetUsdc?: bigint;
  /** Auto-acknowledge seller receipts. Default: true */
  autoAck?: boolean;
}

export interface SellerSession {
  sessionId:     string;   // 0x-prefixed 32-byte hex
  sellerPeerId:  string;
  sellerEvmAddr: string;
  nonce:         number;   // current auth nonce
  authMax:       bigint;   // current auth cap
  /** Cumulative max exposure signed so far (initial auth + all top-ups). */
  authorizedCapTotal: bigint;
  deadline:      number;   // current auth expiry (unix secs)
  authorized:    boolean;  // has seller ack'd?
  totalSpend:    bigint;   // cumulative charged this session (from receipts)
  requestCount:  number;
  createdAt:     number;
  updatedAt:     number;
}

/**
 * Manages buyer-side spending authorizations under the pull-payment model.
 *
 * Lifecycle:
 *   1. authorizeSpending()     — sign + send SpendingAuth (0x50)
 *   2. handleAuthAck()         — mark session as authorized
 *   3. handleTopUpRequest()    — re-sign + send new SpendingAuth (nonce+1)
 *   4. handleSellerReceipt()   — update local counters, optionally send BuyerAck
 *   5. onPeerDisconnect()      — clean up session state
 */
export class BuyerPaymentManager {
  private readonly _identity: Identity;
  private _signer: AbstractSigner;
  private readonly _escrow: EscrowClient;
  private readonly _config: BuyerPaymentConfig;
  private readonly _sessions = new Map<string, SellerSession>(); // keyed by sellerPeerId

  constructor(identity: Identity, config: BuyerPaymentConfig) {
    this._identity = identity;
    this._config   = config;
    this._signer   = identityToEvmWallet(identity);
    this._escrow   = new EscrowClient({
      rpcUrl:          config.rpcUrl,
      contractAddress: config.contractAddress,
      usdcAddress:     config.usdcAddress,
      chainId:         config.chainId,
    });
  }

  get signer(): AbstractSigner { return this._signer; }

  /** @deprecated Use .signer instead */
  get wallet(): Wallet { return this._signer as Wallet; }

  /** Replace the signer at runtime (e.g. with a WalletConnect signer). */
  setSigner(signer: AbstractSigner): void {
    this._signer = signer;
  }

  get escrowClient(): EscrowClient { return this._escrow; }

  getActiveSessions(): SellerSession[] {
    return [...this._sessions.values()];
  }

  getSession(sellerPeerId: string): SellerSession | undefined {
    return this._sessions.get(sellerPeerId);
  }

  async authorizeSpending(
    sellerPeerId:   string,
    sellerEvmAddr:  string,
    paymentMux:     PaymentMux,
    maxAmountUsdc?: bigint,
  ): Promise<string> {
    const maxAmount    = maxAmountUsdc ?? this._config.defaultAuthAmountUsdc ?? 2_000_000n;
    const durationSecs = this._config.defaultAuthDurationSecs ?? 3600;
    const sessionId    = '0x' + randomBytes(32).toString('hex');
    const nonce        = 1;
    const deadline     = Math.floor(Date.now() / 1000) + durationSecs;

    debugLog(`[BuyerPayment] Authorizing: session=${sessionId.slice(0, 18)}... seller=${sellerPeerId.slice(0, 12)}... max=${maxAmount}`);

    const sig = await signSpendingAuth(
      this._signer,
      makeEscrowDomain(this._config.chainId, this._config.contractAddress),
      { seller: sellerEvmAddr, sessionId, maxAmount, nonce, deadline },
    );

    const now = Date.now();
    this._sessions.set(sellerPeerId, {
      sessionId,
      sellerPeerId,
      sellerEvmAddr,
      nonce,
      authMax:      maxAmount,
      authorizedCapTotal: maxAmount,
      deadline,
      authorized:   false,
      totalSpend:   0n,
      requestCount: 0,
      createdAt:    now,
      updatedAt:    now,
    });

    paymentMux.sendSpendingAuth({
      sessionId,
      maxAmountUsdc: maxAmount.toString(),
      nonce,
      deadline,
      buyerSig: sig,
      buyerEvmAddr: identityToEvmAddress(this._identity),
    });

    return sessionId;
  }

  handleAuthAck(sellerPeerId: string, payload: AuthAckPayload): void {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] AuthAck for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }
    if (payload.nonce !== session.nonce) {
      debugWarn(`[BuyerPayment] AuthAck nonce mismatch: expected=${session.nonce} got=${payload.nonce}`);
      return;
    }
    session.authorized = true;
    session.updatedAt  = Date.now();
    debugLog(`[BuyerPayment] Authorized: session=${session.sessionId.slice(0, 18)}... nonce=${payload.nonce}`);
  }

  async handleTopUpRequest(
    sellerPeerId: string,
    request:      TopUpRequestPayload,
    paymentMux:   PaymentMux,
  ): Promise<void> {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] TopUpRequest for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    let requested: bigint;
    let sellerReportedUsed: bigint;
    try {
      requested = BigInt(request.requestedAdditional);
      sellerReportedUsed = BigInt(request.currentUsed);
    } catch {
      debugWarn(`[BuyerPayment] Invalid TopUpRequest amounts for seller ${sellerPeerId.slice(0, 12)}...`);
      return;
    }
    if (requested <= 0n) {
      debugWarn(`[BuyerPayment] Rejecting non-positive top-up request (${requested})`);
      return;
    }

    if (request.sessionId !== session.sessionId) {
      debugWarn(
        `[BuyerPayment] TopUpRequest session mismatch: expected=${session.sessionId.slice(0, 12)}... got=${request.sessionId.slice(0, 12)}...`,
      );
      return;
    }

    const maxBudget      = this._config.maxSessionBudgetUsdc ?? 10_000_000n;
    const projectedExposure = session.authorizedCapTotal + requested;

    debugLog(
      `[BuyerPayment] TopUp: session=${session.sessionId.slice(0, 18)}... requested=${requested} reportedUsed=${sellerReportedUsed} projectedExposure=${projectedExposure}`,
    );

    // Enforce budget against cumulative signed exposure instead of seller-reported usage.
    if (maxBudget > 0n && projectedExposure > maxBudget) {
      debugWarn(`[BuyerPayment] TopUp would exceed session budget (${projectedExposure} > ${maxBudget}), declining`);
      return;
    }

    const buyerAddr = identityToEvmAddress(this._identity);
    const balance   = await this._escrow.getBuyerBalance(buyerAddr);
    if (balance.available < requested) {
      debugWarn(`[BuyerPayment] Insufficient balance for top-up: have=${balance.available} need=${requested}`);
      return;
    }

    const newNonce     = session.nonce + 1;
    const durationSecs = this._config.defaultAuthDurationSecs ?? 3600;
    const deadline     = Math.floor(Date.now() / 1000) + durationSecs;

    const sig = await signSpendingAuth(
      this._signer,
      makeEscrowDomain(this._config.chainId, this._config.contractAddress),
      {
        seller:    session.sellerEvmAddr,
        sessionId: session.sessionId,
        maxAmount: requested,
        nonce:     newNonce,
        deadline,
      },
    );

    session.nonce     = newNonce;
    session.authMax   = requested;
    session.authorizedCapTotal = projectedExposure;
    session.deadline  = deadline;
    session.updatedAt = Date.now();

    paymentMux.sendSpendingAuth({
      sessionId:     session.sessionId,
      maxAmountUsdc: requested.toString(),
      nonce:         newNonce,
      deadline,
      buyerSig:      sig,
      buyerEvmAddr:  identityToEvmAddress(this._identity),
    });

    debugLog(`[BuyerPayment] TopUp sent: nonce=${newNonce} amount=${requested}`);
  }

  async handleSellerReceipt(
    sellerPeerId: string,
    receipt:      SellerReceiptPayload,
    paymentMux:   PaymentMux,
  ): Promise<void> {
    const session = this._sessions.get(sellerPeerId);
    if (!session) {
      debugWarn(`[BuyerPayment] Receipt for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    session.totalSpend   = BigInt(receipt.runningTotal);
    session.requestCount = receipt.requestCount;
    session.updatedAt    = Date.now();

    debugLog(`[BuyerPayment] Receipt: session=${session.sessionId.slice(0, 18)}... total=${receipt.runningTotal} count=${receipt.requestCount}`);

    if (!(this._config.autoAck ?? true)) return;

    const sessionIdHex  = session.sessionId.startsWith('0x') ? session.sessionId.slice(2) : session.sessionId;
    const sessionIdBytes = hexToBytes(sessionIdHex);
    const ackMsg    = buildAckMessage(sessionIdBytes, BigInt(receipt.runningTotal), receipt.requestCount);
    const sigBytes  = await signMessageEd25519(this._identity, ackMsg);

    const ack: BuyerAckPayload = {
      sessionId:    session.sessionId,
      runningTotal: receipt.runningTotal,
      requestCount: receipt.requestCount,
      buyerSig:     bytesToHex(sigBytes),
    };
    paymentMux.sendBuyerAck(ack);
    debugLog(`[BuyerPayment] Auto-ack sent: session=${session.sessionId.slice(0, 18)}...`);
  }

  onPeerDisconnect(sellerPeerId: string): void {
    const session = this._sessions.get(sellerPeerId);
    if (session) {
      debugLog(`[BuyerPayment] Peer disconnected: session=${session.sessionId.slice(0, 18)}...`);
      this._sessions.delete(sellerPeerId);
    }
  }

  // ── On-chain helpers ──────────────────────────────────────────────────────

  async deposit(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Depositing ${amount}`);
    return this._escrow.deposit(this._signer, amount);
  }

  async requestWithdrawal(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Requesting withdrawal ${amount}`);
    return this._escrow.requestWithdrawal(this._signer, amount);
  }

  async executeWithdrawal(): Promise<string> {
    debugLog(`[BuyerPayment] Executing withdrawal`);
    return this._escrow.executeWithdrawal(this._signer);
  }

  async cancelWithdrawal(): Promise<string> {
    debugLog(`[BuyerPayment] Cancelling withdrawal`);
    return this._escrow.cancelWithdrawal(this._signer);
  }

  async getBalance(): Promise<{ available: bigint; pendingWithdrawal: bigint; withdrawalReadyAt: number }> {
    const addr = identityToEvmAddress(this._identity);
    return this._escrow.getBuyerBalance(addr);
  }

  isAuthorized(sellerPeerId: string): boolean {
    return this._sessions.get(sellerPeerId)?.authorized ?? false;
  }
}

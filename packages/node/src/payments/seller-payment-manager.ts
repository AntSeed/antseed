import { type AbstractSigner } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  TopUpRequestPayload,
} from '../types/protocol.js';
import { EscrowClient } from './evm/escrow-client.js';
import { identityToEvmWallet } from './evm/keypair.js';
import { makeEscrowDomain, SPENDING_AUTH_TYPES } from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { verifyTypedData } from 'ethers';

export interface SellerPaymentConfig {
  /** Chain ID for EIP-712 domain */
  chainId: number;
  /** Base JSON-RPC endpoint */
  rpcUrl: string;
  /** Deployed AntseedEscrow contract address */
  contractAddress: string;
  /** USDC token contract address */
  usdcAddress: string;
  /**
   * Batch pending charges and submit when this threshold is reached (USDC base units).
   * Default: 100_000 (0.10 USDC)
   */
  chargeThresholdUsdc?: bigint;
  /**
   * Tighter threshold used when buyer balance is below signed auth max.
   * Reduces unpaid exposure for obviously underfunded authorizations.
   * Default: 10_000 (0.01 USDC)
   */
  underfundedChargeThresholdUsdc?: bigint;
  /**
   * Request a top-up when authUsed / authMax exceeds this ratio (0-1).
   * Default: 0.80
   */
  topUpThreshold?: number;
  /**
   * Poll interval for on-chain pending-withdrawal checks per active auth.
   * When a pending withdrawal is detected, seller flushes any pending charge
   * immediately (ignoring batch threshold).
   * Default: 15_000 ms.
   */
  pendingWithdrawalPollMs?: number;
  /**
   * Suggested cap for each top-up request (USDC base units).
   * Default: same as the original authMax from the first SpendingAuth.
   */
  topUpAmountUsdc?: bigint;
}

export interface BuyerAuth {
  sessionId:     string;
  buyerPeerId:   string;
  buyerEvmAddr:  string;
  nonce:         number;
  authMax:       bigint;
  authUsed:      bigint;   // locally tracked (optimistic)
  deadline:      number;
  buyerSig:      string;
  pendingCharge:   bigint;   // accumulated charges not yet submitted on-chain
  requestCount:    number;
  chargeInFlight:  boolean;  // true while a charge() tx is in-flight
  chargeThreshold: bigint;   // per-session batching threshold
}

/**
 * Manages seller-side charge submission under the pull-payment model.
 *
 * Lifecycle:
 *   1. handleSpendingAuth()    — validate EIP-712 sig, send AuthAck (0x51)
 *   2. chargeForRequest()      — accumulate cost; submit on-chain when threshold hit
 *   3. checkAndRequestTopUp()  — send TopUpRequest (0x55) when near cap
 *   4. onBuyerDisconnect()     — flush any pending charge on-chain
 */
export class SellerPaymentManager {
  private _signer: AbstractSigner;
  private readonly _escrow: EscrowClient;
  private readonly _config: SellerPaymentConfig;
  // buyerPeerId -> sessionId -> auth
  private readonly _auths = new Map<string, Map<string, BuyerAuth>>();
  private readonly _withdrawalWatchers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly _chargeThreshold: bigint;
  private readonly _underfundedChargeThreshold: bigint;
  private readonly _topUpThreshold: number;
  private readonly _pendingWithdrawalPollMs: number;

  constructor(identity: Identity, config: SellerPaymentConfig) {
    this._config = config;
    this._signer = identityToEvmWallet(identity);
    this._escrow = new EscrowClient({
      rpcUrl:          config.rpcUrl,
      contractAddress: config.contractAddress,
      usdcAddress:     config.usdcAddress,
      chainId:         config.chainId,
    });
    this._chargeThreshold = config.chargeThresholdUsdc ?? 100_000n;
    this._underfundedChargeThreshold = config.underfundedChargeThresholdUsdc ?? 10_000n;
    this._topUpThreshold  = config.topUpThreshold ?? 0.80;
    this._pendingWithdrawalPollMs = config.pendingWithdrawalPollMs ?? 15_000;
  }

  get signer(): AbstractSigner { return this._signer; }
  get escrowClient(): EscrowClient { return this._escrow; }

  hasAuth(buyerPeerId: string, sessionId?: string): boolean {
    const sessions = this._auths.get(buyerPeerId);
    if (!sessions) return false;
    if (sessionId) return sessions.has(sessionId);
    return sessions.size > 0;
  }

  setBuyerEvmAddress(buyerPeerId: string, evmAddress: string, sessionId?: string): void {
    const sessions = this._auths.get(buyerPeerId);
    if (!sessions) return;
    if (sessionId) {
      const auth = sessions.get(sessionId);
      if (auth) auth.buyerEvmAddr = evmAddress;
      return;
    }
    for (const auth of sessions.values()) {
      auth.buyerEvmAddr = evmAddress;
    }
  }

  async handleSpendingAuth(
    buyerPeerId:  string,
    buyerEvmAddr: string,
    payload:      SpendingAuthPayload,
    paymentMux:   PaymentMux,
  ): Promise<void> {
    if (!Number.isInteger(payload.nonce) || payload.nonce <= 0) {
      debugWarn(`[SellerPayment] Rejecting SpendingAuth with invalid nonce=${payload.nonce} from ${buyerPeerId.slice(0, 12)}...`);
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(payload.deadline) || payload.deadline <= now) {
      debugWarn(`[SellerPayment] Rejecting expired SpendingAuth from ${buyerPeerId.slice(0, 12)}... deadline=${payload.deadline} now=${now}`);
      return;
    }

    let maxAmount: bigint;
    try {
      maxAmount = BigInt(payload.maxAmountUsdc);
    } catch {
      debugWarn(`[SellerPayment] Rejecting SpendingAuth with invalid maxAmount from ${buyerPeerId.slice(0, 12)}...`);
      return;
    }
    if (maxAmount <= 0n) {
      debugWarn(`[SellerPayment] Rejecting SpendingAuth with non-positive maxAmount=${maxAmount}`);
      return;
    }

    const sellerAddr = await this._signer.getAddress();
    const domain     = makeEscrowDomain(this._config.chainId, this._config.contractAddress);

    const recovered = verifyTypedData(
      domain,
      SPENDING_AUTH_TYPES,
      {
        seller:    sellerAddr,
        sessionId: payload.sessionId,
        maxAmount,
        nonce:     payload.nonce,
        deadline:  payload.deadline,
      },
      payload.buyerSig,
    );

    if (recovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
      debugWarn(
        `[SellerPayment] Invalid SpendingAuth sig from ${buyerPeerId.slice(0, 12)}...` +
        ` recovered=${recovered.slice(0, 10)}... expected=${buyerEvmAddr.slice(0, 10)}...`,
      );
      return;
    }

    // Soft balance check — warn if buyer's on-chain balance is below the requested cap.
    // Hard rejection is not used: the contract enforces balance at charge() time, and a
    // TOCTOU race makes a hard check unreliable. For underfunded auths we reduce the
    // per-session batching threshold to limit unpaid work exposure.
    let chargeThreshold = this._chargeThreshold;
    try {
      const bal = await this._escrow.getBuyerBalance(buyerEvmAddr);
      if (bal.available < maxAmount) {
        chargeThreshold = this._underfundedChargeThreshold < this._chargeThreshold
          ? this._underfundedChargeThreshold
          : this._chargeThreshold;
        debugWarn(
          `[SellerPayment] Buyer ${buyerEvmAddr.slice(0, 10)}... balance ${bal.available} < authMax ${maxAmount} — using tighter charge threshold ${chargeThreshold}`,
        );
      }
    } catch (err) {
      debugWarn(`[SellerPayment] Could not fetch buyer balance for auth check: ${err}`);
    }

    const existing = this._getAuth(buyerPeerId, payload.sessionId);
    if (existing && payload.nonce === existing.nonce + 1) {
      // Flush any sub-threshold pending charges under the old auth before advancing nonce.
      // Without this, charges that haven't yet reached the batch threshold are permanently lost.
      if (existing.pendingCharge > 0n && !existing.chargeInFlight) {
        try {
          await this._submitCharge(existing);
        } catch (err) {
          debugWarn(`[SellerPayment] Failed to flush pending charges before top-up: ${err}`);
          return;
        }
      }
      if (existing.pendingCharge > 0n || existing.chargeInFlight) {
        debugWarn(`[SellerPayment] Rejecting top-up while pending charge flush is incomplete`);
        return;
      }
      // Top-up: advance nonce and reset authUsed
      existing.nonce          = payload.nonce;
      existing.authMax        = maxAmount;
      existing.authUsed       = 0n;
      existing.deadline       = payload.deadline;
      existing.buyerSig       = payload.buyerSig;
      existing.chargeThreshold = chargeThreshold;
      debugLog(`[SellerPayment] Top-up auth accepted: nonce=${payload.nonce} max=${maxAmount}`);
    } else if (existing && payload.nonce === existing.nonce) {
      if (maxAmount !== existing.authMax) {
        debugWarn(`[SellerPayment] Rejecting auth refresh with changed maxAmount: expected=${existing.authMax} got=${maxAmount}`);
        return;
      }
      existing.deadline = payload.deadline;
      existing.buyerSig = payload.buyerSig;
      existing.chargeThreshold = chargeThreshold;
      debugLog(`[SellerPayment] Auth refresh accepted: nonce=${payload.nonce}`);
    } else if (existing) {
      debugWarn(
        `[SellerPayment] Rejecting SpendingAuth nonce jump for ${buyerPeerId.slice(0, 12)}... expected=${existing.nonce} or ${existing.nonce + 1}, got=${payload.nonce}`,
      );
      return;
    } else {
      // Initial auth
      if (payload.nonce !== 1) {
        debugWarn(`[SellerPayment] Rejecting initial SpendingAuth with nonce=${payload.nonce} (expected 1)`);
        return;
      }
      this._setAuth(buyerPeerId, {
        sessionId:     payload.sessionId,
        buyerPeerId,
        buyerEvmAddr,
        nonce:         payload.nonce,
        authMax:       maxAmount,
        authUsed:      0n,
        deadline:      payload.deadline,
        buyerSig:      payload.buyerSig,
        pendingCharge:  0n,
        requestCount:   0,
        chargeInFlight: false,
        chargeThreshold,
      });
      this._startPendingWithdrawalWatcher(buyerPeerId, payload.sessionId);
      debugLog(
        `[SellerPayment] Auth accepted: session=${payload.sessionId.slice(0, 18)}... nonce=${payload.nonce} max=${maxAmount} threshold=${chargeThreshold}`,
      );
    }

    const ack: AuthAckPayload = { sessionId: payload.sessionId, nonce: payload.nonce };
    paymentMux.sendAuthAck(ack);
  }

  async chargeForRequest(
    buyerPeerId: string,
    sessionId:   string,
    costUsdc:    bigint,
    paymentMux:  PaymentMux,
  ): Promise<void> {
    if (costUsdc === 0n) return;

    const auth = this._getAuth(buyerPeerId, sessionId);
    if (!auth) {
      debugWarn(
        `[SellerPayment] No auth for buyer ${buyerPeerId.slice(0, 12)}... session=${sessionId.slice(0, 12)}... — cannot charge`,
      );
      return;
    }

    auth.authUsed      += costUsdc;
    auth.pendingCharge += costUsdc;
    auth.requestCount  += 1;

    debugLog(`[SellerPayment] Accrued ${costUsdc} for ${buyerPeerId.slice(0, 12)}... pending=${auth.pendingCharge}`);

    if (!auth.chargeInFlight && auth.pendingCharge >= auth.chargeThreshold) {
      await this._submitCharge(auth);
    }

    this._maybeRequestTopUp(auth, paymentMux);
  }

  checkAndRequestTopUp(buyerPeerId: string, sessionId: string, paymentMux: PaymentMux): void {
    const auth = this._getAuth(buyerPeerId, sessionId);
    if (auth) this._maybeRequestTopUp(auth, paymentMux);
  }

  async onBuyerDisconnect(buyerPeerId: string): Promise<void> {
    const sessions = this._auths.get(buyerPeerId);
    if (!sessions || sessions.size === 0) return;

    for (const auth of sessions.values()) {
      this._stopPendingWithdrawalWatcher(buyerPeerId, auth.sessionId);
      if (auth.pendingCharge > 0n) {
        debugLog(
          `[SellerPayment] Flushing ${auth.pendingCharge} on disconnect for ${buyerPeerId.slice(0, 12)}... session=${auth.sessionId.slice(0, 12)}...`,
        );
        try {
          await this._submitCharge(auth);
        } catch (err) {
          debugWarn(`[SellerPayment] Flush failed for ${buyerPeerId.slice(0, 12)}... session=${auth.sessionId.slice(0, 12)}...: ${err}`);
        }
      }
    }

    this._auths.delete(buyerPeerId);
  }

  async claimEarnings(): Promise<string> {
    debugLog(`[SellerPayment] Claiming earnings`);
    return this._escrow.claimEarnings(this._signer);
  }

  async stake(amount: bigint): Promise<string> {
    debugLog(`[SellerPayment] Staking ${amount}`);
    return this._escrow.stake(this._signer, amount);
  }

  async unstake(amount: bigint): Promise<string> {
    debugLog(`[SellerPayment] Unstaking ${amount}`);
    return this._escrow.unstake(this._signer, amount);
  }

  async getPendingEarnings(): Promise<bigint> {
    const addr = await this._signer.getAddress();
    return this._escrow.getSellerPendingEarnings(addr);
  }

  private _maybeRequestTopUp(auth: BuyerAuth, paymentMux: PaymentMux): void {
    if (auth.authMax === 0n) return;
    const ratio = Number(auth.authUsed) / Number(auth.authMax);
    if (ratio < this._topUpThreshold) return;

    const requested = (this._config.topUpAmountUsdc ?? auth.authMax).toString();
    debugLog(`[SellerPayment] Requesting top-up: used=${auth.authUsed} max=${auth.authMax} ratio=${ratio.toFixed(2)}`);

    const topUp: TopUpRequestPayload = {
      sessionId:           auth.sessionId,
      currentUsed:         auth.authUsed.toString(),
      currentMax:          auth.authMax.toString(),
      requestedAdditional: requested,
    };
    paymentMux.sendTopUpRequest(topUp);
  }

  private _getAuth(buyerPeerId: string, sessionId: string): BuyerAuth | undefined {
    return this._auths.get(buyerPeerId)?.get(sessionId);
  }

  private _setAuth(buyerPeerId: string, auth: BuyerAuth): void {
    let sessions = this._auths.get(buyerPeerId);
    if (!sessions) {
      sessions = new Map<string, BuyerAuth>();
      this._auths.set(buyerPeerId, sessions);
    }
    const previous = sessions.get(auth.sessionId);
    if (previous && previous !== auth) {
      this._stopPendingWithdrawalWatcher(buyerPeerId, auth.sessionId);
    }
    sessions.set(auth.sessionId, auth);
  }

  private _watcherKey(buyerPeerId: string, sessionId: string): string {
    return `${buyerPeerId}:${sessionId}`;
  }

  private _startPendingWithdrawalWatcher(buyerPeerId: string, sessionId: string): void {
    if (this._pendingWithdrawalPollMs <= 0) return;
    const key = this._watcherKey(buyerPeerId, sessionId);
    if (this._withdrawalWatchers.has(key)) return;

    const timer = setInterval(() => {
      const auth = this._getAuth(buyerPeerId, sessionId);
      if (!auth || auth.pendingCharge === 0n || auth.chargeInFlight) return;
      void this._flushOnPendingWithdrawal(auth);
    }, this._pendingWithdrawalPollMs);

    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    this._withdrawalWatchers.set(key, timer);
  }

  private _stopPendingWithdrawalWatcher(buyerPeerId: string, sessionId: string): void {
    const key = this._watcherKey(buyerPeerId, sessionId);
    const timer = this._withdrawalWatchers.get(key);
    if (!timer) return;
    clearInterval(timer);
    this._withdrawalWatchers.delete(key);
  }

  private async _flushOnPendingWithdrawal(auth: BuyerAuth): Promise<void> {
    try {
      const bal = await this._escrow.getBuyerBalance(auth.buyerEvmAddr);
      if (bal.pendingWithdrawal === 0n) return;
      if (auth.pendingCharge === 0n || auth.chargeInFlight) return;
      debugLog(
        `[SellerPayment] Pending withdrawal detected for ${auth.buyerPeerId.slice(0, 12)}... session=${auth.sessionId.slice(0, 12)}..., flushing ${auth.pendingCharge}`,
      );
      await this._submitCharge(auth);
    } catch (err) {
      debugWarn(`[SellerPayment] Pending-withdrawal flush failed: ${err}`);
    }
  }

  private async _submitCharge(auth: BuyerAuth): Promise<void> {
    const amount = auth.pendingCharge;
    if (amount === 0n) return;

    // Optimistically reset and mark in-flight before the async call to prevent
    // concurrent callers from double-submitting the same pending balance.
    auth.pendingCharge  = 0n;
    auth.chargeInFlight = true;

    try {
      const txHash = await this._escrow.charge(
        this._signer,
        auth.buyerEvmAddr,
        amount,
        auth.sessionId,
        auth.authMax,
        auth.nonce,
        auth.deadline,
        auth.buyerSig,
      );
      debugLog(`[SellerPayment] Charged ${amount} on-chain: tx=${txHash.slice(0, 12)}...`);
    } catch (err) {
      // Restore pending on failure so the next call can retry.
      auth.pendingCharge += amount;
      throw err;
    } finally {
      auth.chargeInFlight = false;
    }
  }
}

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
   * Request a top-up when authUsed / authMax exceeds this ratio (0-1).
   * Default: 0.80
   */
  topUpThreshold?: number;
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
  private readonly _auths = new Map<string, BuyerAuth>(); // keyed by buyerPeerId
  private readonly _chargeThreshold: bigint;
  private readonly _topUpThreshold: number;

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
    this._topUpThreshold  = config.topUpThreshold ?? 0.80;
  }

  get signer(): AbstractSigner { return this._signer; }
  get escrowClient(): EscrowClient { return this._escrow; }

  setBuyerEvmAddress(buyerPeerId: string, evmAddress: string): void {
    const auth = this._auths.get(buyerPeerId);
    if (auth) auth.buyerEvmAddr = evmAddress;
  }

  async handleSpendingAuth(
    buyerPeerId:  string,
    buyerEvmAddr: string,
    payload:      SpendingAuthPayload,
    paymentMux:   PaymentMux,
  ): Promise<void> {
    const sellerAddr = await this._signer.getAddress();
    const domain     = makeEscrowDomain(this._config.chainId, this._config.contractAddress);
    const maxAmount  = BigInt(payload.maxAmountUsdc);

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

    const existing = this._auths.get(buyerPeerId);
    if (existing && payload.nonce === existing.nonce + 1) {
      // Top-up: advance nonce and reset authUsed
      existing.nonce         = payload.nonce;
      existing.authMax       = maxAmount;
      existing.authUsed      = 0n;
      existing.deadline      = payload.deadline;
      existing.buyerSig      = payload.buyerSig;
      existing.pendingCharge  = 0n;
      existing.chargeInFlight = false;
      debugLog(`[SellerPayment] Top-up auth accepted: nonce=${payload.nonce} max=${maxAmount}`);
    } else {
      // Initial auth
      this._auths.set(buyerPeerId, {
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
      });
      debugLog(`[SellerPayment] Auth accepted: session=${payload.sessionId.slice(0, 18)}... nonce=${payload.nonce} max=${maxAmount}`);
    }

    const ack: AuthAckPayload = { sessionId: payload.sessionId, nonce: payload.nonce };
    paymentMux.sendAuthAck(ack);
  }

  async chargeForRequest(
    buyerPeerId: string,
    costUsdc:    bigint,
    paymentMux:  PaymentMux,
  ): Promise<void> {
    if (costUsdc === 0n) return;

    const auth = this._auths.get(buyerPeerId);
    if (!auth) {
      debugWarn(`[SellerPayment] No auth for buyer ${buyerPeerId.slice(0, 12)}... — cannot charge`);
      return;
    }

    auth.authUsed      += costUsdc;
    auth.pendingCharge += costUsdc;
    auth.requestCount  += 1;

    debugLog(`[SellerPayment] Accrued ${costUsdc} for ${buyerPeerId.slice(0, 12)}... pending=${auth.pendingCharge}`);

    if (!auth.chargeInFlight && auth.pendingCharge >= this._chargeThreshold) {
      await this._submitCharge(auth);
    }

    this._maybeRequestTopUp(auth, paymentMux);
  }

  checkAndRequestTopUp(buyerPeerId: string, paymentMux: PaymentMux): void {
    const auth = this._auths.get(buyerPeerId);
    if (auth) this._maybeRequestTopUp(auth, paymentMux);
  }

  async onBuyerDisconnect(buyerPeerId: string): Promise<void> {
    const auth = this._auths.get(buyerPeerId);
    if (!auth) return;

    if (auth.pendingCharge > 0n) {
      debugLog(`[SellerPayment] Flushing ${auth.pendingCharge} on disconnect for ${buyerPeerId.slice(0, 12)}...`);
      try {
        await this._submitCharge(auth);
      } catch (err) {
        debugWarn(`[SellerPayment] Flush failed for ${buyerPeerId.slice(0, 12)}...: ${err}`);
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

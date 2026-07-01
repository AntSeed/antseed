import type { ChainGateway, HeadroomInfo } from './chain.js';
import type { MeridianClient } from './meridian.js';
import type { TopupRow, TopupStore } from './store.js';
import type { TopupLimits } from './config.js';
import {
  buildPaymentRequirements,
  topupId,
  verifyPaymentSignature,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from './x402.js';

export type RejectCode =
  | 'invalid_request'
  | 'wrong_network'
  | 'wrong_recipient'
  | 'invalid_signature'
  | 'authorization_expired'
  | 'authorization_not_yet_valid'
  | 'authorization_reused'
  | 'amount_mismatch'
  | 'buyer_mismatch'
  | 'amount_too_low'
  | 'amount_too_high'
  | 'credit_limit_reached';

export type QuoteResult =
  | {
      ok: true;
      amount: bigint;
      minTopup: bigint;
      maxTopup: bigint;
      headroom: HeadroomInfo;
      requirements: X402PaymentRequirements;
    }
  | { ok: false; code: RejectCode; message: string; details?: Record<string, string> };

export type TopupOutcome =
  /** Funds settled and credited to the buyer's deposit account. */
  | { kind: 'deposited'; row: TopupRow }
  /** Funds settled but could not be credited — returned to the payer. */
  | { kind: 'refunded'; row: TopupRow }
  /** Outcome not yet final — safe to retry the same request later. */
  | { kind: 'pending'; row: TopupRow; message: string }
  /** Rejected before any funds moved. Nothing was persisted. */
  | { kind: 'rejected'; code: RejectCode; message: string; details?: Record<string, string> }
  /** Terminal failure with a persisted record. */
  | { kind: 'failed'; row: TopupRow; code: 'settlement_failed' | 'needs_review'; message: string };

export interface TopupX402Context {
  network: string;
  asset: string;
  assetName: string;
  assetVersion: string;
  facilitator: string;
  resourceUrl: string;
  evmChainId: number;
}

export interface TopupServiceDeps {
  store: TopupStore;
  chain: ChainGateway;
  meridian: MeridianClient;
  x402: TopupX402Context;
  limits: TopupLimits;
  log?: (message: string) => void;
  /** Unix seconds clock, injectable for tests. */
  now?: () => number;
}

const BPS_DENOMINATOR = 10_000n;

/** Smallest gross amount whose worst-case net (after `feeBps`) still meets `min`. */
export function grossUpForFees(min: bigint, feeBps: number): bigint {
  const keep = BPS_DENOMINATOR - BigInt(feeBps);
  return (min * BPS_DENOMINATOR + keep - 1n) / keep;
}

export class TopupService {
  private readonly _deps: TopupServiceDeps;
  private readonly _locks = new Map<string, Promise<unknown>>();

  constructor(deps: TopupServiceDeps) {
    this._deps = deps;
  }

  private _now(): number {
    return this._deps.now ? this._deps.now() : Math.floor(Date.now() / 1000);
  }

  private _log(message: string): void {
    (this._deps.log ?? ((m: string) => console.log(m)))(`[topup] ${message}`);
  }

  getTopup(id: string): TopupRow | null {
    return this._deps.store.get(id);
  }

  /**
   * Compute the acceptable top-up bounds for a buyer and build the x402
   * payment requirements. Bounds account for the on-chain credit limit
   * (deposits above it revert) and gross up the first-deposit minimum for
   * worst-case facilitator fees.
   */
  async quote(buyer: string, requested?: bigint): Promise<QuoteResult> {
    const { chain, limits, x402 } = this._deps;
    const headroom = await chain.getHeadroom(buyer);
    const maxTopup =
      limits.maxTopupAmount > 0n && limits.maxTopupAmount < headroom.headroom
        ? limits.maxTopupAmount
        : headroom.headroom;
    const firstDepositMin =
      headroom.balanceTotal === 0n ? grossUpForFees(headroom.minBuyerDeposit, limits.maxSettleFeeBps) : 0n;
    const minTopup = firstDepositMin > limits.minTopupAmount ? firstDepositMin : limits.minTopupAmount;

    const bounds = { minTopup: minTopup.toString(), maxTopup: maxTopup.toString() };
    if (maxTopup <= 0n || minTopup > maxTopup) {
      return {
        ok: false,
        code: 'credit_limit_reached',
        message:
          `Buyer ${buyer} has no deposit headroom (balance ${headroom.balanceTotal}, ` +
          `credit limit ${headroom.creditLimit}). Spend down or wait for the credit limit to grow.`,
        details: bounds,
      };
    }
    const amount = requested ?? maxTopup;
    if (amount < minTopup) {
      return { ok: false, code: 'amount_too_low', message: `Minimum top-up is ${minTopup} base units`, details: bounds };
    }
    if (amount > maxTopup) {
      return { ok: false, code: 'amount_too_high', message: `Maximum top-up is ${maxTopup} base units`, details: bounds };
    }
    return {
      ok: true,
      amount,
      minTopup,
      maxTopup,
      headroom,
      requirements: buildPaymentRequirements(
        { ...x402, creditedRecipient: chain.relayerAddress, resourceUrl: x402.resourceUrl },
        buyer,
        amount,
      ),
    };
  }

  /** Serialize processing per payment id — retries of an in-flight payment wait, not race. */
  private _withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this._locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const guard: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this._locks.get(id) === guard) this._locks.delete(id);
    });
    this._locks.set(id, guard);
    return run;
  }

  async submitPayment(params: {
    payload: X402PaymentPayload;
    buyer: string;
    requestedAmount?: bigint;
  }): Promise<TopupOutcome> {
    const id = topupId(params.payload.payload.signature);
    return this._withLock(id, () => this._submitPayment(id, params));
  }

  private async _submitPayment(
    id: string,
    params: { payload: X402PaymentPayload; buyer: string; requestedAmount?: bigint },
  ): Promise<TopupOutcome> {
    const { store, chain, x402, limits } = this._deps;
    const { payload, buyer, requestedAmount } = params;
    const auth = payload.payload.authorization;

    if (payload.network !== x402.network) {
      return {
        kind: 'rejected',
        code: 'wrong_network',
        message: `Payment network "${payload.network}" does not match "${x402.network}"`,
      };
    }
    if (auth.to.toLowerCase() !== x402.facilitator.toLowerCase()) {
      return {
        kind: 'rejected',
        code: 'wrong_recipient',
        message: `authorization.to must be the Meridian facilitator ${x402.facilitator}`,
      };
    }
    if (!verifyPaymentSignature(payload, x402)) {
      return { kind: 'rejected', code: 'invalid_signature', message: 'EIP-3009 signature does not recover to authorization.from' };
    }
    const now = this._now();
    if (BigInt(auth.validAfter) > BigInt(now)) {
      return { kind: 'rejected', code: 'authorization_not_yet_valid', message: 'authorization.validAfter is in the future' };
    }
    if (BigInt(auth.validBefore) < BigInt(now + limits.minValiditySeconds)) {
      return {
        kind: 'rejected',
        code: 'authorization_expired',
        message: `authorization.validBefore must be at least ${limits.minValiditySeconds}s away`,
      };
    }
    const value = BigInt(auth.value);
    if (requestedAmount !== undefined && requestedAmount !== value) {
      return {
        kind: 'rejected',
        code: 'amount_mismatch',
        message: `authorization.value ${value} does not match requested amount ${requestedAmount}`,
      };
    }

    const existing = store.get(id);
    if (existing) {
      if (existing.buyer.toLowerCase() !== buyer.toLowerCase()) {
        return {
          kind: 'rejected',
          code: 'buyer_mismatch',
          message: `This payment was already submitted for buyer ${existing.buyer}`,
        };
      }
      return this._resume(existing);
    }

    const quoteCheck = await this.quote(buyer, value);
    if (!quoteCheck.ok) {
      return { kind: 'rejected', code: quoteCheck.code, message: quoteCheck.message, details: quoteCheck.details };
    }
    if (await chain.isAuthorizationUsed(auth.from, auth.nonce)) {
      return { kind: 'rejected', code: 'authorization_reused', message: 'This EIP-3009 authorization was already used on-chain' };
    }

    const startBlock = await chain.getBlockNumber();
    const row = store.insert({
      id,
      state: 'settling',
      buyer,
      payer: auth.from,
      network: payload.network,
      grossAmount: auth.value,
      authNonce: auth.nonce,
      authValidBefore: Number(auth.validBefore),
      signature: payload.payload.signature,
      payloadJson: JSON.stringify(payload),
      requirementsJson: JSON.stringify(quoteCheck.requirements),
      startBlock,
    });
    return this._settle(row);
  }

  private async _settle(row: TopupRow): Promise<TopupOutcome> {
    const { store, meridian } = this._deps;
    const payload = JSON.parse(row.payloadJson) as X402PaymentPayload;
    const requirements = JSON.parse(row.requirementsJson) as X402PaymentRequirements;

    let result;
    try {
      result = await meridian.settle(payload, requirements);
    } catch (err) {
      // Unknown outcome — funds may have moved. Keep the row in `settling`;
      // a retry or the recovery pass reconciles via authorizationState.
      const message = err instanceof Error ? err.message : String(err);
      this._log(`settle outcome unknown for ${row.id}: ${message}`);
      return { kind: 'pending', row, message: 'Settlement outcome unknown — retry the same X-PAYMENT shortly' };
    }
    if (!result.success) {
      const updated = store.update(row.id, { state: 'failed', error: result.errorReason ?? 'settlement failed' });
      return { kind: 'failed', row: updated, code: 'settlement_failed', message: updated.error ?? 'settlement failed' };
    }
    const updated = store.update(row.id, { state: 'settled', settleTx: result.transaction });
    this._log(`settled ${row.id} in tx ${result.transaction}`);
    return this._credit(updated);
  }

  /** After settlement: determine the net credited amount, then deposit or refund. */
  private async _credit(row: TopupRow): Promise<TopupOutcome> {
    const { store, chain } = this._deps;
    if (row.netAmount === null) {
      const credit = await chain.getSettlementCredit(row.settleTx!);
      if (!credit) {
        return { kind: 'pending', row, message: 'Settlement transaction not yet visible on-chain — retry shortly' };
      }
      if (credit.netAmount <= 0n) {
        const updated = store.update(row.id, {
          state: 'needs_review',
          error:
            'Settlement credited no funds to the relayer — check that the Meridian ' +
            'organization recipient (or extra.creditedRecipient) is the relayer wallet',
        });
        return { kind: 'failed', row: updated, code: 'needs_review', message: updated.error! };
      }
      row = store.update(row.id, { netAmount: credit.netAmount.toString(), settleBlock: credit.blockNumber });
    }

    const net = BigInt(row.netAmount!);
    const check = await chain.checkDeposit(row.buyer, net);
    if (!check.ok) {
      const updated = store.update(row.id, { state: 'refunding', error: `deposit would revert: ${check.reason}` });
      return this._refund(updated);
    }
    const updated = store.update(row.id, { state: 'depositing' });
    return this._deposit(updated);
  }

  private async _deposit(row: TopupRow): Promise<TopupOutcome> {
    const { store, chain } = this._deps;
    const net = BigInt(row.netAmount!);
    try {
      const result = await chain.deposit(row.buyer, net, (txHash) => {
        store.update(row.id, { depositTx: txHash });
      });
      if (result.ok) {
        const updated = store.update(row.id, { state: 'deposited', depositTx: result.txHash });
        this._log(`deposited ${net} for ${row.buyer} in tx ${result.txHash}`);
        return { kind: 'deposited', row: updated };
      }
      // Reverted on-chain — headroom was consumed between check and execution.
      const updated = store.update(row.id, { state: 'refunding', error: `deposit reverted (tx ${result.txHash})` });
      return this._refund(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._log(`deposit broadcast failed for ${row.id}: ${message}`);
      const current = store.get(row.id)!;
      return { kind: 'pending', row: current, message: 'Deposit transaction pending — retry the same X-PAYMENT shortly' };
    }
  }

  private async _refund(row: TopupRow): Promise<TopupOutcome> {
    const { store, chain } = this._deps;
    const net = BigInt(row.netAmount!);
    try {
      const txHash = await chain.refund(row.payer, net, (hash) => {
        store.update(row.id, { refundTx: hash });
      });
      const updated = store.update(row.id, { state: 'refunded', refundTx: txHash });
      this._log(`refunded ${net} to ${row.payer} in tx ${txHash}`);
      return { kind: 'refunded', row: updated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._log(`refund failed for ${row.id}: ${message}`);
      const current = store.get(row.id)!;
      return { kind: 'pending', row: current, message: 'Refund pending — retry the same X-PAYMENT shortly' };
    }
  }

  /** Resume a previously seen payment from whatever state it stalled in. */
  private async _resume(row: TopupRow): Promise<TopupOutcome> {
    const { store, chain } = this._deps;
    switch (row.state) {
      case 'deposited':
        return { kind: 'deposited', row };
      case 'refunded':
        return { kind: 'refunded', row };
      case 'needs_review':
        return { kind: 'failed', row, code: 'needs_review', message: row.error ?? 'needs operator review' };

      case 'failed': {
        // A cleanly failed settlement left funds untouched; the same payment
        // may be retried while the authorization is unused and unexpired.
        const used = await chain.isAuthorizationUsed(row.payer, row.authNonce);
        if (!used && row.authValidBefore > this._now()) {
          const updated = store.update(row.id, { state: 'settling', error: null });
          return this._settle(updated);
        }
        return { kind: 'failed', row, code: 'settlement_failed', message: row.error ?? 'settlement failed' };
      }

      case 'settling': {
        const used = await chain.isAuthorizationUsed(row.payer, row.authNonce);
        if (used) {
          // Funds moved but we never recorded a settlement tx (crash between
          // settle and persist, or the signature was settled out-of-band).
          const updated = store.update(row.id, {
            state: 'needs_review',
            error: 'authorization consumed on-chain but no settlement transaction recorded',
          });
          return { kind: 'failed', row: updated, code: 'needs_review', message: updated.error! };
        }
        if (row.authValidBefore <= this._now()) {
          const updated = store.update(row.id, { state: 'failed', error: 'authorization expired before settlement' });
          return { kind: 'failed', row: updated, code: 'settlement_failed', message: updated.error! };
        }
        return this._settle(row);
      }

      case 'settled':
        return this._credit(row);

      case 'depositing':
        return this._resumeDeposit(row);

      case 'refunding':
        return this._resumeRefund(row);
    }
  }

  private _scanFloor(row: TopupRow): number {
    return row.settleBlock ?? row.startBlock;
  }

  private async _resumeDeposit(row: TopupRow): Promise<TopupOutcome> {
    const { store, chain } = this._deps;
    const net = BigInt(row.netAmount!);
    if (row.depositTx) {
      const status = await chain.getTxStatus(row.depositTx);
      if (status === 'success') {
        return { kind: 'deposited', row: store.update(row.id, { state: 'deposited' }) };
      }
      if (status === 'pending') {
        return { kind: 'pending', row, message: 'Deposit transaction pending confirmation' };
      }
      if (status === 'reverted') {
        const updated = store.update(row.id, { state: 'refunding', error: `deposit reverted (tx ${row.depositTx})` });
        return this._refund(updated);
      }
    }
    // No usable tx hash — check whether an earlier attempt actually landed
    // before re-sending, so a crash cannot double-credit the buyer.
    const found = await chain.findDepositedTx(row.buyer, net, this._scanFloor(row));
    if (found) {
      return { kind: 'deposited', row: store.update(row.id, { state: 'deposited', depositTx: found }) };
    }
    const check = await chain.checkDeposit(row.buyer, net);
    if (!check.ok) {
      const updated = store.update(row.id, { state: 'refunding', error: `deposit would revert: ${check.reason}` });
      return this._refund(updated);
    }
    return this._deposit(row);
  }

  private async _resumeRefund(row: TopupRow): Promise<TopupOutcome> {
    const { store, chain } = this._deps;
    const net = BigInt(row.netAmount!);
    if (row.refundTx) {
      const status = await chain.getTxStatus(row.refundTx);
      if (status === 'success') {
        return { kind: 'refunded', row: store.update(row.id, { state: 'refunded' }) };
      }
      if (status === 'pending') {
        return { kind: 'pending', row, message: 'Refund transaction pending confirmation' };
      }
    }
    const found = await chain.findRefundTx(row.payer, net, this._scanFloor(row));
    if (found) {
      return { kind: 'refunded', row: store.update(row.id, { state: 'refunded', refundTx: found }) };
    }
    return this._refund(row);
  }

  /** Resume every non-terminal top-up. Called once at startup. */
  async recover(): Promise<void> {
    const rows = this._deps.store.listByStates(['settling', 'settled', 'depositing', 'refunding']);
    for (const row of rows) {
      try {
        const outcome = await this._withLock(row.id, () => this._resume(this._deps.store.get(row.id)!));
        this._log(`recovered ${row.id}: ${outcome.kind}`);
      } catch (err) {
        this._log(`recovery failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

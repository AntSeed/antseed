import { beforeEach, describe, expect, it } from 'vitest';
import { TopupService, grossUpForFees } from './service.js';
import { TopupStore } from './store.js';
import { topupId, type X402PaymentPayload } from './x402.js';
import { FakeChain, FakeMeridian, TEST_X402, randomWallet, signedPayment } from './test-helpers.js';

const BUYER = '0x2222222222222222222222222222222222222222';

const LIMITS = {
  minTopupAmount: 100_000n,
  maxTopupAmount: 0n,
  maxSettleFeeBps: 2_000,
  minValiditySeconds: 30,
};

function makeService(chain: FakeChain, meridian: FakeMeridian, store: TopupStore): TopupService {
  return new TopupService({
    store,
    chain,
    meridian,
    x402: TEST_X402,
    limits: LIMITS,
    log: () => {},
  });
}

describe('grossUpForFees', () => {
  it('grosses up so worst-case net still meets the minimum', () => {
    expect(grossUpForFees(1_000_000n, 2_000)).toBe(1_250_000n);
    // net of the grossed-up amount at exactly the fee cap is >= min
    const gross = grossUpForFees(1_000_000n, 2_000);
    expect(gross - (gross * 2_000n) / 10_000n).toBeGreaterThanOrEqual(1_000_000n);
    expect(grossUpForFees(1_000_000n, 0)).toBe(1_000_000n);
  });
});

describe('quote', () => {
  let chain: FakeChain;
  let service: TopupService;

  beforeEach(() => {
    chain = new FakeChain();
    service = makeService(chain, new FakeMeridian(), new TopupStore(':memory:'));
  });

  it('builds Meridian requirements capped at headroom', async () => {
    const quote = await service.quote(BUYER);
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    expect(quote.amount).toBe(10_000_000n);
    expect(quote.requirements.payTo).toBe(TEST_X402.facilitator);
    expect(quote.requirements.asset).toBe(TEST_X402.asset);
    expect(quote.requirements.maxAmountRequired).toBe('10000000');
    expect(quote.requirements.extra.creditedRecipient).toBe(chain.relayerAddress);
    expect(quote.requirements.extra.name).toBe('USD Coin');
  });

  it('grosses up the first-deposit minimum for worst-case fees', async () => {
    const quote = await service.quote(BUYER);
    expect(quote.ok && quote.minTopup === 1_250_000n).toBe(true);
    // existing balance: on-chain minimum no longer applies
    chain.headroom = { ...chain.headroom, balanceTotal: 2_000_000n, headroom: 8_000_000n };
    const second = await service.quote(BUYER);
    expect(second.ok && second.minTopup === 100_000n).toBe(true);
  });

  it('rejects amounts outside the bounds', async () => {
    const low = await service.quote(BUYER, 200_000n);
    expect(!low.ok && low.code === 'amount_too_low').toBe(true);
    const high = await service.quote(BUYER, 20_000_000n);
    expect(!high.ok && high.code === 'amount_too_high').toBe(true);
  });

  it('rejects when the credit limit leaves no headroom', async () => {
    chain.headroom = { ...chain.headroom, balanceTotal: 10_000_000n, headroom: 0n };
    const quote = await service.quote(BUYER);
    expect(!quote.ok && quote.code === 'credit_limit_reached').toBe(true);
  });

  it('honours the per-request cap', async () => {
    const capped = new TopupService({
      store: new TopupStore(':memory:'),
      chain,
      meridian: new FakeMeridian(),
      x402: TEST_X402,
      limits: { ...LIMITS, maxTopupAmount: 5_000_000n },
      log: () => {},
    });
    const quote = await capped.quote(BUYER);
    expect(quote.ok && quote.amount === 5_000_000n).toBe(true);
  });
});

describe('submitPayment', () => {
  let chain: FakeChain;
  let meridian: FakeMeridian;
  let store: TopupStore;
  let service: TopupService;

  beforeEach(() => {
    chain = new FakeChain();
    chain.headroom = {
      balanceTotal: 2_000_000n,
      creditLimit: 10_000_000n,
      headroom: 8_000_000n,
      minBuyerDeposit: 1_000_000n,
    };
    meridian = new FakeMeridian();
    store = new TopupStore(':memory:');
    service = makeService(chain, meridian, store);
  });

  async function payment(value = 5_000_000n): Promise<X402PaymentPayload> {
    return signedPayment(randomWallet(), { value });
  }

  it('settles, credits the net amount, and deposits for the buyer', async () => {
    const p = await payment();
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });

    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind).toBe('deposited');
    if (outcome.kind !== 'deposited') return;
    expect(outcome.row.netAmount).toBe('4900000');
    expect(outcome.row.settleTx).toBe('0xsettle');
    expect(outcome.row.payer).toBe(p.payload.authorization.from);
    expect(chain.depositCalls).toEqual([{ buyer: BUYER, amount: 4_900_000n }]);
    expect(meridian.calls).toBe(1);
  });

  it('replays an already-deposited payment without settling twice', async () => {
    const p = await payment();
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });

    await service.submitPayment({ payload: p, buyer: BUYER });
    const replay = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(replay.kind).toBe('deposited');
    expect(meridian.calls).toBe(1);
    expect(chain.depositCalls).toHaveLength(1);
  });

  it('refunds the payer when the deposit pre-check fails', async () => {
    const p = await payment();
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });
    chain.checkDepositResult = { ok: false, reason: 'CreditLimitExceeded' };

    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind).toBe('refunded');
    if (outcome.kind !== 'refunded') return;
    expect(outcome.row.error).toContain('CreditLimitExceeded');
    expect(chain.refundCalls).toEqual([{ to: p.payload.authorization.from, amount: 4_900_000n }]);
    expect(chain.depositCalls).toHaveLength(0);
  });

  it('refunds the payer when the deposit reverts on-chain', async () => {
    const p = await payment();
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });
    chain.depositBehavior = 'revert';

    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind).toBe('refunded');
    expect(chain.refundCalls).toHaveLength(1);
  });

  it('marks a clean settlement failure and allows retrying the same payment', async () => {
    const p = await payment();
    meridian.results.push({ success: false, transaction: '', errorReason: 'insufficient_funds' });

    const first = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(first.kind).toBe('failed');
    if (first.kind !== 'failed') return;
    expect(first.code).toBe('settlement_failed');
    expect(first.row.state).toBe('failed');

    meridian.results.push({ success: true, transaction: '0xsettle2' });
    chain.settlementCredits.set('0xsettle2', { netAmount: 4_900_000n, blockNumber: 110 });
    const retry = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(retry.kind).toBe('deposited');
    expect(meridian.calls).toBe(2);
  });

  it('keeps an unknown settlement outcome pending and resumes when unused', async () => {
    const p = await payment();
    meridian.results.push(new Error('socket hang up'));

    const first = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(first.kind).toBe('pending');
    expect(store.get(topupId(p.payload.signature))?.state).toBe('settling');

    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });
    const retry = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(retry.kind).toBe('deposited');
  });

  it('flags for review when the authorization was consumed without a recorded settlement', async () => {
    const p = await payment();
    meridian.results.push(new Error('socket hang up'));
    await service.submitPayment({ payload: p, buyer: BUYER });

    chain.markAuthorizationUsed(p.payload.authorization.from, p.payload.authorization.nonce);
    const retry = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(retry.kind).toBe('failed');
    if (retry.kind !== 'failed') return;
    expect(retry.code).toBe('needs_review');
  });

  it('flags for review when settlement credited nothing to the relayer', async () => {
    const p = await payment();
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 0n, blockNumber: 100 });

    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.code).toBe('needs_review');
    expect(outcome.message).toContain('recipient');
  });

  it('rejects payments aimed at the wrong facilitator', async () => {
    const p = await signedPayment(randomWallet(), {
      value: 5_000_000n,
      to: '0x3333333333333333333333333333333333333333',
    });
    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind === 'rejected' && outcome.code === 'wrong_recipient').toBe(true);
  });

  it('rejects payments for another network', async () => {
    const p = await signedPayment(randomWallet(), { value: 5_000_000n, network: 'optimism' });
    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind === 'rejected' && outcome.code === 'wrong_network').toBe(true);
  });

  it('rejects tampered signatures', async () => {
    const wallet = randomWallet();
    const real = await signedPayment(wallet, { value: 5_000_000n });
    const tampered = {
      ...real,
      payload: {
        ...real.payload,
        authorization: { ...real.payload.authorization, value: '6000000' },
      },
    };
    const outcome = await service.submitPayment({ payload: tampered, buyer: BUYER });
    expect(outcome.kind === 'rejected' && outcome.code === 'invalid_signature').toBe(true);
  });

  it('rejects expired authorizations', async () => {
    const p = await signedPayment(randomWallet(), {
      value: 5_000_000n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) - 10),
    });
    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind === 'rejected' && outcome.code === 'authorization_expired').toBe(true);
  });

  it('rejects a mismatched requested amount', async () => {
    const p = await payment();
    const outcome = await service.submitPayment({ payload: p, buyer: BUYER, requestedAmount: 4_000_000n });
    expect(outcome.kind === 'rejected' && outcome.code === 'amount_mismatch').toBe(true);
  });

  it('rejects an authorization already used on-chain', async () => {
    const p = await payment();
    chain.markAuthorizationUsed(p.payload.authorization.from, p.payload.authorization.nonce);
    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind === 'rejected' && outcome.code === 'authorization_reused').toBe(true);
  });

  it('rejects a value above the buyer headroom before settling', async () => {
    const p = await payment(9_000_000n);
    const outcome = await service.submitPayment({ payload: p, buyer: BUYER });
    expect(outcome.kind === 'rejected' && outcome.code === 'amount_too_high').toBe(true);
    expect(meridian.calls).toBe(0);
  });

  it('rejects a replay that names a different buyer', async () => {
    const p = await payment();
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });
    await service.submitPayment({ payload: p, buyer: BUYER });

    const other = await service.submitPayment({
      payload: p,
      buyer: '0x4444444444444444444444444444444444444444',
    });
    expect(other.kind === 'rejected' && other.code === 'buyer_mismatch').toBe(true);
  });
});

describe('recover', () => {
  let chain: FakeChain;
  let meridian: FakeMeridian;
  let store: TopupStore;
  let service: TopupService;

  beforeEach(() => {
    chain = new FakeChain();
    meridian = new FakeMeridian();
    store = new TopupStore(':memory:');
    service = makeService(chain, meridian, store);
  });

  function seedRow(state: 'depositing' | 'refunding', patch: Record<string, string | null> = {}): string {
    const id = `0x${state}row`;
    store.insert({
      id,
      state: 'settling',
      buyer: BUYER,
      payer: '0x5555555555555555555555555555555555555555',
      network: TEST_X402.network,
      grossAmount: '5000000',
      authNonce: `0x${'11'.repeat(32)}`,
      authValidBefore: Math.floor(Date.now() / 1000) + 3_600,
      signature: '0xsig',
      payloadJson: '{}',
      requirementsJson: '{}',
      startBlock: 40,
    });
    store.update(id, {
      state,
      netAmount: '4900000',
      settleTx: '0xsettle',
      settleBlock: 90,
      ...patch,
    });
    return id;
  }

  it('adopts a deposit that landed even though the tx hash was lost', async () => {
    const id = seedRow('depositing', { depositTx: '0xdead' });
    chain.txStatuses.set('0xdead', 'unknown');
    chain.depositedTxLookup = '0xfound';

    await service.recover();
    const row = store.get(id)!;
    expect(row.state).toBe('deposited');
    expect(row.depositTx).toBe('0xfound');
    expect(chain.depositCalls).toHaveLength(0);
  });

  it('re-sends a deposit that never landed', async () => {
    const id = seedRow('depositing');
    chain.depositedTxLookup = null;

    await service.recover();
    const row = store.get(id)!;
    expect(row.state).toBe('deposited');
    expect(chain.depositCalls).toEqual([{ buyer: BUYER, amount: 4_900_000n }]);
  });

  it('re-sends an interrupted refund exactly once it is not found on-chain', async () => {
    const id = seedRow('refunding');
    chain.refundTxLookup = null;

    await service.recover();
    const row = store.get(id)!;
    expect(row.state).toBe('refunded');
    expect(chain.refundCalls).toHaveLength(1);
  });

  it('adopts a refund that already landed', async () => {
    const id = seedRow('refunding');
    chain.refundTxLookup = '0xrefundfound';

    await service.recover();
    const row = store.get(id)!;
    expect(row.state).toBe('refunded');
    expect(row.refundTx).toBe('0xrefundfound');
    expect(chain.refundCalls).toHaveLength(0);
  });

  it('expires stale unsettled rows', async () => {
    const id = `0xstale`;
    store.insert({
      id,
      state: 'settling',
      buyer: BUYER,
      payer: '0x5555555555555555555555555555555555555555',
      network: TEST_X402.network,
      grossAmount: '5000000',
      authNonce: `0x${'22'.repeat(32)}`,
      authValidBefore: Math.floor(Date.now() / 1000) - 60,
      signature: '0xsig2',
      payloadJson: '{}',
      requirementsJson: '{}',
      startBlock: 40,
    });

    await service.recover();
    expect(store.get(id)!.state).toBe('failed');
    expect(meridian.calls).toBe(0);
  });
});

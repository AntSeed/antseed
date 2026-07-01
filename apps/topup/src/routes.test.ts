import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './server.js';
import { TopupService } from './service.js';
import { TopupStore } from './store.js';
import { topupId } from './x402.js';
import { FakeChain, FakeMeridian, TEST_X402, randomWallet, signedPayment } from './test-helpers.js';

const BUYER = '0x2222222222222222222222222222222222222222';

function makeApp(): { app: FastifyInstance; chain: FakeChain; meridian: FakeMeridian; store: TopupStore } {
  const chain = new FakeChain();
  chain.headroom = {
    balanceTotal: 2_000_000n,
    creditLimit: 10_000_000n,
    headroom: 8_000_000n,
    minBuyerDeposit: 1_000_000n,
  };
  const meridian = new FakeMeridian();
  const store = new TopupStore(':memory:');
  const service = new TopupService({
    store,
    chain,
    meridian,
    x402: TEST_X402,
    limits: {
      minTopupAmount: 100_000n,
      maxTopupAmount: 0n,
      maxSettleFeeBps: 2_000,
      minValiditySeconds: 30,
    },
    log: () => {},
  });
  const app = createApp({
    service,
    health: {
      chainId: 'base-mainnet',
      network: TEST_X402.network,
      asset: TEST_X402.asset,
      facilitator: TEST_X402.facilitator,
      depositsContractAddress: '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2',
      relayer: chain.relayerAddress,
    },
  });
  return { app, chain, meridian, store };
}

describe('POST /v1/topup', () => {
  it('returns a 402 challenge with Meridian requirements when unpaid', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/topup',
      payload: { buyer: BUYER, amount: '5000000' },
    });
    expect(response.statusCode).toBe(402);
    const body = response.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].payTo).toBe(TEST_X402.facilitator);
    expect(body.accepts[0].maxAmountRequired).toBe('5000000');
    expect(body.topup.minAmount).toBe('100000');
    expect(body.topup.maxAmount).toBe('8000000');
  });

  it('settles and deposits when retried with X-PAYMENT', async () => {
    const { app, chain, meridian } = makeApp();
    const payment = await signedPayment(randomWallet(), { value: 5_000_000n });
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/topup',
      headers: { 'x-payment': Buffer.from(JSON.stringify(payment)).toString('base64') },
      payload: { buyer: BUYER, amount: '5000000' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.state).toBe('deposited');
    expect(body.netAmount).toBe('4900000');
    expect(body.signature).toBeUndefined();
    const paymentResponse = JSON.parse(
      Buffer.from(response.headers['x-payment-response'] as string, 'base64').toString('utf-8'),
    );
    expect(paymentResponse.success).toBe(true);
    expect(paymentResponse.transaction).toBe('0xsettle');
  });

  it('accepts the payment as a body field and defaults buyer to the payer', async () => {
    const { app, chain, meridian } = makeApp();
    const wallet = randomWallet();
    const payment = await signedPayment(wallet, { value: 5_000_000n });
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/topup',
      payload: { paymentPayload: payment },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().buyer).toBe(wallet.address);
  });

  it('rejects a malformed X-PAYMENT header', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/topup',
      headers: { 'x-payment': Buffer.from('{"nope":true}').toString('base64') },
      payload: { buyer: BUYER },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().errorReason).toBe('invalid_request');
  });

  it('surfaces a refunded deposit as deposit_failed', async () => {
    const { app, chain, meridian } = makeApp();
    const payment = await signedPayment(randomWallet(), { value: 5_000_000n });
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });
    chain.checkDepositResult = { ok: false, reason: 'CreditLimitExceeded' };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/topup',
      headers: { 'x-payment': Buffer.from(JSON.stringify(payment)).toString('base64') },
      payload: { buyer: BUYER, amount: '5000000' },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.errorReason).toBe('deposit_failed');
    expect(body.refundTx).toMatch(/^0xrefund/);
  });

  it('returns a fresh 402 when settlement fails', async () => {
    const { app, meridian } = makeApp();
    const payment = await signedPayment(randomWallet(), { value: 5_000_000n });
    meridian.results.push({ success: false, transaction: '', errorReason: 'insufficient_funds' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/topup',
      headers: { 'x-payment': Buffer.from(JSON.stringify(payment)).toString('base64') },
      payload: { buyer: BUYER, amount: '5000000' },
    });
    expect(response.statusCode).toBe(402);
    const body = response.json();
    expect(body.error).toContain('insufficient_funds');
    expect(body.accepts).toHaveLength(1);
  });

  it('keeps the retry message when the settlement outcome is unknown', async () => {
    const { app, meridian } = makeApp();
    const payment = await signedPayment(randomWallet(), { value: 5_000_000n });
    meridian.results.push(new Error('socket hang up'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/topup',
      headers: { 'x-payment': Buffer.from(JSON.stringify(payment)).toString('base64') },
      payload: { buyer: BUYER, amount: '5000000' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    const body = response.json();
    expect(body.errorReason).toBe('pending');
    // publicRow's null error column must not clobber the outcome message
    expect(body.error).toContain('retry the same X-PAYMENT');
  });

  it('returns 409 when the buyer has no headroom', async () => {
    const { app, chain } = makeApp();
    chain.headroom = { ...chain.headroom, balanceTotal: 10_000_000n, headroom: 0n };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/topup',
      payload: { buyer: BUYER },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().errorReason).toBe('credit_limit_reached');
  });
});

describe('GET endpoints', () => {
  it('GET /v1/topup/quote returns bounds and requirements', async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: 'GET', url: `/v1/topup/quote?buyer=${BUYER}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.headroom).toBe('8000000');
    expect(body.requirements.payTo).toBe(TEST_X402.facilitator);
  });

  it('GET /v1/topup/:id returns the sanitized record', async () => {
    const { app, chain, meridian } = makeApp();
    const payment = await signedPayment(randomWallet(), { value: 5_000_000n });
    meridian.results.push({ success: true, transaction: '0xsettle' });
    chain.settlementCredits.set('0xsettle', { netAmount: 4_900_000n, blockNumber: 100 });
    await app.inject({
      method: 'POST',
      url: '/v1/topup',
      headers: { 'x-payment': Buffer.from(JSON.stringify(payment)).toString('base64') },
      payload: { buyer: BUYER },
    });

    const id = topupId(payment.payload.signature);
    const response = await app.inject({ method: 'GET', url: `/v1/topup/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe('deposited');
    expect(response.json().signature).toBeUndefined();

    const missing = await app.inject({ method: 'GET', url: '/v1/topup/0xmissing' });
    expect(missing.statusCode).toBe(404);
  });

  it('GET /healthz reports gateway wiring', async () => {
    const { app, chain } = makeApp();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, relayer: chain.relayerAddress, network: 'base' });
  });
});

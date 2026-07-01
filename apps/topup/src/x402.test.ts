import { describe, expect, it } from 'vitest';
import {
  buildPaymentRequirements,
  parsePaymentHeader,
  topupId,
  validatePaymentPayload,
  verifyPaymentSignature,
} from './x402.js';
import { RELAYER, TEST_X402, randomWallet, signedPayment } from './test-helpers.js';

describe('validatePaymentPayload', () => {
  it('accepts a well-formed payload and normalizes addresses', async () => {
    const p = await signedPayment(randomWallet(), { value: 1_000_000n });
    const raw = JSON.parse(JSON.stringify(p)) as { payload: { authorization: { from: string } } };
    raw.payload.authorization.from = raw.payload.authorization.from.toLowerCase();
    const parsed = validatePaymentPayload(raw);
    expect(parsed.payload.authorization.from).toBe(p.payload.authorization.from);
  });

  it.each([
    ['wrong version', (p: Record<string, unknown>) => ({ ...p, x402Version: 2 })],
    ['wrong scheme', (p: Record<string, unknown>) => ({ ...p, scheme: 'upto' })],
    ['missing payload', (p: Record<string, unknown>) => ({ ...p, payload: undefined })],
  ])('rejects %s', async (_name, mutate) => {
    const p = JSON.parse(JSON.stringify(await signedPayment(randomWallet(), { value: 1_000_000n })));
    expect(() => validatePaymentPayload(mutate(p))).toThrow();
  });

  it('rejects malformed authorization fields', async () => {
    const base = JSON.parse(JSON.stringify(await signedPayment(randomWallet(), { value: 1_000_000n })));
    const badValue = JSON.parse(JSON.stringify(base));
    badValue.payload.authorization.value = '1.5';
    expect(() => validatePaymentPayload(badValue)).toThrow(/value/);

    const badNonce = JSON.parse(JSON.stringify(base));
    badNonce.payload.authorization.nonce = '0x1234';
    expect(() => validatePaymentPayload(badNonce)).toThrow(/nonce/);

    const zeroValue = JSON.parse(JSON.stringify(base));
    zeroValue.payload.authorization.value = '0';
    expect(() => validatePaymentPayload(zeroValue)).toThrow(/positive/);
  });
});

describe('parsePaymentHeader', () => {
  it('round-trips a base64 X-PAYMENT header', async () => {
    const p = await signedPayment(randomWallet(), { value: 1_000_000n });
    const header = Buffer.from(JSON.stringify(p)).toString('base64');
    const parsed = parsePaymentHeader(header);
    expect(parsed.payload.signature).toBe(p.payload.signature);
  });

  it('rejects garbage', () => {
    expect(() => parsePaymentHeader('not json at all')).toThrow();
  });
});

describe('verifyPaymentSignature', () => {
  it('accepts a genuine signature and rejects tampering', async () => {
    const p = await signedPayment(randomWallet(), { value: 1_000_000n });
    expect(verifyPaymentSignature(p, TEST_X402)).toBe(true);

    const tampered = JSON.parse(JSON.stringify(p));
    tampered.payload.authorization.value = '2000000';
    expect(verifyPaymentSignature(tampered, TEST_X402)).toBe(false);
  });

  it('rejects a signature bound to another chain', async () => {
    const p = await signedPayment(randomWallet(), { value: 1_000_000n });
    expect(verifyPaymentSignature(p, { ...TEST_X402, evmChainId: 10 })).toBe(false);
  });
});

describe('buildPaymentRequirements', () => {
  it('points payTo at the facilitator and credits the relayer', () => {
    const requirements = buildPaymentRequirements(
      { ...TEST_X402, creditedRecipient: RELAYER },
      '0x2222222222222222222222222222222222222222',
      5_000_000n,
    );
    expect(requirements.scheme).toBe('exact');
    expect(requirements.payTo).toBe(TEST_X402.facilitator);
    expect(requirements.maxAmountRequired).toBe('5000000');
    expect(requirements.extra).toMatchObject({
      name: TEST_X402.assetName,
      version: TEST_X402.assetVersion,
      creditedRecipient: RELAYER,
    });
    expect(requirements.resource).toContain('buyer=0x2222');
  });
});

describe('topupId', () => {
  it('is deterministic per signature', async () => {
    const p = await signedPayment(randomWallet(), { value: 1_000_000n });
    expect(topupId(p.payload.signature)).toBe(topupId(p.payload.signature));
    expect(topupId(p.payload.signature)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

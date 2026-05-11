import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import { validateWithdrawInput } from '../lib/withdraw-validate';

const GOOD_ADDR = '0x' + 'a'.repeat(40);

describe('validateWithdrawInput', () => {
  describe('buyer address', () => {
    it('rejects an empty buyer', () => {
      const r = validateWithdrawInput('', '1');
      expect(r).toEqual({ ok: false, error: 'Invalid buyer address.' });
    });

    it('rejects a non-hex buyer', () => {
      const r = validateWithdrawInput('not-an-address', '1');
      expect(r).toEqual({ ok: false, error: 'Invalid buyer address.' });
    });

    it('rejects a hex string that is too short', () => {
      const r = validateWithdrawInput('0x' + 'a'.repeat(39), '1');
      expect(r).toEqual({ ok: false, error: 'Invalid buyer address.' });
    });

    it('rejects a hex string that is too long', () => {
      const r = validateWithdrawInput('0x' + 'a'.repeat(41), '1');
      expect(r).toEqual({ ok: false, error: 'Invalid buyer address.' });
    });

    it('rejects when the 0x prefix is missing', () => {
      const r = validateWithdrawInput('a'.repeat(40), '1');
      expect(r).toEqual({ ok: false, error: 'Invalid buyer address.' });
    });

    it('accepts a valid lowercase address', () => {
      const r = validateWithdrawInput(GOOD_ADDR, '1');
      expect(r.ok).toBe(true);
    });

    it('accepts a mixed-case address', () => {
      const r = validateWithdrawInput('0xAaBbCcDdEeFf' + '0'.repeat(28), '1');
      expect(r.ok).toBe(true);
    });
  });

  describe('amount', () => {
    it('rejects an empty amount', () => {
      const r = validateWithdrawInput(GOOD_ADDR, '');
      expect(r).toEqual({ ok: false, error: 'Enter a valid amount.' });
    });

    it('rejects a non-numeric amount', () => {
      const r = validateWithdrawInput(GOOD_ADDR, 'abc');
      expect(r).toEqual({ ok: false, error: 'Enter a valid amount.' });
    });

    it('rejects zero', () => {
      const r = validateWithdrawInput(GOOD_ADDR, '0');
      expect(r).toEqual({ ok: false, error: 'Enter a valid amount.' });
    });

    it('rejects a negative amount', () => {
      const r = validateWithdrawInput(GOOD_ADDR, '-1');
      expect(r).toEqual({ ok: false, error: 'Enter a valid amount.' });
    });

    it('rejects NaN-producing input', () => {
      const r = validateWithdrawInput(GOOD_ADDR, '1.2.3');
      expect(r.ok).toBe(false);
    });

    it('accepts an integer amount and returns USDC units (6 decimals)', () => {
      const r = validateWithdrawInput(GOOD_ADDR, '5');
      expect(r).toEqual({ ok: true, units: 5_000_000n });
    });

    it('accepts a fractional amount', () => {
      const r = validateWithdrawInput(GOOD_ADDR, '1.5');
      expect(r).toEqual({ ok: true, units: 1_500_000n });
    });

    it('accepts a sub-cent amount', () => {
      const r = validateWithdrawInput(GOOD_ADDR, '0.000001');
      expect(r).toEqual({ ok: true, units: 1n });
    });

    it('rejects an amount that rounds to zero units', () => {
      // 0.0000001 has 7 decimals; parseUnits(_, 6) will throw because it would
      // truncate precision. We expect the validator to surface that as
      // 'Invalid amount.' (the parseUnits-throws branch).
      const r = validateWithdrawInput(GOOD_ADDR, '0.0000001');
      expect(r.ok).toBe(false);
    });

    it('matches parseUnits semantics for a large amount', () => {
      const big = '1000000';
      const r = validateWithdrawInput(GOOD_ADDR, big);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.units).toBe(parseUnits(big, 6));
    });
  });
});

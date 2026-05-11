import { describe, it, expect } from 'vitest';
import { decideDepositStep } from '../lib/deposit-decide';

const tenUsdc = 10_000_000n; // 10 USDC in 6-dec units

describe('decideDepositStep', () => {
  it('errors when the wallet balance is unknown (null)', () => {
    const d = decideDepositStep({
      amountNum: 10,
      usdcAmount: tenUsdc,
      walletUsdcBalance: null,
      allowance: tenUsdc,
    });
    expect(d.kind).toBe('error');
    if (d.kind === 'error') expect(d.message).toMatch(/wallet USDC balance/i);
  });

  it('errors when the wallet balance is NaN', () => {
    const d = decideDepositStep({
      amountNum: 10,
      usdcAmount: tenUsdc,
      walletUsdcBalance: Number.NaN,
      allowance: tenUsdc,
    });
    expect(d.kind).toBe('error');
  });

  it('errors when the desired amount exceeds wallet USDC', () => {
    const d = decideDepositStep({
      amountNum: 20,
      usdcAmount: tenUsdc * 2n,
      walletUsdcBalance: 10,
      allowance: tenUsdc * 5n,
    });
    expect(d.kind).toBe('error');
    if (d.kind === 'error') {
      expect(d.message).toMatch(/only has/i);
      expect(d.message).toMatch(/10\.00/); // formatted balance is in the message
    }
  });

  it('errors when allowance is unknown (undefined)', () => {
    const d = decideDepositStep({
      amountNum: 10,
      usdcAmount: tenUsdc,
      walletUsdcBalance: 100,
      allowance: undefined,
    });
    expect(d.kind).toBe('error');
    if (d.kind === 'error') expect(d.message).toMatch(/approval/i);
  });

  it("routes to 'approve' when allowance is below the desired amount", () => {
    const d = decideDepositStep({
      amountNum: 10,
      usdcAmount: tenUsdc,
      walletUsdcBalance: 100,
      allowance: tenUsdc - 1n,
    });
    expect(d).toEqual({ kind: 'approve' });
  });

  it("routes to 'approve' when allowance is exactly zero", () => {
    const d = decideDepositStep({
      amountNum: 10,
      usdcAmount: tenUsdc,
      walletUsdcBalance: 100,
      allowance: 0n,
    });
    expect(d).toEqual({ kind: 'approve' });
  });

  it("routes to 'deposit' when allowance exactly matches the desired amount", () => {
    const d = decideDepositStep({
      amountNum: 10,
      usdcAmount: tenUsdc,
      walletUsdcBalance: 100,
      allowance: tenUsdc,
    });
    expect(d).toEqual({ kind: 'deposit' });
  });

  it("routes to 'deposit' when allowance exceeds the desired amount", () => {
    const d = decideDepositStep({
      amountNum: 10,
      usdcAmount: tenUsdc,
      walletUsdcBalance: 100,
      allowance: tenUsdc * 100n,
    });
    expect(d).toEqual({ kind: 'deposit' });
  });

  it('checks balance before allowance (insufficient balance never reaches approve path)', () => {
    const d = decideDepositStep({
      amountNum: 50,
      usdcAmount: tenUsdc * 5n,
      walletUsdcBalance: 10,
      allowance: undefined, // would also error, but balance check wins
    });
    expect(d.kind).toBe('error');
    if (d.kind === 'error') expect(d.message).toMatch(/only has/i);
  });
});

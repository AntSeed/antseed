import { describe, it, expect } from 'vitest';
import { toServiceStatus } from './factory.js';
import type { AutoDepositStatus } from './manager.js';

function status(overrides: Partial<AutoDepositStatus>): AutoDepositStatus {
  return {
    enabled: true,
    delegated: false,
    state: 'idle',
    looseBaseUnits: '0',
    strandedBaseUnits: '0',
    creditLimitBaseUnits: '0',
    depositedBaseUnits: '0',
    lastDeposit: null,
    lastError: null,
    ...overrides,
  };
}

const ADDRESS = '0x1111111111111111111111111111111111111111';

describe('toServiceStatus', () => {
  it('maps disabled to Off without attention', () => {
    const funding = toServiceStatus(status({ enabled: false, state: 'disabled' }), ADDRESS);
    expect(funding.enabled).toBe(false);
    expect(funding.attention).toBe(false);
    expect(funding.summary).toBe('Off');
    expect(funding.receiveAddress).toBe(ADDRESS);
  });

  it('flags needs_attention and surfaces the error', () => {
    const funding = toServiceStatus(status({ state: 'needs_attention', lastError: 'boom' }), ADDRESS);
    expect(funding.attention).toBe(true);
    expect(funding.summary).toContain('boom');
  });

  it('summarizes stranded funds with a USDC amount', () => {
    const funding = toServiceStatus(status({ state: 'stranded', strandedBaseUnits: '2500000' }), ADDRESS);
    expect(funding.attention).toBe(false);
    expect(funding.summary).toContain('2.50 USDC');
  });

  it('shows no status text when idle and delegated (the toggle conveys it)', () => {
    expect(toServiceStatus(status({ state: 'idle', delegated: true }), ADDRESS).summary).toBe('');
  });

  it('mentions the wallet upgrade when idle and not yet delegated', () => {
    expect(toServiceStatus(status({ state: 'idle', delegated: false }), ADDRESS).summary)
      .toContain('upgrades on the first deposit');
  });

  it('reports null deposit limit before the credit limit is known', () => {
    expect(toServiceStatus(status({ creditLimitBaseUnits: '0' }), ADDRESS).receiveLimitUsdc).toBeNull();
  });

  it('reports the live headroom (credit limit minus deposited) in USDC', () => {
    const funding = toServiceStatus(
      status({ creditLimitBaseUnits: '10000000', depositedBaseUnits: '2500000' }),
      ADDRESS,
    );
    expect(funding.receiveLimitUsdc).toBe(7.5);
  });

  it('clamps the deposit limit to zero when already at the credit limit', () => {
    const funding = toServiceStatus(
      status({ creditLimitBaseUnits: '10000000', depositedBaseUnits: '10000000' }),
      ADDRESS,
    );
    expect(funding.receiveLimitUsdc).toBe(0);
  });
});

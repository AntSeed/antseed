import { describe, it, expect } from 'vitest';
import {
  planDeposit,
  isDeterministicError,
  AutoDepositManager,
  type AutoDepositReader,
  type AutoDepositExecutor,
} from './manager.js';

describe('planDeposit', () => {
  const base = { reserve: 0n, minDeposit: 1_000_000n, dustFloor: 1_000_000n };

  it('does nothing below the dust floor', () => {
    expect(planDeposit({ ...base, loose: 500_000n, creditLimit: 10_000_000n, deposited: 0n }))
      .toEqual({ deposit: 0n, stranded: 0n });
  });

  it('deposits the full loose amount when within the credit limit', () => {
    expect(planDeposit({ ...base, loose: 8_000_000n, creditLimit: 10_000_000n, deposited: 0n }))
      .toEqual({ deposit: 8_000_000n, stranded: 0n });
  });

  it('caps at the credit limit and strands the remainder', () => {
    expect(planDeposit({ ...base, loose: 20_000_000n, creditLimit: 10_000_000n, deposited: 0n }))
      .toEqual({ deposit: 10_000_000n, stranded: 10_000_000n });
  });

  it('accounts for already-deposited balance in the room', () => {
    expect(planDeposit({ ...base, loose: 20_000_000n, creditLimit: 10_000_000n, deposited: 7_000_000n }))
      .toEqual({ deposit: 3_000_000n, stranded: 17_000_000n });
  });

  it('keeps the gas reserve back', () => {
    expect(planDeposit({ ...base, reserve: 2_000_000n, loose: 5_000_000n, creditLimit: 10_000_000n, deposited: 0n }))
      .toEqual({ deposit: 3_000_000n, stranded: 0n });
  });

  it('skips a first deposit below MIN_BUYER_DEPOSIT', () => {
    // loose above dust floor but depositable (after reserve) is under the min
    expect(planDeposit({ ...base, reserve: 2_000_000n, loose: 2_500_000n, creditLimit: 10_000_000n, deposited: 0n }))
      .toEqual({ deposit: 0n, stranded: 0n });
  });

  it('allows tiny top-ups once a balance exists (min is 1 base unit)', () => {
    expect(planDeposit({ ...base, loose: 1_000_000n, creditLimit: 10_000_000n, deposited: 5_000_000n }))
      .toEqual({ deposit: 1_000_000n, stranded: 0n });
  });
});

describe('isDeterministicError', () => {
  it('flags on-chain / validation failures', () => {
    expect(isDeterministicError(new Error('execution reverted: CreditLimitExceeded'))).toBe(true);
    expect(isDeterministicError(new Error('AA33 reverted: paymaster'))).toBe(true);
  });
  it('treats network failures as transient', () => {
    expect(isDeterministicError(new Error('fetch failed: ETIMEDOUT'))).toBe(false);
    expect(isDeterministicError(new Error('socket hang up'))).toBe(false);
  });
});

function reader(state: { loose: bigint; deposited: bigint; creditLimit: bigint; delegated?: boolean }): AutoDepositReader {
  return {
    looseUsdc: async () => state.loose,
    totalDeposited: async () => state.deposited,
    creditLimit: async () => state.creditLimit,
    isDelegated: async () => state.delegated ?? true,
  };
}

const enabled = { isEnabled: () => true };
const disabled = { isEnabled: () => false };
const cfg = { pollIntervalMs: 1_000_000, dustFloorBaseUnits: 1_000_000n, gasReserveBaseUnits: 0n, minDepositBaseUnits: 1_000_000n };

describe('AutoDepositManager', () => {
  it('stays disabled without consent', async () => {
    const calls: bigint[] = [];
    const executor: AutoDepositExecutor = { deposit: async (a) => { calls.push(a); return { txHash: '0x' }; } };
    const m = new AutoDepositManager({ reader: reader({ loose: 10_000_000n, deposited: 0n, creditLimit: 10_000_000n }), executor, consent: disabled, config: cfg });
    await m.runOnce();
    expect(m.getStatus().state).toBe('disabled');
    expect(calls).toEqual([]);
  });

  it('deposits when enabled and within the credit limit', async () => {
    const calls: bigint[] = [];
    const executor: AutoDepositExecutor = { deposit: async (a) => { calls.push(a); return { txHash: '0xtx' }; } };
    const m = new AutoDepositManager({ reader: reader({ loose: 8_000_000n, deposited: 0n, creditLimit: 10_000_000n }), executor, consent: enabled, config: cfg });
    await m.runOnce();
    expect(calls).toEqual([8_000_000n]);
    const status = m.getStatus();
    expect(status.state).toBe('idle');
    expect(status.lastDeposit?.txHash).toBe('0xtx');
  });

  it('reports stranded when credit-limited', async () => {
    const calls: bigint[] = [];
    const executor: AutoDepositExecutor = { deposit: async (a) => { calls.push(a); return { txHash: '0xtx' }; } };
    const m = new AutoDepositManager({ reader: reader({ loose: 20_000_000n, deposited: 0n, creditLimit: 10_000_000n }), executor, consent: enabled, config: cfg });
    await m.runOnce();
    expect(calls).toEqual([10_000_000n]);
    expect(m.getStatus().state).toBe('stranded');
    expect(m.getStatus().strandedBaseUnits).toBe('10000000');
  });

  it('goes idle below the dust floor without calling the executor', async () => {
    const calls: bigint[] = [];
    const executor: AutoDepositExecutor = { deposit: async (a) => { calls.push(a); return { txHash: '0x' }; } };
    const m = new AutoDepositManager({ reader: reader({ loose: 500_000n, deposited: 0n, creditLimit: 10_000_000n }), executor, consent: enabled, config: cfg });
    await m.runOnce();
    expect(calls).toEqual([]);
    expect(m.getStatus().state).toBe('idle');
  });

  it('backs off on a transient failure', async () => {
    const executor: AutoDepositExecutor = { deposit: async () => { throw new Error('fetch failed'); } };
    const m = new AutoDepositManager({ reader: reader({ loose: 8_000_000n, deposited: 0n, creditLimit: 10_000_000n }), executor, consent: enabled, config: cfg });
    await m.runOnce();
    expect(m.getStatus().state).toBe('backoff');
    expect(m.getStatus().lastError).toContain('fetch failed');
  });

  it('circuit-breaks on a deterministic failure until inputs change', async () => {
    let calls = 0;
    const executor: AutoDepositExecutor = { deposit: async () => { calls++; throw new Error('execution reverted: CreditLimitExceeded'); } };
    const state = { loose: 8_000_000n, deposited: 0n, creditLimit: 10_000_000n };
    const m = new AutoDepositManager({ reader: reader(state), executor, consent: enabled, config: cfg });

    await m.runOnce();
    expect(m.getStatus().state).toBe('needs_attention');
    expect(calls).toBe(1);

    // same inputs → no retry (no extra gas burn)
    await m.runOnce();
    expect(calls).toBe(1);

    // inputs change → retry
    state.loose = 9_000_000n;
    await m.runOnce();
    expect(calls).toBe(2);
  });

  it('circuit breaker also retries when only deposited changes', async () => {
    let calls = 0;
    const executor: AutoDepositExecutor = { deposit: async () => { calls++; throw new Error('execution reverted'); } };
    const state = { loose: 8_000_000n, deposited: 0n, creditLimit: 20_000_000n };
    const m = new AutoDepositManager({ reader: reader(state), executor, consent: enabled, config: cfg });

    await m.runOnce();
    expect(m.getStatus().state).toBe('needs_attention');
    expect(calls).toBe(1);

    await m.runOnce();                 // loose + creditLimit unchanged → no retry
    expect(calls).toBe(1);

    state.deposited = 2_000_000n;      // only deposited changed → must retry
    await m.runOnce();
    expect(calls).toBe(2);
  });

  it('circuit breaker does NOT retry when loose only decreases (gas burn)', async () => {
    let calls = 0;
    const executor: AutoDepositExecutor = { deposit: async () => { calls++; throw new Error('execution reverted'); } };
    const state = { loose: 8_000_000n, deposited: 0n, creditLimit: 20_000_000n };
    const m = new AutoDepositManager({ reader: reader(state), executor, consent: enabled, config: cfg });

    await m.runOnce();
    expect(calls).toBe(1);

    // a mined-but-reverted op still pays USDC gas → loose drops. Must NOT reopen.
    state.loose = 7_900_000n;
    await m.runOnce();
    expect(calls).toBe(1);

    // but new funds (loose increase) should reopen
    state.loose = 9_000_000n;
    await m.runOnce();
    expect(calls).toBe(2);
  });
});

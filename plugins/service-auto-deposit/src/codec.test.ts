import { describe, it, expect } from 'vitest';
import { isDelegationCode, delegationTarget, encodeCirclePaymasterData } from './codec.js';

const DELEGATED = '0xef0100e6cae83bde06e4c305530e199d7217f42808555b';
const SIMPLE_7702 = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';

describe('isDelegationCode', () => {
  it('detects the 7702 designator', () => {
    expect(isDelegationCode(DELEGATED)).toBe(true);
    expect(isDelegationCode(DELEGATED.toUpperCase() as `0x${string}`)).toBe(true);
  });

  it('is false for empty / missing / plain bytecode', () => {
    expect(isDelegationCode('0x')).toBe(false);
    expect(isDelegationCode(null)).toBe(false);
    expect(isDelegationCode(undefined)).toBe(false);
    expect(isDelegationCode('0x60806040')).toBe(false);
  });
});

describe('delegationTarget', () => {
  it('extracts the (checksummed) implementation address', () => {
    expect(delegationTarget(DELEGATED)).toBe(SIMPLE_7702);
  });

  it('returns null when not delegated', () => {
    expect(delegationTarget('0x')).toBeNull();
    expect(delegationTarget(undefined)).toBeNull();
  });
});

describe('encodeCirclePaymasterData', () => {
  it('packs [mode=0, token, maxGasUsdc, sig]', () => {
    const usdc = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const out = encodeCirclePaymasterData(usdc, 1_000_000n, '0xabcd');
    // 0x + mode(00) + token(20B, lowercased) + uint256(32B) + sig
    expect(out.startsWith('0x00036cbd53842c5426634e7929541ec2318f3dcf7e')).toBe(true);
    expect(out).toContain('0000000000000000000000000000000000000000000000000000000000000f4240'.slice(-64));
    expect(out.endsWith('abcd')).toBe(true);
  });
});

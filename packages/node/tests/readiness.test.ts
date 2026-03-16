import { describe, it, expect, vi } from 'vitest';
import { checkSellerReadiness, checkBuyerReadiness } from '../src/payments/readiness.js';
import type { Identity } from '../src/p2p/identity.js';
import type { BaseEscrowClient } from '../src/payments/evm/escrow-client.js';
import type { IdentityClient } from '../src/payments/evm/identity-client.js';

// Deterministic fake identity (32-byte keys)
const fakeIdentity: Identity = {
  peerId: 'abcd1234' as Identity['peerId'],
  privateKey: new Uint8Array(32).fill(1),
  publicKey: new Uint8Array(32).fill(2),
};

function mockEscrowClient(overrides: {
  ethBalance?: bigint;
  sellerStake?: bigint;
  sellerTokenRate?: bigint;
  buyerAvailable?: bigint;
} = {}): BaseEscrowClient {
  return {
    provider: {
      getBalance: vi.fn().mockResolvedValue(overrides.ethBalance ?? 1000000000000000n),
    },
    getSellerAccount: vi.fn().mockResolvedValue({
      stake: overrides.sellerStake ?? 10_000_000n,
      earnings: 0n,
      stakedAt: 0n,
      tokenRate: overrides.sellerTokenRate ?? 100n,
    }),
    getBuyerBalance: vi.fn().mockResolvedValue({
      available: overrides.buyerAvailable ?? 5_000_000n,
      reserved: 0n,
      pendingWithdrawal: 0n,
      lastActivityAt: 0n,
    }),
  } as unknown as BaseEscrowClient;
}

function mockIdentityClient(overrides: {
  isRegistered?: boolean;
} = {}): IdentityClient {
  return {
    isRegistered: vi.fn().mockResolvedValue(overrides.isRegistered ?? true),
  } as unknown as IdentityClient;
}

describe('checkSellerReadiness', () => {
  it('all checks pass when seller is fully set up', async () => {
    const escrow = mockEscrowClient();
    const identity = mockIdentityClient();

    const checks = await checkSellerReadiness(fakeIdentity, escrow, identity);

    expect(checks).toHaveLength(4);
    expect(checks.every(c => c.passed)).toBe(true);
    expect(checks.every(c => c.command === undefined)).toBe(true);
  });

  it('fails gas check when ETH balance is zero', async () => {
    const escrow = mockEscrowClient({ ethBalance: 0n });
    const identity = mockIdentityClient();

    const checks = await checkSellerReadiness(fakeIdentity, escrow, identity);

    const gasCheck = checks.find(c => c.name === 'Gas balance')!;
    expect(gasCheck.passed).toBe(false);
    expect(gasCheck.message).toContain('No ETH for gas');
  });

  it('fails registration check when not registered', async () => {
    const escrow = mockEscrowClient();
    const identity = mockIdentityClient({ isRegistered: false });

    const checks = await checkSellerReadiness(fakeIdentity, escrow, identity);

    const regCheck = checks.find(c => c.name === 'Peer registration')!;
    expect(regCheck.passed).toBe(false);
    expect(regCheck.command).toBe('antseed register');
  });

  it('fails stake check when no stake', async () => {
    const escrow = mockEscrowClient({ sellerStake: 0n });
    const identity = mockIdentityClient();

    const checks = await checkSellerReadiness(fakeIdentity, escrow, identity);

    const stakeCheck = checks.find(c => c.name === 'Stake')!;
    expect(stakeCheck.passed).toBe(false);
    expect(stakeCheck.command).toBe('antseed stake 10');
  });

  it('fails token rate check when rate is zero', async () => {
    const escrow = mockEscrowClient({ sellerTokenRate: 0n });
    const identity = mockIdentityClient();

    const checks = await checkSellerReadiness(fakeIdentity, escrow, identity);

    const rateCheck = checks.find(c => c.name === 'Token rate')!;
    expect(rateCheck.passed).toBe(false);
    expect(rateCheck.message).toBe('Token rate not set');
  });
});

describe('checkBuyerReadiness', () => {
  it('all checks pass when buyer has gas and balance', async () => {
    const escrow = mockEscrowClient();

    const checks = await checkBuyerReadiness(fakeIdentity, escrow);

    expect(checks).toHaveLength(2);
    expect(checks.every(c => c.passed)).toBe(true);
  });

  it('fails gas check when ETH balance is zero', async () => {
    const escrow = mockEscrowClient({ ethBalance: 0n });

    const checks = await checkBuyerReadiness(fakeIdentity, escrow);

    const gasCheck = checks.find(c => c.name === 'Gas balance')!;
    expect(gasCheck.passed).toBe(false);
    expect(gasCheck.message).toContain('No ETH for gas');
  });

  it('fails escrow balance check when no USDC available', async () => {
    const escrow = mockEscrowClient({ buyerAvailable: 0n });

    const checks = await checkBuyerReadiness(fakeIdentity, escrow);

    const balCheck = checks.find(c => c.name === 'Escrow balance')!;
    expect(balCheck.passed).toBe(false);
    expect(balCheck.command).toBe('antseed deposit 10');
  });
});

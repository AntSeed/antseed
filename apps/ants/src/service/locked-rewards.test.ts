import { describe, expect, it, vi } from 'vitest';
import { ZeroAddress } from 'ethers';
import type { AntsContext } from './context.js';
import { lockedRewards, previewLockedClaim } from './locked-rewards.js';

const seller = '0x0000000000000000000000000000000000000001';
const recipient = '0x0000000000000000000000000000000000000002';
const policyAddress = '0x0000000000000000000000000000000000000003';
const legacy = '0x0000000000000000000000000000000000000004';

function fixture() {
  const detail = {
    seller, blockNumber: 55, pool: recipient, token: policyAddress, locked: 960n, poolBalance: 960n, transferAllowed: true,
    policy: { address: policyAddress, cumulativeLocked: 1000n, accountingCumulative: 1000n, withdrawn: 40n, entitlement: 100n,
      releaseBps: 1000n, lastEpoch: 21n, legacyEmissions: legacy, washTradingRegistry: policyAddress, restricted: false, claimable: 60n },
  };
  const stack = { phase: 'active', effectiveEpoch: 22, legacyEmissions: legacy, lockedRewardsPool: recipient, lockedRewardsPoolError: undefined as string | undefined };
  const provider = { getNetwork: async () => ({ chainId: 8453n }), send: vi.fn(async () => '0x2105') };
  const pool = { details: vi.fn(async () => detail), provider, previewClaim: vi.fn(async () => ({ gasEstimate: 100n, gasLimit: 130n, maxFeePerGas: 2n, maxExecutionFee: 260n, ethBalance: 1000n })) };
  const signer = { getAddress: vi.fn(async () => seller), provider: undefined };
  const ctx = {
    address: seller, chain: { chainId: 'base-mainnet', evmChainId: 8453, antsTokenAddress: policyAddress }, stack: async () => stack,
    provider: () => provider, lockedPoolAt: () => pool, requireSigner: () => signer,
  } as unknown as AntsContext;
  return { ctx, detail, stack, pool, signer, provider };
}

describe('M002 diagnostic and preview service', () => {
  it('returns JSON-safe amounts and the policy-specific registry', async () => {
    const { ctx } = fixture();
    expect(await lockedRewards(ctx)).toMatchObject({ locked: '960', blockers: [], policy: { claimable: '60', withdrawn: '40', washTradingRegistry: policyAddress } });
  });

  it('simulates an eligible seller without sending a transaction', async () => {
    const { ctx, pool } = fixture();
    expect(await previewLockedClaim(ctx, recipient)).toMatchObject({ recipient, gas: { gasLimit: '130', maxExecutionFee: '260' } });
    expect(pool.previewClaim).toHaveBeenCalledWith(seller, recipient);
  });

  it.each(['restricted', 'transfer', 'inactive', 'epoch', 'emissions', 'empty', 'funding', 'accounting', 'policy', 'token'])(
    'refuses a claim with the %s blocker', async (reason) => {
      const { ctx, detail, stack, pool } = fixture();
      if (reason === 'restricted') detail.policy.restricted = true;
      if (reason === 'transfer') detail.transferAllowed = false;
      if (reason === 'token') detail.token = recipient;
      if (reason === 'inactive') stack.phase = 'deployed';
      if (reason === 'epoch') detail.policy.lastEpoch = 20n;
      if (reason === 'emissions') detail.policy.legacyEmissions = recipient;
      if (reason === 'empty') detail.policy.claimable = 0n;
      if (reason === 'funding') detail.poolBalance = 0n;
      if (reason === 'accounting') detail.policy.cumulativeLocked = 10n;
      if (reason === 'policy') pool.details.mockResolvedValue({ ...detail, policy: null } as never);
      expect((await lockedRewards(ctx)).blockers.length).toBeGreaterThan(0);
      await expect(previewLockedClaim(ctx)).rejects.toThrow('Cannot claim');
      expect(pool.previewClaim).not.toHaveBeenCalled();
    },
  );

  it('propagates discovery and RPC failures instead of reporting a zero balance', async () => {
    const { ctx, stack, pool } = fixture();
    stack.lockedRewardsPoolError = 'pool discovery failed';
    await expect(lockedRewards(ctx)).rejects.toThrow('discovery failed');
    stack.lockedRewardsPoolError = undefined;
    pool.details.mockRejectedValue(new Error('read failed'));
    await expect(lockedRewards(ctx)).rejects.toThrow('read failed');
  });

  it('checks the live RPC chain ID even when the provider uses a static network', async () => {
    const { ctx, provider, pool } = fixture();
    provider.send.mockResolvedValue('0x1');
    await expect(previewLockedClaim(ctx)).rejects.toThrow('RPC chain');
    expect(pool.details).not.toHaveBeenCalled();
  });

  it('rejects zero recipients and a signer that is not the seller', async () => {
    const { ctx, signer } = fixture();
    await expect(previewLockedClaim(ctx, ZeroAddress)).rejects.toThrow('zero address');
    signer.getAddress.mockResolvedValue(recipient);
    await expect(previewLockedClaim(ctx)).rejects.toThrow('signer does not match');
  });
});

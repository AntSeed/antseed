import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { claim, compound, restake, rewards } from './rewards.js';

const address = '0x0000000000000000000000000000000000000001';
const foreign = '0x0000000000000000000000000000000000000002';

function fixture(indexed = true) {
  const position = { id: 7, owner: address, agentId: 2, amount: 100n, weightAmount: 100n, stakeStartEpoch: 1, stakeEndEpoch: 12, closedAtEpoch: 5, withdrawn: false };
  const pools = {
    allStakerPositionIds: async () => [],
    positionsBatch: vi.fn(async (ids: number[]) => ids.map((id) => ({ ...position, id, owner: id === 9 ? foreign : address }))),
    poolConfig: async () => ({ minStakeEpochs: 1, maxStakeEpochs: 52 }),
    currentEpoch: async () => 6,
  };
  const poolRewards = {
    previewStakerRewards: async (ids: number[]) => ids.map(() => 10n),
    poolRewardIndexNextEpoch: async () => 6,
    pendingIndexedStakerReward: async () => 10n,
    claimStakerRewardsBatch: vi.fn(async () => 'claim-hash'),
    restakeStakerRewardsBatch: vi.fn(async () => 'restake-hash'),
  };
  const ctx = {
    address,
    stack: async () => ({ phase: 'legacy', currentEpoch: 6 }),
    claimableEpochs: async () => ({ legacy: [], recognized: [] }),
    pools: () => pools,
    poolRewards: () => poolRewards,
    requirePools: () => pools,
    requirePoolRewards: () => poolRewards,
    requireSigner: () => ({}),
    antsToken: () => ({ receivedInTransaction: async () => 10n }),
    usageAccounting: () => null,
    usageRewards: () => null,
    legacyEmissionsAt: () => null,
    lockedPoolAt: () => null,
    sellerRegistry: () => null,
    legacyStakingAt: () => null,
    deposits: () => null,
    indexer: () => indexed ? { positions: async () => [position] } : null,
    invalidate: () => {},
  } as unknown as AntsContext;
  return { ctx, pools, poolRewards };
}

describe('closed-position rewards', () => {
  it('claims the same closed-position rewards shown in the view', async () => {
    const { ctx, poolRewards } = fixture();
    expect((await rewards(ctx)).staker.total).toBe('10');
    expect(await claim(ctx, { buckets: ['staker'] })).toMatchObject({ claimed: '10', transactions: ['claim-hash'] });
    expect(poolRewards.claimStakerRewardsBatch).toHaveBeenCalledWith({}, [7], address);
  });

  it('restakes indexed closed positions by default', async () => {
    const { ctx, poolRewards } = fixture();
    expect(await restake(ctx, { epochs: 4 })).toMatchObject({ positionIds: [7], transactions: ['restake-hash'] });
    expect(poolRewards.restakeStakerRewardsBatch).toHaveBeenCalledWith({}, [7], 4);
  });

  it('loads explicitly requested closed IDs even without an indexer', async () => {
    const { ctx, pools } = fixture(false);
    expect(await restake(ctx, { positionIds: [7], epochs: 4 })).toMatchObject({ positionIds: [7] });
    expect(pools.positionsBatch).toHaveBeenCalledWith([7]);
  });

  it('does not restake closed positions belonging to another wallet', async () => {
    const { ctx, poolRewards } = fixture(false);
    await expect(restake(ctx, { positionIds: [9], epochs: 4 })).rejects.toThrow('not owned');
    expect(poolRewards.restakeStakerRewardsBatch).not.toHaveBeenCalled();
  });

  it('includes closed-position rewards in compound', async () => {
    const { ctx } = fixture();
    expect(await compound(ctx, { epochs: 4 })).toMatchObject({ restakedPositionIds: [7], transactions: ['restake-hash'] });
  });
});

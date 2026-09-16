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

describe('locked legacy claims', () => {
  function lockedFixture() {
    const { ctx } = fixture();
    let locked = 1000n;
    let pendingLegacy = 100n;
    let cumulative = 1000n;
    const pool = {
      claimable: vi.fn(async () => ({ locked, claimable: cumulative / 10n - (cumulative - locked), policy: foreign })),
      claim: vi.fn(async () => { locked -= cumulative / 10n - (cumulative - locked); return 'locked-hash'; }),
    };
    const legacy = {
      pendingEmissions: async () => ({ seller: pendingLegacy, buyer: 0n }),
      claimSellerEmissions: vi.fn(async () => { locked += pendingLegacy; cumulative += pendingLegacy; pendingLegacy = 0n; return 'legacy-hash'; }),
    };
    const token = { receivedInTransaction: vi.fn(async (hash: string) => hash === 'locked-hash' ? cumulative / 10n : 0n) };
    Object.assign(ctx, {
      claimableEpochs: async () => ({ legacy: [0], recognized: [] }),
      lockedPoolAt: () => pool, legacyEmissionsAt: () => legacy,
      antsToken: () => token, invalidate: vi.fn(),
    });
    return { ctx, pool, legacy, token };
  }

  it('collects late legacy emissions before computing the pool release', async () => {
    const { ctx, pool, legacy, token } = lockedFixture();
    const result = await claim(ctx, { buckets: ['legacy', 'locked'], recipient: foreign });
    expect(result).toMatchObject({ claimed: '110', transactions: ['legacy-hash', 'locked-hash'] });
    expect(legacy.claimSellerEmissions).toHaveBeenCalledOnce();
    expect(pool.claim).toHaveBeenCalledWith({}, foreign);
    expect(token.receivedInTransaction).toHaveBeenCalledWith('legacy-hash', address);
    expect(token.receivedInTransaction).toHaveBeenCalledWith('locked-hash', foreign);
    expect((await claim(ctx, { buckets: ['locked'] })).transactions).toEqual([]);
    expect(pool.claim).toHaveBeenCalledOnce();
  });

  it('reports confirmed legacy transactions when the subsequent pool claim fails', async () => {
    const { ctx, pool } = lockedFixture();
    pool.claim.mockRejectedValue(new Error('claim reverted'));
    await expect(claim(ctx, { buckets: ['legacy', 'locked'] })).rejects.toThrow(/legacy-hash.*not rolled back.*claim reverted/);
    expect(ctx.invalidate).toHaveBeenCalled();
  });

  it('reports a confirmed claim even if receipt accounting fails', async () => {
    const { ctx, token } = lockedFixture();
    token.receivedInTransaction.mockRejectedValue(new Error('receipt RPC failed'));
    await expect(claim(ctx, { buckets: ['locked'] })).rejects.toThrow(/locked-hash.*receipt RPC failed/);
  });

  it('does not turn a claimability read failure into a successful no-op', async () => {
    const { ctx, pool } = lockedFixture();
    pool.claimable.mockRejectedValue(new Error('RPC unavailable'));
    await expect(claim(ctx, { buckets: ['locked'] })).rejects.toThrow('RPC unavailable');
    await expect(rewards(ctx)).rejects.toThrow('RPC unavailable');
    expect(pool.claim).not.toHaveBeenCalled();
  });

  it('refuses a missing policy and a zero recipient without broadcasting', async () => {
    const { ctx, pool } = lockedFixture();
    const zero = '0x0000000000000000000000000000000000000000';
    await expect(claim(ctx, { buckets: ['locked'], recipient: zero })).rejects.toThrow('zero address');
    pool.claimable.mockResolvedValue({ locked: 1000n, claimable: 0n, policy: zero });
    await expect(claim(ctx, { buckets: ['locked'] })).rejects.toThrow('M002');
    expect(pool.claim).not.toHaveBeenCalled();
  });
});

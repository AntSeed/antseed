import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { move, positions, stake } from './positions.js';
import { stakeEligibility } from './stake-eligibility.js';

vi.mock('./stake-eligibility.js', () => ({ stakeEligibility: vi.fn() }));

function fixture() {
  const address = '0x0000000000000000000000000000000000000001';
  const signer = {};
  vi.mocked(stakeEligibility).mockImplementation(async (_ctx, ids) => new Map(ids.map(id => [id, { owner: address, stakeable: true }])));
  const pools = {
    positionsBatch: vi.fn(async (ids: number[]) => ids.map(id => ({ id, owner: address, agentId: 1, amount: 100n, weightAmount: 100n, stakeStartEpoch: 1, stakeEndEpoch: 5, closedAtEpoch: 0, withdrawn: false }))),
    positionWithdrawableEpoch: vi.fn(async () => 1),
    isMaxLocked: vi.fn(async () => false),
    moveStake: vi.fn(async () => 'single-hash'),
    moveStakes: vi.fn(async () => 'batch-hash'),
    splitStake: vi.fn(),
  };
  const ctx = {
    address,
    requirePools: () => pools,
    requireSigner: () => signer,
    stack: async () => ({ currentEpoch: 2 }),
    sellerRegistry: () => ({ agentSeller: async () => address }),
    localPositionIds: new Map<number, string>(),
  } as unknown as AntsContext;
  return { ctx, pools, signer, address };
}

describe('position display reads', () => {
  function displayFixture() {
    const { ctx, pools } = fixture();
    const statuses = vi.fn(async () => [{ withdrawableEpoch: 1, maxLocked: false, slashBps: 1000 }]);
    Object.assign(pools, {
      allStakerPositionIds: async () => [7],
      poolConfig: async () => ({ minStakeEpochs: 1, maxStakeEpochs: 26, maxSlashBps: 9000, minEarlyExitSlashBps: 0 }),
      positionStatusesBatch: statuses,
    });
    const rewards = vi.fn(async () => [15n]);
    Object.assign(ctx, { indexer: () => null, poolRewards: () => ({ previewStakerRewards: rewards }) });
    return { ctx, pools, statuses, rewards };
  }

  it('uses batched statuses while preserving penalties, rewards, and totals', async () => {
    const { ctx, pools, statuses, rewards } = displayFixture();
    const result = await positions(ctx);
    expect(statuses).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 7 })]), 2);
    expect(pools.positionWithdrawableEpoch).not.toHaveBeenCalled();
    expect(pools.isMaxLocked).not.toHaveBeenCalled();
    expect(rewards).toHaveBeenCalledWith([7]);
    expect(result.positions[0]).toMatchObject({ id: 7, slashedAmount: '10', returnedAmount: '90', pendingReward: '15', changePending: false, maxLocked: false });
    expect(result.totals).toEqual({ activeStake: '100', pendingStake: '0', pendingRewards: '15', open: 1 });
  });

  it('does not present failed status or reward reads as zero balances', async () => {
    const { ctx, statuses, rewards } = displayFixture();
    statuses.mockRejectedValueOnce(new Error('status unavailable'));
    await expect(positions(ctx)).rejects.toThrow('status unavailable');
    rewards.mockRejectedValueOnce(new Error('reward unavailable'));
    await expect(positions(ctx)).rejects.toThrow('reward unavailable');
  });
});

describe('staking registration checks', () => {
  function stakeFixture() {
    const { ctx, pools, signer } = fixture();
    const submit = vi.fn(async () => 'stake-hash');
    Object.assign(pools, { poolConfig: async () => ({ minStakeEpochs: 1, maxStakeEpochs: 104 }), stake: submit });
    const agentSeller = vi.fn(async () => '0x0000000000000000000000000000000000000000');
    Object.assign(ctx, {
      sellerRegistry: () => ({ agentSeller }),
      antsToken: () => ({ balanceOf: async () => 100n * 10n ** 18n, canTransfer: async () => true }),
      invalidate: vi.fn(),
    });
    return { ctx, signer, submit, agentSeller };
  }

  it('accepts a contract-eligible seller without an explicit new-registry binding', async () => {
    const { ctx, signer, submit, agentSeller } = stakeFixture();
    expect(await stake(ctx, { agentId: 59096, amount: '1', epochs: 2 })).toMatchObject({ hash: 'stake-hash' });
    expect(stakeEligibility).toHaveBeenCalledWith(ctx, [59096]);
    expect(agentSeller).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(signer, 59096, 10n ** 18n, 2);
  });

  it('rejects an ineligible current owner before submitting a transaction', async () => {
    const { ctx, submit } = stakeFixture();
    vi.mocked(stakeEligibility).mockResolvedValueOnce(new Map([[59096, { owner: null, stakeable: false }]]));
    await expect(stake(ctx, { agentId: 59096, amount: '1', epochs: 2 })).rejects.toThrow('not registered to its current owner');
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps RPC verification failures distinct from registration failures', async () => {
    const { ctx, submit } = stakeFixture();
    vi.mocked(stakeEligibility).mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(stake(ctx, { agentId: 59096, amount: '1', epochs: 2 })).rejects.toThrow('RPC unavailable');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('whole-position moves', () => {
  it('moves a complete position in one transaction and remembers its source rewards', async () => {
    const { ctx, pools, signer, address } = fixture();
    expect(await move(ctx, { positionIds: [7], toAgentId: 2 })).toEqual({ hash: 'single-hash' });
    expect(pools.moveStake).toHaveBeenCalledWith(signer, 7, 2);
    expect(pools.moveStakes).not.toHaveBeenCalled();
    expect(pools.splitStake).not.toHaveBeenCalled();
    expect(ctx.localPositionIds.get(7)).toBe(address);
  });

  it('moves multiple complete positions in one transaction', async () => {
    const { ctx, pools, signer } = fixture();
    expect(await move(ctx, { positionIds: [7, 8], toAgentId: 2 })).toEqual({ hash: 'batch-hash' });
    expect(pools.moveStakes).toHaveBeenCalledWith(signer, [7, 8], 2);
    expect(pools.moveStake).not.toHaveBeenCalled();
    expect(pools.splitStake).not.toHaveBeenCalled();
    expect([...ctx.localPositionIds.keys()]).toEqual([7, 8]);
  });

  it('rejects obsolete partial requests rather than silently moving the whole position', async () => {
    const { ctx, pools } = fixture();
    const request = { positionIds: [7], toAgentId: 2, amount: '40' };
    await expect(move(ctx, request)).rejects.toThrow('Partial moves are not supported');
    expect(pools.positionsBatch).not.toHaveBeenCalled();
    expect(pools.moveStake).not.toHaveBeenCalled();
    expect(pools.splitStake).not.toHaveBeenCalled();
  });

  it('still rejects pending changes and maximum-locked positions', async () => {
    const { ctx, pools } = fixture();
    pools.positionWithdrawableEpoch.mockResolvedValueOnce(3);
    await expect(move(ctx, { positionIds: [7], toAgentId: 2 })).rejects.toThrow('changed this epoch');
    pools.isMaxLocked.mockResolvedValueOnce(true);
    await expect(move(ctx, { positionIds: [7], toAgentId: 2 })).rejects.toThrow('Disable maximum lock');
    expect(pools.moveStake).not.toHaveBeenCalled();
  });
});

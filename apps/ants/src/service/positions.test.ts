import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { move } from './positions.js';

function fixture() {
  const address = '0x0000000000000000000000000000000000000001';
  const signer = {};
  const pools = {
    positionsBatch: vi.fn(async (ids: number[]) => ids.map(id => ({ id, owner: address, agentId: 1, amount: 100n, stakeStartEpoch: 1, closedAtEpoch: 0, withdrawn: false }))),
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

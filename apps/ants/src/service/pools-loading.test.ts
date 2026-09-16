import { describe, expect, it, vi } from 'vitest';
import { ZeroAddress } from 'ethers';
import { multicallRead } from '@antseed/node/payments';
import { poolsView, poolStakerCounts } from './pools.js';
import type { AntsContext } from './context.js';
import type { IndexedPools } from './indexer.js';
vi.mock('@antseed/node/payments', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));

function setup(indexedEpoch = 2, historical = true) {
  const address = '0x0000000000000000000000000000000000000001';
  const network = (epoch: number) => ({ epoch, complete: true, totalPowerWeight: '100', totalActiveStake: '10', stakerBudget: '5', totalWeightedPoolPoints: '10' });
  const indexed = {
    currentEpoch: indexedEpoch, network: { current: network(indexedEpoch), last: network(indexedEpoch - 1) },
    pools: [{ agentId: 1, seller: address, registered: true, openPositions: 1, weight: '100', activeStake: '10', powerShareBps: 10000, securityShareBps: '0', usagePoints: '10', weightedUsagePoints: '10', lastUsagePoints: '10', lastEmission: '5', lastEmissionSettled: true, lastWeight: '90', volumeUsdc: '1', lastVolumeUsdc: '1', historicalYield: historical ? { power: '90', reward: '5', settled: true } : null }],
  } as IndexedPools;
  const indexer = { pools: vi.fn(async () => indexed), pool: vi.fn(), sellerEpochs: async () => new Map(), epochMetrics: async () => [] };
  const live = vi.fn(async () => 100n);
  const ctx = {
    address: ZeroAddress,
    chain: { sellerPoolsAddress: address, sellerPoolsRewardsAddress: address, usageAccountingAddress: address },
    stack: async () => ({ currentEpoch: 2, effectiveEpoch: 0, epochDuration: 604800, genesis: 0 }),
    indexer: () => indexer,
    requirePools: () => ({ provider: {}, totalPowerWeightAtEpoch: live }),
    poolRewards: () => ({ stakerEpochBudget: live }),
    usageAccounting: () => ({ totalWeightedPoolPointsByEpoch: live }),
  } as unknown as AntsContext;
  const methods: string[] = [];
  vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(r => {
    methods.push(r.method);
    if (r.method === 'poolEpochEmissions') return [true, 7n];
    if (r.method === 'agentEpochUsage') return [{ weightedPoints: 1n }];
    if (r.method === 'minStakeEpochs') return [1n];
    if (r.method === 'MAX_STAKE_EPOCHS') return [104n];
    return [100n];
  }));
  return { ctx, indexer, indexed, live, methods };
}

describe('pool loading', () => {
  it('uses matching indexed global/history data without per-seller detail requests or disconnected-wallet scans', async () => {
    const { ctx, indexer, live, methods } = setup();
    const result = await poolsView(ctx);
    expect(indexer.pool).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    expect(methods).not.toContain('poolWeightAtEpoch');
    expect(methods).not.toContain('poolEpochEmissions');
    expect(result.pools[0]?.yield).toMatchObject({ reward: '5', power: '90', status: 'settled', epoch: 1 });
    expect(result.pools[0]?.stakers).toBeNull();
  });
  it('does not read historical contracts for directory entries with no staking pool', async () => {
    const { ctx, indexed, methods } = setup();
    indexed.pools.push({ ...indexed.pools[0]!, agentId: 2, openPositions: 0, weight: '0', activeStake: '0', historicalYield: null });
    const result = await poolsView(ctx);
    expect(result.pools.find(p => p.agentId === 2)?.yield).toBeUndefined();
    expect(methods.filter(method => method === 'poolActiveStakeAtEpoch')).toHaveLength(1);
  });

  it('falls back to chain inputs when the indexer is on another epoch', async () => {
    const { ctx, live, methods } = setup(1);
    const result = await poolsView(ctx);
    expect(live).toHaveBeenCalled();
    expect(methods).toContain('poolWeightAtEpoch');
    expect(methods).toContain('poolEpochEmissions');
    expect(result.pools[0]?.yield).toMatchObject({ reward: '7', power: '100', epoch: 1 });
    expect(result.pools[0]?.volumeStatus).toBe('stale');
  });
  it('does not interpret missing historical fields as a zero-yield epoch', async () => {
    const { ctx, methods } = setup(2, false);
    const result = await poolsView(ctx);
    expect(methods).toContain('poolEpochEmissions');
    expect(result.pools[0]?.yield?.reward).toBe('7');
  });
});

it('loads optional staker counts separately and keeps failures unknown', async () => {
  const { ctx, indexer } = setup();
  indexer.pool.mockResolvedValueOnce({ stakers: 3 });
  expect(await poolStakerCounts(ctx)).toEqual({ 1: 3 });
  indexer.pool.mockRejectedValueOnce(new Error('indexer down'));
  expect(await poolStakerCounts(ctx)).toEqual({ 1: null });
});

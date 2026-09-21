import { beforeEach, describe, expect, it, vi } from 'vitest';
import { multicallRead, type MulticallRequest } from '@antseed/node/payments/browser';
import type { AntsContext } from './context.js';
import type { DisplaySnapshot } from './display-snapshot.js';
import { IndexerError, type IndexedPools } from './indexer.js';
import { overviewReads } from './overview-reads.js';
import { positions, move } from './positions.js';
import { poolsView, singlePool } from './pools.js';
import { poolYield } from './yield.js';

vi.mock('@antseed/node/payments/browser', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));
vi.mock('./explorer.js', () => ({ explorerSellers: async () => ({ byAddress: new Map(), byAgent: new Map() }) }));
vi.mock('./stake-eligibility.js', () => ({ stakeEligibility: async (_ctx: unknown, ids: number[]) => new Map(ids.map(id => [id, { owner, stakeable: true }])) }));
const owner = '0x0000000000000000000000000000000000000001';

function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const stack = { currentEpoch: 22, effectiveEpoch: 0, genesis: now - 22 * 604800 - 100, epochDuration: 604800, legacyStaking: owner };
  const epoch = (value: number) => ({ epoch: value, totalActiveStake: '1000', totalPowerWeight: '2000', totalSellerPoints: '10', totalWeightedPoolPoints: '20', totalBuyerPoints: '10', volumeUsdc: '0', requests: '0', stakerBudget: '100', complete: true });
  const snapshot: DisplaySnapshot = {
    chainId: 8453, indexedBlock: 100, indexedAt: now, epochs: [epoch(22), epoch(21)],
    pools: [22, 21].map(epoch => ({ agentId: 1, epoch, weight: '200', activeStake: '100', usagePoints: '3', weightedUsagePoints: '4', settledEmission: '10', settled: true, snapshotBlock: 90, lastBlockNumber: 99 })),
    positions: [{ id: 7, owner, agentId: 1, amount: '100', weightAmount: '200', stakeStartEpoch: 1, stakeEndEpoch: 30, closedAtEpoch: 0, withdrawn: false, maxLocked: true, restaked: false, closedBy: null, replacementIds: [], sourceId: null, returnedAmount: '0', slashedAmount: '0', createdAt: 1, closedAt: null }],
  };
  const indexed = {
    currentEpoch: 22, network: { current: epoch(22), last: epoch(21) },
    pools: [{ agentId: 1, seller: owner, registered: true, openPositions: 1, totalPositions: 2, weight: '200', activeStake: '100', powerShareBps: 1000, securityShareBps: '0', usagePoints: '3', weightedUsagePoints: '4', lastUsagePoints: '3', lastEmission: '10', lastEmissionSettled: true, lastWeight: '200', volumeUsdc: '0', lastVolumeUsdc: '0' }],
  } as IndexedPools;
  const indexer = {
    displaySnapshot: vi.fn(async () => snapshot), pools: vi.fn(async () => indexed),
    pool: vi.fn(async () => ({ stakers: 2, openPositions: 3 })),
    positions: vi.fn(async () => []), sellerEpochs: async () => new Map(), epochMetrics: async () => [],
  };
  const livePosition = (id: number) => ({ id, owner, agentId: 1, amount: 100n, weightAmount: 200n, stakeStartEpoch: 1, stakeEndEpoch: 30, closedAtEpoch: 0, withdrawn: false });
  const provider = { getBalance: vi.fn(async () => 9n), getBlockNumber: async () => 101 };
  const pools = {
    contractAddress: owner, provider,
    poolConfig: async () => ({ minStakeEpochs: 1, maxStakeEpochs: 104, maxSlashBps: 9000, minEarlyExitSlashBps: 0 }),
    allStakerPositionIds: vi.fn(async () => [7]), positionsBatch: vi.fn(async (ids: number[]) => ids.map(livePosition)),
    positionStatusesBatch: vi.fn(async () => [{ withdrawableEpoch: 1, maxLocked: false, slashBps: 1000 }]),
    totalPowerWeightAtEpoch: vi.fn(async () => 2000n), totalActiveStakeAtEpoch: vi.fn(async () => 1000n),
    moveStake: vi.fn(),
  };
  const rewards = { previewStakerRewards: vi.fn(async (ids: number[]) => ids.map(() => 15n)), stakerEpochBudget: vi.fn(async () => 100n) };
  const accounting = { totalWeightedPoolPointsByEpoch: vi.fn(async () => 20n) };
  const ctx = {
    address: owner, chain: { evmChainId: 8453, sellerPoolsAddress: owner, sellerPoolsRewardsAddress: owner, usageAccountingAddress: owner, sellerRegistryAddress: owner, emissionsGateAddress: owner, usageRewardsAddress: owner },
    stack: async () => stack, indexer: () => indexer, requirePools: () => pools, poolRewards: () => rewards,
    usageAccounting: () => accounting, provider: () => provider, antsToken: () => ({ contractAddress: owner }),
    localPositionIds: new Map<number, string>(), requireSigner: () => ({}),
  } as unknown as AntsContext;
  const requests: MulticallRequest[] = [];
  vi.mocked(multicallRead).mockImplementation(async (_provider, calls) => {
    requests.push(...calls);
    return calls.map(call => {
      if (call.method === 'positionWithdrawableEpoch' || call.method === 'minStakeEpochs') return [1n];
      if (call.method === 'earlyExitSlashBps') return [1000n];
      if (call.method === 'MAX_STAKE_EPOCHS') return [104n];
      if (call.method === 'usageEpochBudgets') return [7n, 8n];
      if (call.method === 'transfersEnabled' || call.method === 'transferWhitelist') return [true];
      return [100n];
    });
  });
  return { ctx, stack, snapshot, indexer, pools, rewards, accounting, requests, livePosition };
}

beforeEach(() => vi.clearAllMocks());

describe('indexed display / live financial read boundary', () => {
  it('removes three overview network calls but keeps wallet state and permissions live', async () => {
    const { ctx, stack, requests } = fixture();
    const result = await overviewReads(ctx, stack);
    expect(result).toMatchObject({ networkStake: 1000n, networkWeight: 2000n, stakerBudget: 100n, ants: 100n, eth: 9n, networkSource: { source: 'indexer', indexedBlock: 100 } });
    expect(requests).toHaveLength(11);
    expect(requests.map(row => row.method)).toEqual(expect.arrayContaining(['balanceOf', 'transferWhitelist', 'stakerTotalActiveStake', 'stakerPositionCount', 'getEpochEmission', 'usageEpochBudgets']));
    expect(requests.map(row => row.method)).not.toEqual(expect.arrayContaining(['totalActiveStakeAtEpoch', 'totalPowerWeightAtEpoch', 'stakerEpochBudget']));
  });

  it('falls back to live overview network reads with an explicit stale warning', async () => {
    const { ctx, stack, snapshot, requests } = fixture();
    snapshot.indexedAt -= 121;
    const result = await overviewReads(ctx, stack);
    expect(result.networkSource).toMatchObject({ source: 'chain', error: expect.stringContaining('stale') });
    expect(requests).toHaveLength(14);
  });

  it('uses indexed enumeration, records and max lock, retaining live penalties and exact rewards', async () => {
    const { ctx, pools, rewards, requests } = fixture();
    const result = await positions(ctx);
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(pools.positionsBatch).not.toHaveBeenCalled();
    expect(pools.positionStatusesBatch).not.toHaveBeenCalled();
    expect(requests.map(row => row.method)).toEqual(['positionWithdrawableEpoch', 'earlyExitSlashBps']);
    expect(rewards.previewStakerRewards).toHaveBeenCalledWith([7]);
    expect(result.positions[0]).toMatchObject({ id: 7, maxLocked: true, pendingReward: '15', slashBps: 1000, returnedAmount: '90' });
  });

  it('does not enumerate or preview rewards for an indexed empty wallet', async () => {
    const { ctx, snapshot, pools, rewards, requests } = fixture();
    snapshot.positions = [];
    expect((await positions(ctx)).positions).toEqual([]);
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(rewards.previewStakerRewards).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('overlays local transactions and reads their max-lock state live', async () => {
    const { ctx, pools, requests, snapshot, livePosition } = fixture();
    ctx.localPositionIds.set(7, owner);
    ctx.localPositionIds.set(8, owner);
    ctx.localPositionIds.set(9, '0x0000000000000000000000000000000000000002');
    Object.assign(snapshot.positions[0]!, { closedBy: 'move', closedAtEpoch: 23, replacementIds: [10] });
    pools.positionsBatch.mockResolvedValueOnce([livePosition(7), livePosition(8)]);
    const result = await positions(ctx);
    expect(pools.positionsBatch).toHaveBeenCalledWith([7, 8]);
    expect(result.positions.map(row => row.id)).toEqual([8, 7]);
    expect(result.positions.find(row => row.id === 7)?.closedBy).toBeUndefined();
    // Current and next epoch for each of the two live positions (max-lock changes apply next epoch).
    expect(requests.filter(row => row.method === 'positionMaxLockPowerAtEpoch')).toHaveLength(4);
  });

  it('removes transferred local positions from the display', async () => {
    const { ctx, pools, livePosition } = fixture();
    ctx.localPositionIds.set(7, owner);
    pools.positionsBatch.mockResolvedValueOnce([{ ...livePosition(7), owner: '0x0000000000000000000000000000000000000002' }]);
    expect((await positions(ctx)).positions).toEqual([]);
  });

  it('falls back to chain positions when Antscan fails, without hiding the failure', async () => {
    const { ctx, pools, indexer } = fixture();
    indexer.displaySnapshot.mockRejectedValueOnce(new IndexerError('offline', 'https://scan/graphql'));
    const result = await positions(ctx);
    expect(pools.allStakerPositionIds).toHaveBeenCalledOnce();
    expect(pools.positionStatusesBatch).toHaveBeenCalledOnce();
    expect(result.displaySource).toEqual({ source: 'chain', error: 'offline' });
  });

  it('never treats failed live reward or status reads as zero', async () => {
    const { ctx, rewards } = fixture();
    rewards.previewStakerRewards.mockRejectedValueOnce(new Error('RPC reward failure'));
    await expect(positions(ctx)).rejects.toThrow('RPC reward failure');
    vi.mocked(multicallRead).mockResolvedValueOnce([null]);
    await expect(positions(ctx)).rejects.toThrow('Position status read failed');
  });

  it('verifies ownership on chain before writes, regardless of indexed ownership', async () => {
    const { ctx, pools, indexer, livePosition } = fixture();
    pools.positionsBatch.mockResolvedValueOnce([{ ...livePosition(7), owner: '0x0000000000000000000000000000000000000002' }]);
    await expect(move(ctx, { positionIds: [7], toAgentId: 2 })).rejects.toThrow('not owned');
    expect(indexer.displaySnapshot).not.toHaveBeenCalled();
    expect(pools.moveStake).not.toHaveBeenCalled();
  });

  it.each([true, false])('uses matching indexed yield inputs without historical RPC (settled: %s)', async settled => {
    const { ctx, snapshot, requests, pools, rewards, stack, indexer } = fixture();
    snapshot.pools[1]!.settled = settled;
    const result = await poolsView(ctx);
    expect(result.pools[0]?.yield).toEqual({ ...poolYield(settled ? 10n : 20n, 100n, 21, stack.epochDuration, stack.genesis, settled), reward: settled ? '10' : '20', power: '200', minLockEpochs: 1, maxLockEpochs: 104 });
    expect(requests.map(row => row.method)).toEqual(['positionWeightAtEpoch', 'minStakeEpochs', 'MAX_STAKE_EPOCHS']);
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(pools.totalPowerWeightAtEpoch).not.toHaveBeenCalled();
    expect(rewards.stakerEpochBudget).not.toHaveBeenCalled();
    expect(indexer.pool).not.toHaveBeenCalled();
    expect(result.totalActiveStake).toBe('1000');
    expect((await singlePool(ctx, 1))).toMatchObject({ stakers: 2, openPositions: 3 });
    expect(indexer.pool).toHaveBeenCalledWith(1, 16);
  });

  it('prices your positions from the explorer and reads the chain only for ids it could not price', async () => {
    const { ctx, snapshot, requests, indexer } = fixture();
    snapshot.positions.push({ ...snapshot.positions[0]!, id: 8, stakeStartEpoch: 23, amount: '40' });
    indexer.positions.mockResolvedValueOnce([{ ...snapshot.positions[0]!, power: '150' }, { ...snapshot.positions[1]!, power: null }]);
    const result = await poolsView(ctx);
    expect(indexer.positions).toHaveBeenCalledWith(snapshot.positions[0]!.owner, false);
    expect(requests.filter(row => row.method === 'positionWeightAtEpoch').map(row => row.args)).toEqual([[8, 22]]);
    expect(result.pools[0]).toMatchObject({ yourStake: '100', yourPendingStake: '40', yourPower: '250', yourPositionIds: [7, 8] });
    expect(result.yourPendingStake).toBe('40');
  });

  it.each(['missing', 'zero', 'stale', 'offline'])('keeps %s history distinct without historical RPC amplification', async mode => {
    const { ctx, snapshot, requests, rewards, accounting, indexer } = fixture();
    if (mode === 'missing') snapshot.pools = snapshot.pools.filter(row => row.epoch === 22);
    if (mode === 'zero') snapshot.pools[1]!.settledEmission = '0';
    if (mode === 'stale') snapshot.indexedAt -= 121;
    if (mode === 'offline') {
      indexer.displaySnapshot.mockRejectedValue(new IndexerError('offline', 'https://scan/graphql'));
      indexer.pools.mockRejectedValue(new IndexerError('offline', 'https://scan/api'));
    }
    const result = await poolsView(ctx);
    expect(result.pools[0]?.yield).toMatchObject({ status: mode === 'zero' ? 'settled' : 'unavailable', reward: mode === 'zero' ? '0' : null });
    expect(requests.some(row => row.method === 'poolEpochEmissions')).toBe(false);
    expect(requests.some(row => ['poolWeightAtEpoch', 'poolActiveStakeAtEpoch', 'agentEpochUsage'].includes(row.method) && row.args?.includes(21))).toBe(false);
    expect(rewards.stakerEpochBudget).not.toHaveBeenCalledWith(21);
    expect(accounting.totalWeightedPoolPointsByEpoch).not.toHaveBeenCalledWith(21);
  });
});

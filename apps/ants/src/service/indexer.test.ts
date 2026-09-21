import { describe, expect, it, vi } from 'vitest';
import { AntscanIndexer, IndexerError } from './indexer.js';

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = url.replace('https://scan', '');
    const body = routes[path];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('AntscanIndexer', () => {
  it('does not bind the native browser fetch to the indexer instance', async () => {
    const nativeFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(function (this: unknown) {
      if (this instanceof AntscanIndexer) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(JSON.stringify({ pools: [], network: {}, currentEpoch: 1 })));
    });
    try { expect((await new AntscanIndexer('https://scan').pools()).pools).toEqual([]); }
    finally { nativeFetch.mockRestore(); }
  });
  it('normalises pool rows, keeping amounts as strings and ids as numbers', async () => {
    const indexer = new AntscanIndexer('https://scan/', fakeFetch({
      '/api/staking/pools': {
        currentEpoch: '22',
        network: { current: { epoch: '22', totalPowerWeight: '1000', totalActiveStake: '10', totalSellerPoints: '0', totalWeightedPoolPoints: '0', totalBuyerPoints: '0', volumeUsdc: '5', requests: '1', stakerBudget: '99' }, last: null },
        pools: [{ agentId: '84990', seller: '0xABCD', sellerName: 'Flash', registered: true, openPositions: 2, totalPositions: 3, securityShareBps: '100', activeStake: '250', pendingStake: '0', weight: '500', powerShareBps: 5000, lastWeight: '400', usagePoints: '1', weightedUsagePoints: '1', lastUsagePoints: '0', volumeUsdc: '7', lastVolumeUsdc: '6', lastEmission: '12', lastEmissionSettled: false, lastRewardPer1kPower: '30', projectedEmission: '0', projectedRewardPer1kPower: null }],
      },
    }));
    const pools = await indexer.pools();
    expect(pools.currentEpoch).toBe(22);
    expect(pools.network.current?.stakerBudget).toBe('99');
    expect(pools.network.last).toBeNull();
    expect(pools.pools[0]).toMatchObject({ agentId: 84990, seller: '0xabcd', sellerName: 'Flash', weight: '500', powerShareBps: 5000, lastRewardPer1kPower: '30', projectedRewardPer1kPower: null });
  });

  it('groups seller epochs by lowercase address and caches identical requests briefly', async () => {
    const calls: string[] = [];
    const indexer = new AntscanIndexer('https://scan', fakeFetch({
      '/api/staking/seller-epochs?epochs=3': { currentEpoch: '22', fromEpoch: '20', rows: [
        { seller: '0xAA', epoch: '22', agentId: null, volumeUsdc: '5', points: '5', weightedPoints: '0', requests: '2' },
        { seller: '0xaa', epoch: '21', agentId: '7', volumeUsdc: '9', points: '9', weightedPoints: '0', requests: '1' },
      ] },
    }, calls));
    const first = await indexer.sellerEpochs(3);
    await indexer.sellerEpochs(3);
    expect(calls).toHaveLength(1);
    expect(first.get('0xaa')?.map((row) => row.epoch)).toEqual([22, 21]);
  });

  it('parses positions including close metadata', async () => {
    const indexer = new AntscanIndexer('https://scan', fakeFetch({
      '/api/staking/positions?owner=0xabc&includeClosed=1': { positions: [
        { id: '7', owner: '0xABC', agentId: '1', amount: '10', weightAmount: '12', stakeStartEpoch: '20', stakeEndEpoch: '30', closedAtEpoch: '22', closedBy: 'split', replacementIds: ['8', '9'], sourceId: null, restaked: false, maxLocked: false, withdrawn: false, returnedAmount: '0', slashedAmount: '0', createdAt: 1, closedAt: 2 },
      ] },
    }));
    const [position] = await indexer.positions('0xABC');
    expect(position).toMatchObject({ id: 7, closedAtEpoch: 22, closedBy: 'split', replacementIds: [8, 9], sourceId: null });
  });

  it('turns HTTP failures into IndexerError and does not cache them', async () => {
    const calls: string[] = [];
    const indexer = new AntscanIndexer('https://scan', fakeFetch({}, calls));
    await expect(indexer.pools()).rejects.toBeInstanceOf(IndexerError);
    await expect(indexer.pools()).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(2);
  });
});

it('does not invent a zero staker count or historical volume when indexer fields are absent', async () => {
  const indexer = new AntscanIndexer('https://scan', fakeFetch({
    '/api/staking/pools/1?epochs=8': { pool: null, epochs: [{ epoch: 21 }, { epoch: 20, volumeUsdc: '0' }] },
  }));
  const detail = await indexer.pool(1);
  expect(detail.stakers).toBeNull();
  expect(detail.epochs.map(row => [row.epoch, row.volumeUsdc])).toEqual([[20, '0']]);
});

it('preserves missing yield inputs and incomplete network snapshots for RPC fallback', async () => {
  const indexer = new AntscanIndexer('https://scan', fakeFetch({
    '/api/staking/pools': { currentEpoch: 22, network: { current: { epoch: 22 } }, pools: [
      { agentId: 1, lastWeight: '0' },
      { agentId: 2, lastWeight: '0', lastEmission: '0', lastEmissionSettled: true },
    ] },
  }));
  const data = await indexer.pools();
  expect(data.network.current?.complete).toBe(false);
  expect(data.pools[0]?.historicalYield).toBeNull();
  expect(data.pools[1]?.historicalYield).toEqual({ power: '0', reward: '0', settled: true });
});

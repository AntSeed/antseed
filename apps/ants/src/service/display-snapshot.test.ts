import { describe, expect, it, vi } from 'vitest';
import { AntscanIndexer, IndexerError } from './indexer.js';
import { displayData } from './display-snapshot.js';
import type { AntsContext, ResolvedStack } from './context.js';

const owner = '0x0000000000000000000000000000000000000001';
const checkpoint = () => ({ status: { base: { id: 8453, block: { number: 100, timestamp: Math.floor(Date.now() / 1000) } } } });
const epoch = (value: number) => ({ epoch: String(value), totalActiveStake: '100', totalPowerWeight: '200', totalSellerPoints: '3', totalBuyerPoints: '4', totalWeightedPoolPoints: '5', volumeUsdc: '6', requests: '7', stakerBudget: '8', snapshotBlock: 90, lastBlockNumber: 99 });
const position = (id = 7) => ({ id: String(id), owner, agentId: '1', amount: '100', weightAmount: '100', stakeStartEpoch: '1', stakeEndEpoch: '30', closedAtEpoch: '0', withdrawn: false, maxLocked: true, restaked: false, closedBy: null, replacementIds: [], sourceId: null, returnedAmount: '0', slashedAmount: '0', createdAt: 1, closedAt: null, lastBlockNumber: 50 });
const page = (items: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ items, pageInfo: { hasNextPage, endCursor } });
function responseBody() {
  return { data: {
    _meta: checkpoint(), epochs: page([epoch(22), epoch(21)]),
    pools: page([{ agentId: '1', epoch: '21', weight: '200', activeStake: '100', usagePoints: '2', weightedUsagePoints: '3', settledEmission: '4', settled: true, snapshotBlock: 90, lastBlockNumber: 99 }]),
    positions: page([position()]),
  } };
}
function fixture(body: unknown = responseBody()) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)));
  const indexer = new AntscanIndexer('https://scan/', fetchImpl);
  const ctx = { chain: { evmChainId: 8453 }, address: owner, indexer: () => indexer } as unknown as AntsContext;
  const stack = { currentEpoch: 22, genesis: Math.floor(Date.now() / 1000) - 22 * 604800 - 100, epochDuration: 604800 } as ResolvedStack;
  return { fetchImpl, indexer, ctx, stack };
}

describe('Antscan display snapshots', () => {
  it('fetches and shares one snapshot across display consumers, retaining checkpoint and row blocks', async () => {
    const { indexer, fetchImpl, ctx, stack } = fixture();
    const [first, second] = await Promise.all([displayData(ctx, stack), displayData(ctx, stack)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.source).toMatchObject({ source: 'indexer', indexedBlock: 100 });
    expect(first.snapshot?.epochs[0]).toMatchObject({ epoch: 22, totalActiveStake: '100', snapshotBlock: 90 });
    expect(first.snapshot?.positions[0]).toMatchObject({ id: 7, owner, maxLocked: true, lastBlockNumber: 50 });
    indexer.invalidate();
    await indexer.displaySnapshot(22, owner);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('follows each dataset cursor and never treats the first page as a complete position list', async () => {
    const body = responseBody();
    body.data.positions = page([position(7)], true, 'next-page');
    const { indexer, fetchImpl } = fixture(body);
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body))).mockResolvedValueOnce(new Response(JSON.stringify({ data: { _meta: body.data._meta, positions: page([position(8)]) } })));
    expect((await indexer.displaySnapshot(22, owner)).positions.map(row => row.id)).toEqual([7, 8]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const request = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).query;
    expect(request).toContain('after:"next-page"');
    expect(request).not.toContain('poolEpochs');
  });

  it('does not query positions for a disconnected wallet', async () => {
    const { indexer, fetchImpl } = fixture();
    const snapshot = await indexer.displaySnapshot(22, '0x0000000000000000000000000000000000000000');
    expect(snapshot.positions).toEqual([]);
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).query).not.toContain('stakePositions');
  });

  it.each(['wrong-chain', 'stale', 'future-clock', 'previous-epoch'])('falls back explicitly for %s snapshots', async mode => {
    const body = responseBody();
    const now = Math.floor(Date.now() / 1000);
    if (mode === 'wrong-chain') body.data._meta.status.base.id = 31337;
    if (mode === 'stale') body.data._meta.status.base.block.timestamp = now - 121;
    if (mode === 'future-clock') body.data._meta.status.base.block.timestamp = now + 31;
    if (mode === 'previous-epoch') body.data._meta.status.base.block.timestamp = now - 101;
    const { ctx, stack } = fixture(body);
    const display = await displayData(ctx, stack);
    expect(display.snapshot).toBeNull();
    expect(display.source).toMatchObject({ source: 'chain', error: expect.any(String) });
  });

  it.each(['principal', 'position-owner', 'position-flag', 'network', 'current-epoch', 'duplicate', 'ahead-of-checkpoint'])('rejects incomplete or inconsistent %s data without inventing zeros', async mode => {
    const body = responseBody();
    if (mode === 'principal') delete (body.data.pools.items[0] as Record<string, unknown>).activeStake;
    if (mode === 'position-owner') (body.data.positions.items[0] as Record<string, unknown>).owner = '0x0000000000000000000000000000000000000002';
    if (mode === 'position-flag') delete (body.data.positions.items[0] as Record<string, unknown>).maxLocked;
    if (mode === 'network') delete (body.data.epochs.items[0] as Record<string, unknown>).stakerBudget;
    if (mode === 'current-epoch') body.data.epochs.items = [epoch(21)];
    if (mode === 'duplicate') body.data.positions.items.push(position());
    if (mode === 'ahead-of-checkpoint') (body.data.pools.items[0] as Record<string, unknown>).snapshotBlock = 101;
    const { indexer } = fixture(body);
    await expect(indexer.displaySnapshot(22, owner)).rejects.toBeInstanceOf(IndexerError);
  });

  it('accepts a complete empty wallet and explicit zero-valued historical rows', async () => {
    const body = responseBody();
    body.data.positions.items = [];
    Object.assign(body.data.pools.items[0] as object, { weight: '0', activeStake: '0', usagePoints: '0', weightedUsagePoints: '0', settledEmission: '0' });
    const { indexer } = fixture(body);
    const snapshot = await indexer.displaySnapshot(22, owner);
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.pools[0]?.activeStake).toBe('0');
  });

  it.each(['cursor', 'checkpoint', 'second-page-error'])('rejects a broken %s during pagination and does not cache partial results', async mode => {
    const body = responseBody();
    body.data.positions = page([position(7)], true, 'same');
    const second = { data: { _meta: checkpoint(), positions: page([position(8)], mode === 'cursor', 'same') } };
    if (mode === 'checkpoint') second.data._meta.status.base.block.number++;
    const { indexer, fetchImpl } = fixture();
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body))).mockResolvedValueOnce(new Response(JSON.stringify(mode === 'second-page-error' ? { errors: [{ message: 'unavailable' }] } : second)));
    await expect(indexer.displaySnapshot(22, owner)).rejects.toBeInstanceOf(IndexerError);
    expect((await indexer.displaySnapshot(22, owner)).positions).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries after HTTP and JSON failures rather than caching errors', async () => {
    const { indexer, fetchImpl } = fixture();
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('not json'));
    await expect(indexer.displaySnapshot(22, owner)).rejects.toThrow('HTTP 503');
    await expect(indexer.displaySnapshot(22, owner)).rejects.toBeInstanceOf(IndexerError);
    expect((await indexer.displaySnapshot(22, owner)).positions).toHaveLength(1);
  });
});

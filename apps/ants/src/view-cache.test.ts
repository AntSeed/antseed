import { describe, expect, it } from 'vitest';
import { ViewCache } from './view-cache.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('ViewCache', () => {
  it('shares one load between identical concurrent reads and caches the result', async () => {
    const cache = new ViewCache(60_000);
    let loads = 0;
    const load = async () => { loads += 1; await tick(); return { loads }; };
    const [a, b] = await Promise.all([cache.read('overview', load), cache.read('overview', load)]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    expect(await cache.read('overview', load)).toBe(a);
    expect(loads).toBe(1);
  });

  it('runs different views one after another, in request order', async () => {
    const cache = new ViewCache();
    const order: string[] = [];
    const slow = cache.read('pools', async () => { order.push('pools:start'); await tick(); await tick(); order.push('pools:end'); return 1; });
    const fast = cache.read('positions', async () => { order.push('positions:start'); order.push('positions:end'); return 2; });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['pools:start', 'pools:end', 'positions:start', 'positions:end']);
  });

  it('does not cache failures and keeps serving after one', async () => {
    const cache = new ViewCache();
    await expect(cache.read('rewards', async () => { throw new Error('rpc down'); })).rejects.toThrow('rpc down');
    expect(await cache.read('rewards', async () => 'ok')).toBe('ok');
  });

  it('expires entries after the TTL and on invalidate', async () => {
    const cache = new ViewCache(1);
    let loads = 0;
    const load = async () => ++loads;
    await cache.read('overview', load);
    await tick();
    await cache.read('overview', load);
    expect(loads).toBe(2);
    const long = new ViewCache(60_000);
    await long.read('overview', load);
    long.invalidate();
    await long.read('overview', load);
    expect(loads).toBe(4);
  });
});

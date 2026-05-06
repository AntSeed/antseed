/**
 * Unit tests for InProcessResponseCache.
 *
 * Uses node:test (matches the rest of this package). The cache exposes a
 * `now` field we override to drive the freshness/staleness state machine
 * deterministically without sleeping.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InProcessResponseCache, hashPayload } from './http/response-cache.js';
import type { CacheKeyConfig } from './http/response-cache.js';

interface Sample {
  value: number;
}

function fixedClock(initial: number): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function makeConfig(
  compute: () => Promise<{ payload: Sample; sourceUpdatedAt?: number | null }>,
  freshMs = 1000,
  staleMs = 10_000,
): CacheKeyConfig<Sample> {
  return { compute, freshMs, staleMs };
}

describe('InProcessResponseCache', () => {
  it('cold read computes synchronously and tags state=cold', async () => {
    const cache = new InProcessResponseCache();
    let calls = 0;
    const env = await cache.read('k', makeConfig(async () => {
      calls++;
      return { payload: { value: 1 }, sourceUpdatedAt: 100 };
    }));
    assert.equal(env.state, 'cold');
    assert.equal(env.payload.value, 1);
    assert.equal(env.sourceUpdatedAt, 100);
    assert.equal(calls, 1);
    assert.equal(env.etag, hashPayload({ value: 1 }));
  });

  it('fresh read serves cached bytes without recomputing', async () => {
    const cache = new InProcessResponseCache();
    const clock = fixedClock(1_000_000);
    cache.now = clock.now;
    let calls = 0;
    const cfg = makeConfig(async () => {
      calls++;
      return { payload: { value: calls } };
    });
    await cache.read('k', cfg);
    clock.advance(500); // still inside freshMs=1000
    const second = await cache.read('k', cfg);
    assert.equal(second.state, 'fresh');
    assert.equal(second.payload.value, 1, 'no recompute should have happened');
    assert.equal(calls, 1);
  });

  it('stale read returns cached bytes immediately and triggers a single background refresh', async () => {
    const cache = new InProcessResponseCache();
    const clock = fixedClock(1_000_000);
    cache.now = clock.now;
    let calls = 0;
    // Deferred lets us hold the second compute open so we can prove SWR
    // returns stale bytes *before* the refresh resolves. Box the resolver in
    // a tuple so its type isn't narrowed to `null` by control-flow analysis.
    const deferred: { resolve: (v: { payload: Sample }) => void }[] = [];
    const cfg = makeConfig(
      async () => {
        calls++;
        if (calls === 1) return { payload: { value: 1 } };
        return new Promise<{ payload: Sample }>((resolve) => {
          deferred.push({ resolve });
        });
      },
      1000,
      10_000,
    );
    await cache.read('k', cfg); // populate
    clock.advance(2000); // past fresh, inside stale
    const stale = await cache.read('k', cfg);
    assert.equal(stale.state, 'stale');
    assert.equal(stale.payload.value, 1);
    assert.equal(calls, 2, 'background refresh should have started');

    // Concurrent reads during the in-flight refresh keep getting stale (no
    // second refresh kicked off).
    const stale2 = await cache.read('k', cfg);
    assert.equal(stale2.state, 'stale');
    assert.equal(calls, 2, 'single-flight: no extra refresh');

    // Let the refresh finish; the next read should now be fresh with the new value.
    assert.equal(deferred.length, 1);
    deferred[0]!.resolve({ payload: { value: 2 } });
    await new Promise((r) => setImmediate(r));
    const fresh = await cache.read('k', cfg);
    assert.equal(fresh.state, 'fresh');
    assert.equal(fresh.payload.value, 2);
  });

  it('past staleMs blocks on recompute', async () => {
    const cache = new InProcessResponseCache();
    const clock = fixedClock(1_000_000);
    cache.now = clock.now;
    let calls = 0;
    const cfg = makeConfig(async () => {
      calls++;
      return { payload: { value: calls } };
    });
    await cache.read('k', cfg);
    clock.advance(20_000); // past staleMs=10_000
    const env = await cache.read('k', cfg);
    // Past staleMs, cache must not serve old bytes — it blocks on recompute
    // and returns the new payload.
    assert.equal(env.payload.value, 2);
    assert.equal(calls, 2);
  });

  it('invalidate flips fresh entries into the stale branch on next read', async () => {
    const cache = new InProcessResponseCache();
    const clock = fixedClock(1_000_000);
    cache.now = clock.now;
    let calls = 0;
    const cfg = makeConfig(async () => {
      calls++;
      return { payload: { value: calls } };
    });
    await cache.read('k', cfg);
    cache.invalidate('k');
    // Still inside freshMs by wall time, but invalidated — read should be stale.
    const env = await cache.read('k', cfg);
    assert.equal(env.state, 'stale');
    // SWR fired a background refresh; allow it to land.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2);
  });

  it('etag is stable across recomputes that produce identical bytes', async () => {
    const cache = new InProcessResponseCache();
    const clock = fixedClock(1_000_000);
    cache.now = clock.now;
    const cfg = makeConfig(async () => ({ payload: { value: 42 } }));
    const first = await cache.read('k', cfg);
    clock.advance(20_000); // force recompute
    const second = await cache.read('k', cfg);
    assert.equal(first.etag, second.etag, 'identical payload bytes must yield the same ETag');
  });

  it('cacheable=false on cold start does not store the slot — next read recomputes', async () => {
    const cache = new InProcessResponseCache();
    let calls = 0;
    const cfg = makeConfig(async () => {
      calls++;
      return { payload: { value: calls }, cacheable: false };
    });
    const env1 = await cache.read('k', cfg);
    assert.equal(env1.payload.value, 1);
    // Cold-start refused-to-cache → next read must recompute, not serve env1.
    const env2 = await cache.read('k', cfg);
    assert.equal(env2.payload.value, 2);
    assert.equal(calls, 2);
  });

  it('cacheable=false on SWR refresh keeps the previously cached envelope intact', async () => {
    const cache = new InProcessResponseCache();
    const clock = fixedClock(1_000_000);
    cache.now = clock.now;
    let calls = 0;
    const cfg = makeConfig(
      async () => {
        calls++;
        // First call: cacheable. Second (refresh): cacheable=false (transient
        // partial failure). Third: back to cacheable.
        return { payload: { value: calls }, cacheable: calls !== 2 };
      },
      1000,
      10_000,
    );
    await cache.read('k', cfg); // populate (calls=1, cacheable)
    clock.advance(2000); // past fresh, into stale
    const stale1 = await cache.read('k', cfg); // returns stale=value:1, kicks calls=2 in background (cacheable=false)
    assert.equal(stale1.payload.value, 1);
    await new Promise((r) => setImmediate(r));
    // Refresh resolved cacheable=false → cached envelope is still value:1.
    // Read should still see stale=value:1 (entry preserved).
    const stale2 = await cache.read('k', cfg);
    assert.equal(stale2.state, 'stale');
    assert.equal(stale2.payload.value, 1, 'previous cacheable payload preserved');
    assert.equal(calls, 3, 'second read kicks another refresh attempt');
  });

  it('failed background refresh leaves the previous entry intact and clears in-flight', async () => {
    const cache = new InProcessResponseCache();
    const clock = fixedClock(1_000_000);
    cache.now = clock.now;
    let calls = 0;
    const cfg = makeConfig(
      async () => {
        calls++;
        if (calls === 2) throw new Error('boom');
        return { payload: { value: calls } };
      },
      1000,
      10_000,
    );
    await cache.read('k', cfg); // calls=1, populate
    clock.advance(2000);
    const stale = await cache.read('k', cfg); // calls=2 in background, will reject
    assert.equal(stale.state, 'stale');
    // Wait for the rejected refresh to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Old bytes must still be there; the slot must accept a new refresh.
    const stale2 = await cache.read('k', cfg);
    assert.equal(stale2.payload.value, 1, 'previous payload preserved on refresh failure');
    // The third call should run because in-flight was cleared.
    assert.equal(calls, 3);
  });
});

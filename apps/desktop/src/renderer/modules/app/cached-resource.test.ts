import { describe, expect, it, vi } from 'vitest';
import { createCachedResource } from './cached-resource';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createCachedResource', () => {
  it('deduplicates requests and retains loaded data', async () => {
    const request = deferred<string[]>();
    const load = vi.fn(() => request.promise);
    const resource = createCachedResource({ load });

    const first = resource.refresh();
    const second = resource.refresh();

    expect(load).toHaveBeenCalledTimes(1);
    expect(resource.getSnapshot()).toMatchObject({ data: null, loading: true });

    request.resolve(['chat']);
    await Promise.all([first, second]);

    expect(resource.getSnapshot()).toEqual({
      data: ['chat'],
      loading: false,
      refreshing: false,
      error: null,
    });
  });

  it('keeps stale data when a refresh fails', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(['app'])
      .mockRejectedValueOnce(new Error('offline'));
    const resource = createCachedResource<string[]>({ load });

    await resource.refresh();
    const refresh = resource.refresh();

    expect(resource.getSnapshot()).toMatchObject({ data: ['app'], refreshing: true });
    await refresh;

    expect(resource.getSnapshot()).toEqual({
      data: ['app'],
      loading: false,
      refreshing: false,
      error: 'offline',
    });
  });

  it('shares polling across active consumers', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue(['chat']);
    const resource = createCachedResource({ load, pollMs: 3_000 });

    const releaseFirst = resource.activate();
    const releaseSecond = resource.activate();
    await vi.runAllTicks();
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);

    releaseFirst();
    releaseSecond();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

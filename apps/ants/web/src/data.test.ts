import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  value: undefined as unknown,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  effects: [] as Array<() => void | (() => void)>,
  mounted: false,
}));

vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useState: (initial: () => unknown) => {
    if (!hooks.mounted) hooks.value = initial();
    return [hooks.value, (next: unknown) => { hooks.value = typeof next === 'function' ? next(hooks.value) : next; }];
  },
  useRef: (value: unknown) => {
    const index = hooks.refIndex++;
    return hooks.refs[index] ??= { current: value };
  },
  useEffect: (effect: () => void | (() => void)) => {
    if (!hooks.mounted) hooks.effects.push(effect);
  },
}));

let data: typeof import('./data');
let cleanups: Array<() => void>;
let resolveRead: (value: number) => void;
let rejectRead: (error: Error) => void;
let fetcher: ReturnType<typeof vi.fn<() => Promise<number>>>;

function render() {
  hooks.refIndex = 0;
  const result = data.usePageData('rewards', fetcher);
  if (!hooks.mounted) {
    hooks.mounted = true;
    for (const effect of hooks.effects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
  }
  return result;
}

beforeEach(async () => {
  vi.resetModules();
  hooks.value = undefined;
  hooks.refs = [];
  hooks.refIndex = 0;
  hooks.effects = [];
  hooks.mounted = false;
  cleanups = [];
  data = await import('./data');
  fetcher = vi.fn(() => new Promise<number>((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }));
  render();
  resolveRead(100);
  await Promise.resolve();
});

afterEach(() => { for (const cleanup of cleanups) cleanup(); });

describe('post-confirmation data refresh', () => {
  it('does not reconcile balances for ordinary focus or cache refreshes', () => {
    data.invalidateAll();
    expect(render()).toMatchObject({ data: 100, loading: true, reconciling: false });
  });

  it('reconciles only confirmed changes and finishes when fresh data arrives', async () => {
    data.invalidateAll({ confirmed: true });
    expect(render()).toMatchObject({ data: 100, loading: true, reconciling: true });
    resolveRead(0);
    await Promise.resolve();
    expect(render()).toMatchObject({ data: 0, loading: false, reconciling: false });
  });

  it('preserves reconciliation after failure and during manual retry', async () => {
    data.invalidateAll({ confirmed: true });
    rejectRead(new Error('RPC unavailable'));
    await new Promise(resolve => setImmediate(resolve));
    expect(render()).toMatchObject({ data: 100, loading: false, reconciling: true, error: 'RPC unavailable' });
    render().refresh();
    expect(render()).toMatchObject({ loading: true, reconciling: true, error: null });
    resolveRead(0);
    await Promise.resolve();
    expect(render()).toMatchObject({ data: 0, loading: false, reconciling: false });
  });

  it('does not let a background read erase pending confirmed changes', async () => {
    data.invalidateAll();
    const resolveBackground = resolveRead;
    data.invalidateAll({ confirmed: true });
    resolveBackground(100);
    await Promise.resolve();
    expect(render()).toMatchObject({ loading: true, reconciling: true });
    data.invalidateAll();
    expect(render()).toMatchObject({ loading: true, reconciling: true });
    resolveRead(0);
    await Promise.resolve();
    expect(render()).toMatchObject({ data: 0, reconciling: false });
  });

  it('clears reconciliation and old balances on wallet changes', () => {
    data.invalidateAll({ confirmed: true });
    data.invalidateAll({ clear: true });
    expect(render()).toMatchObject({ data: null, loading: true, reconciling: false });
  });
});

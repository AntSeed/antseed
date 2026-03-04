import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadStoreModule() {
  vi.resetModules();
  return import('./ui-shell-store');
}

describe('ui-shell-store', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses buyer-mode defaults at module load', async () => {
    const store = await loadStoreModule();
    expect(store.getUiShellState()).toEqual({
      activeView: 'chat',
      appMode: 'connect',
      earningsPeriod: 'month',
    });
  });

  it('publishes state updates to subscribers', async () => {
    const store = await loadStoreModule();
    const updates: Array<{ next: unknown; prev: unknown }> = [];

    const unsubscribe = store.subscribeUiShellState((next, prev) => {
      updates.push({ next, prev });
    });

    store.setActiveView('peers');
    store.setEarningsPeriod('week');

    expect(updates).toHaveLength(2);
    expect((updates[0].next as { activeView: string }).activeView).toBe('peers');
    expect((updates[1].next as { earningsPeriod: string }).earningsPeriod).toBe('week');

    unsubscribe();
  });

  it('keeps mode pinned to connect', async () => {
    const store = await loadStoreModule();
    store.setAppMode('connect');
    expect(store.getUiShellState().appMode).toBe('connect');
  });
});

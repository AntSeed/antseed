import { describe, expect, it } from 'vitest';
import { VIEW_NAMES, type ViewName } from '../types';
import { getViewRegistryEntry, preloadView, preloadViews, VIEW_REGISTRY } from './viewRegistry';

describe('view registry', () => {
  it('registers exactly one lazy component for every known view', () => {
    expect(Object.keys(VIEW_REGISTRY).sort()).toEqual([...VIEW_NAMES].sort());

    for (const view of VIEW_NAMES) {
      const entry = getViewRegistryEntry(view);
      expect(entry.component).toBe(VIEW_REGISTRY[view].component);
      expect(typeof entry.preload).toBe('function');
      expect(typeof entry.receivesOnSelectView).toBe('boolean');
    }
  });

  it('passes navigation callbacks only to views that need to change pages', () => {
    const navigationViews = VIEW_NAMES.filter((view) => getViewRegistryEntry(view).receivesOnSelectView);

    expect(navigationViews).toEqual(['chat', 'discover'] satisfies ViewName[]);
  });

  it('reuses the same preload promise for repeated preload requests', () => {
    const entry = getViewRegistryEntry('connection');

    expect(entry.preload()).toBe(entry.preload());
  });

  it('can preload multiple views through the public helper', async () => {
    const loaded = await preloadViews(['connection']);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toBe(await preloadView('connection'));
  });
});

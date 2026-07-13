import { describe, expect, it } from 'vitest';
import { VIEW_NAMES, type ViewName } from '../types';
import { VIEW_WINDOW_PRESETS } from '../../../shared/view-windows';
import { getViewRegistryEntry, navViews, preloadView, preloadViews, viewsForPreload, VIEW_REGISTRY } from './viewRegistry';

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

    expect(navigationViews).toEqual(['home', 'explore', 'model', 'tools', 'preferences', 'credits', 'deposit', 'activity', 'rewards', 'chat', 'help', 'developer'] satisfies ViewName[]);
  });

  it('reuses the same preload promise for repeated preload requests', () => {
    const entry = getViewRegistryEntry('overview');

    expect(entry.preload()).toBe(entry.preload());
  });

  it('can preload multiple views through the public helper', async () => {
    const loaded = await preloadViews(['overview']);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toBe(await preloadView('overview'));
  });

  it('derives the nav rail from registry metadata in slide order', () => {
    expect(navViews('main').map((entry) => entry.view)).toEqual(
      ['home', 'explore', 'tools', 'preferences', 'credits', 'chat', 'help'] satisfies ViewName[],
    );
    expect(navViews('dev').map((entry) => entry.view)).toEqual(['developer'] satisfies ViewName[]);
    for (const entry of navViews('main')) {
      expect(entry.nav.label).toBeTruthy();
      expect(entry.nav.icon).toBeTruthy();
    }
  });

  it('splits route preloading into startup and idle tiers', () => {
    expect(viewsForPreload('eager')).toEqual(
      ['home', 'explore', 'tools', 'credits', 'chat'] satisfies ViewName[],
    );
    expect(viewsForPreload('idle')).toEqual(['preferences', 'deposit', 'activity', 'rewards', 'help', 'developer'] satisfies ViewName[]);
  });

  it('assigns every view a slide position', () => {
    for (const view of VIEW_NAMES) {
      expect(getViewRegistryEntry(view).slideIndex).toBeGreaterThanOrEqual(0);
    }
    // Drill-in views slide in from the right of the tab that opens them.
    expect(getViewRegistryEntry('model').slideIndex).toBeGreaterThan(getViewRegistryEntry('explore').slideIndex);
    expect(getViewRegistryEntry('credits').slideIndex).toBeGreaterThan(getViewRegistryEntry('preferences').slideIndex);
    expect(getViewRegistryEntry('deposit').slideIndex).toBeGreaterThan(getViewRegistryEntry('credits').slideIndex);
    expect(getViewRegistryEntry('activity').slideIndex).toBeGreaterThan(getViewRegistryEntry('credits').slideIndex);
    expect(getViewRegistryEntry('rewards').slideIndex).toBeGreaterThan(getViewRegistryEntry('credits').slideIndex);
  });

  it('covers every view in the shared window-preset map', () => {
    // The main process sizes the window from this map (src/shared); a view
    // missing here would silently fall back to the standard preset.
    expect(Object.keys(VIEW_WINDOW_PRESETS).sort()).toEqual([...VIEW_NAMES].sort());
  });
});

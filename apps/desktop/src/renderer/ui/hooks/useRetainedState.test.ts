import { describe, expect, it } from 'vitest';
import { resolveRetainedUpdate, writeRetainedState } from './useRetainedState';

describe('resolveRetainedUpdate', () => {
  it('returns direct state values', () => {
    expect(resolveRetainedUpdate('old', 'new')).toBe('new');
  });

  it('resolves functional state updates from the current value', () => {
    expect(resolveRetainedUpdate(2, (current) => current + 3)).toBe(5);
  });
});

describe('writeRetainedState', () => {
  it('writes the resolved value through to the retained cache', () => {
    const cache = { search: 'old', count: 1 };

    const value = writeRetainedState(cache, 'search', 'new');

    expect(value).toBe('new');
    expect(cache.search).toBe('new');
    expect(cache.count).toBe(1);
  });
});

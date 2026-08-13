import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  loadFavoriteModels,
  VPR_FAVORITES_STORAGE_KEY,
} from './favorites.js';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
});

afterEach(() => values.clear());

test('migrates legacy canonical favorite keys on load', () => {
  values.set(VPR_FAVORITES_STORAGE_KEY, JSON.stringify([
    'claudefable5',
    'gpt5.6sol',
    'glm5.2',
  ]));

  assert.deepEqual([...loadFavoriteModels()].sort(), ['fable5', 'glm52', 'gpt56sol']);
});

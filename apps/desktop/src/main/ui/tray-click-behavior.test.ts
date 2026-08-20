import test from 'node:test';
import assert from 'node:assert/strict';

import { configureTrayClickBehavior } from './tray-click-behavior.js';

test('macOS emits every individual tray click', () => {
  const values: boolean[] = [];

  configureTrayClickBehavior({
    setIgnoreDoubleClickEvents: (ignore) => values.push(ignore),
  }, 'darwin');

  assert.deepEqual(values, [true]);
});

test('other platforms keep their native tray click behavior', () => {
  const values: boolean[] = [];

  configureTrayClickBehavior({
    setIgnoreDoubleClickEvents: (ignore) => values.push(ignore),
  }, 'win32');

  assert.deepEqual(values, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { presentVprMenuBarWindow } from './vpr-menu-bar-presentation.js';

function createWindowSpy(): {
  window: { show: () => void; showInactive: () => void };
  calls: string[];
} {
  const calls: string[] = [];
  return {
    window: {
      show: () => calls.push('show'),
      showInactive: () => calls.push('showInactive'),
    },
    calls,
  };
}

test('macOS presents the non-activating panel through the key window path', () => {
  const { window, calls } = createWindowSpy();

  presentVprMenuBarWindow(window, 'darwin');

  assert.deepEqual(calls, ['show']);
});

test('other platforms preserve inactive popup presentation', () => {
  const { window, calls } = createWindowSpy();

  presentVprMenuBarWindow(window, 'win32');

  assert.deepEqual(calls, ['showInactive']);
});

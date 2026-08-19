import assert from 'node:assert/strict';
import test from 'node:test';

import { toolDesktopAppName } from './tool-resume.js';

test('GooeyPi profiles auto-detect the GooeyPi desktop application', () => {
  assert.equal(toolDesktopAppName('gooeypi'), 'GooeyPi');
});

test('Hermes profiles auto-detect the Hermes desktop application', () => {
  assert.equal(toolDesktopAppName('hermes'), 'Hermes');
});

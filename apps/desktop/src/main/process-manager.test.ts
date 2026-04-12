import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import { resolveCommandArgs } from './process-manager.js';

test('resolveCommandArgs launches the grouped buyer runtime command without forcing the default router', () => {
  const args = resolveCommandArgs({
    mode: 'connect',
    router: 'local',
    configPath: '/tmp/antseed-config.json',
    verbose: true,
  });

  assert.deepEqual(args, [
    '--verbose',
    '--config', '/tmp/antseed-config.json',
    '--data-dir', `${homedir()}/.antseed`,
    'buyer', 'start',
  ]);
});

test('resolveCommandArgs forwards non-default routers', () => {
  const args = resolveCommandArgs({
    mode: 'connect',
    router: 'custom-router',
    configPath: '/tmp/antseed-config.json',
  });

  assert.deepEqual(args, [
    '--config', '/tmp/antseed-config.json',
    '--data-dir', `${homedir()}/.antseed`,
    'buyer', 'start', '--router', 'custom-router',
  ]);
});

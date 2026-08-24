import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ProcessManager, resolveCommandArgs } from './process-manager.js';

test('resolveCommandArgs launches the grouped buyer runtime command without forcing the default router', () => {
  const args = resolveCommandArgs({
    mode: 'connect',
    router: 'local',
    configPath: '/tmp/antseed-config.json',
    verbose: true,
  });

  assert.deepEqual(args, [
    '--verbose',
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
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
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'buyer', 'start', '--router', 'custom-router',
  ]);
});

test('resolveCommandArgs launches the System Proxy runtime with selected profiles and models', () => {
  const args = resolveCommandArgs({
    mode: 'system-proxy',
    configPath: '/tmp/antseed-config.json',
    systemProxyPeerId: '0123456789abcdef0123456789abcdef01234567',
    systemProxyPort: 8378,
    systemProxyProfiles: ['editor', 'browser'],
    systemProxyDefaultModel: 'model-a',
    systemProxyServedModels: ['model-a', 'model-b'],
    setSystemProxy: true,
  });

  assert.deepEqual(args, [
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'system-proxy', 'start',
    '--peer', '0123456789abcdef0123456789abcdef01234567',
    '--port', '8378',
    '--profile', 'editor',
    '--profile', 'browser',
    '--default-model', 'model-a',
    '--served-model', 'model-a',
    '--served-model', 'model-b',
    '--system-proxy',
  ]);
});

test('resolveCommandArgs launches the public tunnel through the CLI', () => {
  const args = resolveCommandArgs({
    mode: 'tunnel',
    configPath: '/tmp/antseed-config.json',
    tunnelBuyerPort: 9456,
  });

  assert.deepEqual(args, [
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'tunnel', 'start', '--buyer-port', '9456',
  ]);
});

test('attached runtimes can be stopped locally without owning the shared process', async () => {
  const logs: string[] = [];
  const processManager = new ProcessManager((_mode, _stream, line) => logs.push(line));

  const attached = processManager.attach('connect');
  assert.equal(attached.running, true);
  assert.equal(attached.pid, null);
  assert.equal(processManager.isAttached('connect'), true);

  const stopped = await processManager.stop('connect', true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.pid, null);
  assert.equal(processManager.isAttached('connect'), false);
  assert.deepEqual(logs, ['Attached to existing connect runtime']);
});

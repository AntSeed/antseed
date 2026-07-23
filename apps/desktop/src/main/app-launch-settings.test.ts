import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadAppIdentitySettings,
  loadAppLaunchSettings,
  normalizeToolSlug,
  normalizeToolSlugs,
  setAppIdentitySetting,
  setAppLaunchSetting,
} from './app-launch-settings.js';

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'antseed-app-settings-'));
}

test('normalizeToolSlug mirrors the buyer proxy identity slug rules', () => {
  assert.equal(normalizeToolSlug('OpenCode'), 'opencode');
  assert.equal(normalizeToolSlug('  Acme CLI  '), 'acme-cli');
  assert.equal(normalizeToolSlug('codex_cli/1.0'), 'codex-cli-1.0');
  assert.equal(normalizeToolSlug('---'), '');
});

test('normalizeToolSlugs drops empties and duplicates and caps the list', () => {
  assert.deepEqual(normalizeToolSlugs(['OpenCode', 'opencode', '', '  ', 'acme-cli']), ['opencode', 'acme-cli']);
  const many = Array.from({ length: 20 }, (_, i) => `tool-${i}`);
  assert.equal(normalizeToolSlugs(many).length, 8);
});

test('identity settings persist per profile and clear on null or empty', () => {
  const dataDir = tempDataDir();
  assert.deepEqual(loadAppIdentitySettings(dataDir), {});

  setAppIdentitySetting(dataDir, 'acme', ['Acme CLI', 'acme-code']);
  assert.deepEqual(loadAppIdentitySettings(dataDir), { acme: ['acme-cli', 'acme-code'] });

  setAppIdentitySetting(dataDir, 'opencode', ['opencode']);
  setAppIdentitySetting(dataDir, 'acme', null);
  assert.deepEqual(loadAppIdentitySettings(dataDir), { opencode: ['opencode'] });

  setAppIdentitySetting(dataDir, 'opencode', []);
  assert.deepEqual(loadAppIdentitySettings(dataDir), {});
});

test('loadAppIdentitySettings survives malformed files and entries', () => {
  const dataDir = tempDataDir();
  writeFileSync(path.join(dataDir, 'app-identity.json'), 'not json', 'utf8');
  assert.deepEqual(loadAppIdentitySettings(dataDir), {});

  writeFileSync(path.join(dataDir, 'app-identity.json'), JSON.stringify({
    good: ['Tool-A'],
    notAList: 'tool',
    numbers: [1, 2],
    emptyAfterNormalize: ['---'],
  }), 'utf8');
  assert.deepEqual(loadAppIdentitySettings(dataDir), { good: ['tool-a'] });
});

test('identity and launch settings live in separate files', () => {
  const dataDir = tempDataDir();
  setAppLaunchSetting(dataDir, 'opencode', { name: 'OpenCode', path: '/Applications/OpenCode.app' });
  setAppIdentitySetting(dataDir, 'opencode', ['opencode']);

  assert.deepEqual(loadAppLaunchSettings(dataDir)['opencode'], { name: 'OpenCode', path: '/Applications/OpenCode.app' });
  const identityRaw = JSON.parse(readFileSync(path.join(dataDir, 'app-identity.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(identityRaw, { opencode: ['opencode'] });
  const launchRaw = JSON.parse(readFileSync(path.join(dataDir, 'app-launch.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('opencode' in launchRaw, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';
import { homedir } from 'node:os';

import { DEFAULT_APP_PROFILES, mergeWithDefaultAppProfiles, platformConfigPath } from './defaults.js';

function names(profiles: readonly unknown[]): string[] {
  return profiles.map((profile) => (profile as Record<string, unknown>)['name'] as string);
}

const DEFAULT_NAMES = ['opencode', 'codex', 'pi', 'crush', 'goose', 'zed'];

test('default app profiles are config-patch entries with unique names', () => {
  assert.deepEqual(names(DEFAULT_APP_PROFILES), DEFAULT_NAMES);
  for (const profile of DEFAULT_APP_PROFILES) {
    assert.equal(profile['kind'], 'config-patch');
    const patch = profile['configPatch'] as Record<string, unknown>;
    assert.equal(typeof patch['configPath'], 'string');
    assert.equal(typeof patch['providerKey'], 'string');
    assert.ok((patch['baseURL'] as string).includes('{buyerPort}'));
    const slugs = profile['toolSlugs'] as string[];
    assert.ok(Array.isArray(slugs) && slugs.length > 0);
  }
});

test('platformConfigPath keeps the posix path off Windows and for home-rooted tools', () => {
  const winFolder = { base: 'APPDATA', segments: ['Zed', 'settings.json'] } as const;
  assert.equal(platformConfigPath('~/.config/zed/settings.json', winFolder, 'darwin'), '~/.config/zed/settings.json');
  assert.equal(platformConfigPath('~/.config/zed/settings.json', winFolder, 'linux'), '~/.config/zed/settings.json');
  // Home-rooted tools pass no Windows folder — same path everywhere.
  assert.equal(platformConfigPath('~/.codex/config.toml', null, 'win32'), '~/.codex/config.toml');
});

test('platformConfigPath resolves Windows known folders from the environment', () => {
  const env = { APPDATA: 'C:\\Users\\jo\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\jo\\AppData\\Local' };
  assert.equal(
    platformConfigPath('~/.config/zed/settings.json', { base: 'APPDATA', segments: ['Zed', 'settings.json'] }, 'win32', env),
    path.join('C:\\Users\\jo\\AppData\\Roaming', 'Zed', 'settings.json'),
  );
  assert.equal(
    platformConfigPath('~/.config/crush/crush.json', { base: 'LOCALAPPDATA', segments: ['crush', 'crush.json'] }, 'win32', env),
    path.join('C:\\Users\\jo\\AppData\\Local', 'crush', 'crush.json'),
  );
});

test('platformConfigPath falls back to the conventional folder when the env var is unset', () => {
  assert.equal(
    platformConfigPath('~/.config/goose/config.yaml', { base: 'APPDATA', segments: ['Block', 'goose', 'config', 'config.yaml'] }, 'win32', {}),
    path.join(homedir(), 'AppData', 'Roaming', 'Block', 'goose', 'config', 'config.yaml'),
  );
});

test('mergeWithDefaultAppProfiles returns the defaults when no external profiles are configured', () => {
  assert.deepEqual(names(mergeWithDefaultAppProfiles([])), DEFAULT_NAMES);
});

test('mergeWithDefaultAppProfiles lets external profiles override same-name defaults and keep their order', () => {
  const external = [
    { name: 'acme', displayName: 'Acme Desktop' },
    { name: 'opencode', displayName: 'OpenCode (private override)' },
  ];
  const merged = mergeWithDefaultAppProfiles(external);
  assert.deepEqual(names(merged), ['acme', 'opencode', 'codex', 'pi', 'crush', 'goose', 'zed']);
  assert.equal((merged[1] as Record<string, unknown>)['displayName'], 'OpenCode (private override)');
});

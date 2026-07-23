import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_APP_PROFILES, mergeWithDefaultAppProfiles } from './default-apps.js';

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

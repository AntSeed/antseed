import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_APP_PROFILES, mergeWithDefaultAppProfiles } from './default-apps.js';

function names(profiles: readonly unknown[]): string[] {
  return profiles.map((profile) => (profile as Record<string, unknown>)['name'] as string);
}

test('default app profiles are config-patch entries with unique names', () => {
  assert.deepEqual(names(DEFAULT_APP_PROFILES), ['opencode', 'codex', 'pi']);
  for (const profile of DEFAULT_APP_PROFILES) {
    assert.equal(profile['kind'], 'config-patch');
    const patch = profile['configPatch'] as Record<string, unknown>;
    assert.equal(typeof patch['configPath'], 'string');
    assert.equal(patch['providerKey'], 'antseed');
    assert.ok((patch['baseURL'] as string).includes('{buyerPort}'));
  }
});

test('mergeWithDefaultAppProfiles returns the defaults when no external profiles are configured', () => {
  assert.deepEqual(names(mergeWithDefaultAppProfiles([])), ['opencode', 'codex', 'pi']);
});

test('mergeWithDefaultAppProfiles lets external profiles override same-name defaults and keep their order', () => {
  const external = [
    { name: 'anthropic', displayName: 'Claude Desktop' },
    { name: 'opencode', displayName: 'OpenCode (private override)' },
  ];
  const merged = mergeWithDefaultAppProfiles(external);
  assert.deepEqual(names(merged), ['anthropic', 'opencode', 'codex', 'pi']);
  assert.equal((merged[1] as Record<string, unknown>)['displayName'], 'OpenCode (private override)');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationRouteChangeRequiresRestart,
  buildActiveBuyerApplicationRoutes,
  migrateApplicationRoutePolicies,
} from './application-route-policies.js';

test('legacy tool routes matching the saved global route migrate to follow-global', () => {
  const routes = migrateApplicationRoutePolicies({
    peerId: 'peer-a',
    defaultModel: 'gpt-5.4',
    toolRoutes: {
      codex: { peerId: 'peer-a', model: 'gpt-5.4' },
      opencode: { peerId: 'peer-a', model: 'gpt-5.4' },
    },
  });

  assert.deepEqual(routes, {
    codex: { mode: 'follow-global' },
    opencode: { mode: 'follow-global' },
  });
});

test('legacy distinct routes migrate to explicit models when provider metadata exists', () => {
  const routes = migrateApplicationRoutePolicies({
    peerId: 'peer-a',
    defaultModel: 'gpt-5.4',
    toolRoutes: {
      opencode: { peerId: 'peer-b', model: 'qwen3-coder' },
    },
  }, (peerId) => peerId === 'peer-b' ? ['OpenAI'] : []);

  assert.deepEqual(routes.opencode, {
    mode: 'model',
    provider: 'openai',
    service: 'qwen3-coder',
  });
});

test('active buyer routes add defaults and tool slugs for every connected profile', () => {
  const active = buildActiveBuyerApplicationRoutes(
    ['codex', 'opencode'],
    { opencode: { mode: 'model', provider: 'openai', service: 'qwen3-coder' } },
    (profileName) => profileName === 'codex' ? ['codex', 'codex-cli-rs'] : ['opencode'],
  );

  assert.deepEqual(active, {
    codex: { mode: 'client-model', toolSlugs: ['codex', 'codex-cli-rs'] },
    opencode: {
      mode: 'model',
      provider: 'openai',
      service: 'qwen3-coder',
      toolSlugs: ['opencode'],
    },
  });

  assert.deepEqual(
    buildActiveBuyerApplicationRoutes(
      ['codex'],
      { opencode: { mode: 'model', provider: 'openai', service: 'qwen3-coder' } },
      (profileName) => [profileName],
    ),
    { codex: { mode: 'client-model', toolSlugs: ['codex'] } },
  );
});

test('Codex restarts only when crossing the in-app and Custom selection boundary', () => {
  const inApp = { codex: { mode: 'client-model' as const } };
  const explicit = { codex: { mode: 'model' as const, provider: 'openai', service: 'gpt-5.6-sol' } };
  const otherExplicit = { codex: { mode: 'model' as const, provider: 'openai', service: 'gpt-5.6-luna' } };

  assert.equal(applicationRouteChangeRequiresRestart('codex', inApp, explicit), true);
  assert.equal(applicationRouteChangeRequiresRestart('codex', explicit, inApp), true);
  assert.equal(applicationRouteChangeRequiresRestart('codex', explicit, otherExplicit), false);
  assert.equal(applicationRouteChangeRequiresRestart('opencode', inApp, explicit), false);
});

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { VprApplicationRoutes } from '../../core/state';
import {
  setVprApplicationRouteSelection,
  toApplicationRoutePolicies,
  vprApplicationRouteSelectionFor,
} from './application-routes.js';

test('application route defaults preserve client-selected models for Codex and OpenCode', () => {
  assert.deepEqual(vprApplicationRouteSelectionFor({}, 'codex'), { mode: 'client-model' });
  assert.deepEqual(vprApplicationRouteSelectionFor({}, 'opencode'), { mode: 'client-model' });
  assert.deepEqual(vprApplicationRouteSelectionFor({}, 'pi'), { mode: 'follow-global' });
});

test('changing one application route preserves every other selection', () => {
  const routes: VprApplicationRoutes = {
    codex: { mode: 'client-model' },
    opencode: { mode: 'follow-global' },
  };
  const next = setVprApplicationRouteSelection(routes, 'opencode', {
    mode: 'model',
    model: {
      provider: 'openai-responses',
      serviceId: 'qwen3-coder',
      label: 'Qwen3 Coder',
      categories: ['coding'],
    },
  });

  assert.notEqual(next, routes);
  assert.deepEqual(routes.opencode, { mode: 'follow-global' });
  assert.deepEqual(next.codex, { mode: 'client-model' });
  assert.equal(next.opencode?.mode, 'model');
});

test('renderer selections convert to buyer policies without catalog-only fields', () => {
  assert.deepEqual(toApplicationRoutePolicies({
    codex: { mode: 'client-model' },
    opencode: {
      mode: 'model',
      model: {
        provider: 'openai-responses',
        serviceId: 'qwen3-coder',
        label: 'Qwen3 Coder',
        categories: ['coding'],
      },
    },
  }), {
    codex: { mode: 'client-model' },
    opencode: { mode: 'model', provider: 'openai-responses', service: 'qwen3-coder' },
  });
});

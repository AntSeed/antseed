import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprRouteSelection } from '../../core/state.js';
import { buyerDefaultRoutePayload, type VprRouteTarget } from './proxy-sync.js';

const model = {
  provider: 'openai',
  serviceId: 'gpt-5.6-sol',
  label: 'GPT 5.6 Sol',
  categories: [],
};

const target: VprRouteTarget = {
  peerId: 'a'.repeat(40),
  model: 'openai-gpt-56-sol',
  servedModels: ['openai-gpt-56-sol'],
};

test('desktop Auto syncs a model-only buyer route', () => {
  const selection: VprRouteSelection = { model, mode: 'auto', peerId: null };
  assert.deepEqual(buyerDefaultRoutePayload(selection, target), {
    service: 'gpt-5.6-sol',
  });
});

test('desktop pinned mode syncs the selected peer and its advertised service id', () => {
  const selection: VprRouteSelection = { model, mode: 'pinned-peer', peerId: target.peerId };
  assert.deepEqual(buyerDefaultRoutePayload(selection, target), {
    peerId: target.peerId,
    service: 'openai-gpt-56-sol',
  });
});

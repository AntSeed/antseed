import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprFloatData } from '../../../types/bridge.js';
import { compactRoutingStatus } from './CompactRoutingPanel.js';

function data(overrides: Partial<VprFloatData> = {}): VprFloatData {
  return {
    apps: [],
    selectedApp: '',
    models: [],
    selectedModel: null,
    conversations: [],
    usageLabel: '0 tok',
    balanceLabel: '$10.00',
    runtimeOn: true,
    trafficActive: false,
    ...overrides,
  };
}

test('compact routing status covers loading, stopped, idle, and insufficient funds', () => {
  assert.equal(compactRoutingStatus(null).tone, 'loading');
  assert.deepEqual(compactRoutingStatus(data({ runtimeOn: false, needsFunds: true })), {
    label: 'Not connected',
    hint: 'Routing is stopped — apps are not going through AntSeed. Open VPR to start it.',
    tone: 'stopped',
  });
  assert.equal(compactRoutingStatus(data()).label, 'Connected · idle');
  assert.deepEqual(compactRoutingStatus(data({ needsFunds: true })), {
    label: 'Balance needed',
    hint: 'Add balance to route requests through the selected paid model.',
    tone: 'funds',
  });
});

test('active routing status names the active conversation model', () => {
  const status = compactRoutingStatus(data({
    trafficActive: true,
    models: [
      { provider: 'one', serviceId: 'model-one', label: 'Model One' },
      { provider: 'two', serviceId: 'model-two', label: 'Model Two' },
    ] as VprFloatData['models'],
    conversations: [
      { id: 'one', pinnedServiceId: 'model-one', active: false },
      { id: 'two', pinnedServiceId: 'model-two', active: true },
    ] as VprFloatData['conversations'],
  }));

  assert.equal(status.label, 'Routing · Model Two');
  assert.equal(status.tone, 'active');
});

test('active routing status falls back cleanly before a model is resolved', () => {
  assert.equal(
    compactRoutingStatus(data({ trafficActive: true })).label,
    'Routing…',
  );
});

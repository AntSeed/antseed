import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelPickerSelection } from './model-picker.js';

test('model picker selection normalizes valid tray payloads', () => {
  assert.deepEqual(
    normalizeModelPickerSelection({ provider: ' openai ', serviceId: ' gpt-5 ' }),
    { provider: 'openai', serviceId: 'gpt-5' },
  );
});

test('model picker selection rejects incomplete tray payloads', () => {
  assert.equal(normalizeModelPickerSelection({ provider: 'openai', serviceId: '' }), null);
  assert.equal(normalizeModelPickerSelection({ provider: 'openai' }), null);
  assert.equal(normalizeModelPickerSelection(null), null);
});

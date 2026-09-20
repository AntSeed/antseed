import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseServiceCapabilitiesInput,
  parseServiceUnitBillingModelsInput,
} from './service-metadata.js';

test('parseServiceCapabilitiesInput validates CLI capability JSON', () => {
  assert.deepEqual(
    parseServiceCapabilitiesInput('{"contextWindow":200000,"inputs":["text","image"],"toolUse":true}'),
    { contextWindow: 200000, inputs: ['text', 'image'], toolUse: true },
  );
  assert.throws(
    () => parseServiceCapabilitiesInput('{"inputs":["telepathy"]}'),
    /Unsupported input modality/,
  );
});

test('parseServiceUnitBillingModelsInput validates CLI billing JSON', () => {
  const models = parseServiceUnitBillingModelsInput(JSON.stringify({
    'openai-images': { version: 2, priceMicroUsdc: '40000' },
  }));
  assert.equal(models['openai-images']?.priceMicroUsdc, '40000');
  assert.throws(
    () => parseServiceUnitBillingModelsInput('{"unknown":{"version":1,"components":[]}}'),
    /known service API protocol/,
  );
});

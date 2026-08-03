import assert from 'node:assert/strict';
import { test } from 'vitest';
import { canonicalModelKey, displayModelLabel, sameCanonicalModel } from './model-identity.js';

test('canonicalModelKey collapses separator and vendor-prefix variants', () => {
  assert.equal(canonicalModelKey('gpt-5.6-luna'), 'gpt5.6luna');
  assert.equal(canonicalModelKey('GPT 5.6 Luna'), 'gpt5.6luna');
  assert.equal(canonicalModelKey('openai/gpt-5.6-luna'), 'gpt5.6luna');
  assert.equal(canonicalModelKey('gpt_5.6_luna'), 'gpt5.6luna');
});

test('canonicalModelKey strips -latest and trailing date stamps', () => {
  assert.equal(canonicalModelKey('gpt-5.6-luna-latest'), 'gpt5.6luna');
  assert.equal(canonicalModelKey('gpt-5.6-luna-20260115'), 'gpt5.6luna');
  assert.equal(canonicalModelKey('claude-fable-5-2026-01-15'), 'claudefable5');
});

test('canonicalModelKey keeps genuinely different variants apart', () => {
  assert.notEqual(canonicalModelKey('gpt-5.6-luna'), canonicalModelKey('gpt-5.6-luna-pro'));
  assert.notEqual(canonicalModelKey('gpt-5.6-luna'), canonicalModelKey('gpt-5.6-sol'));
});

test('sameCanonicalModel never matches on empty keys', () => {
  assert.equal(sameCanonicalModel('', ''), false);
  assert.equal(sameCanonicalModel('---', '___'), false);
});

test('displayModelLabel prettifies slug ids', () => {
  assert.equal(displayModelLabel('claude-fable-5'), 'Claude Fable 5');
  assert.equal(displayModelLabel('gpt-5.6-luna'), 'GPT 5.6 Luna');
  assert.equal(displayModelLabel('deepseek-v4'), 'DeepSeek V4');
  assert.equal(displayModelLabel('kimi-k3'), 'Kimi K3');
  assert.equal(displayModelLabel('glm-5.2'), 'GLM 5.2');
});

test('displayModelLabel keeps human labels untouched', () => {
  assert.equal(displayModelLabel('gpt-5.6-luna', 'GPT-5.6 Luna'), 'GPT-5.6 Luna');
  assert.equal(displayModelLabel('', 'Select a model'), 'Select a model');
});

test('displayModelLabel prettifies slug-shaped labels', () => {
  assert.equal(displayModelLabel('svc-1', 'gpt-5.6-luna'), 'GPT 5.6 Luna');
});

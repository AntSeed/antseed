import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MAX_TOKENS, resolveRequestMaxTokens } from './chat-request-budget.js';

test('resolveRequestMaxTokens prefers explicit stream option override', () => {
  const value = resolveRequestMaxTokens(
    { maxTokens: 16_384 },
    { maxTokens: 32_000 },
  );

  assert.equal(value, 32_000);
});

test('resolveRequestMaxTokens falls back to model maxTokens', () => {
  const value = resolveRequestMaxTokens(
    { maxTokens: 16_384 },
    undefined,
  );

  assert.equal(value, 16_384);
});

test('resolveRequestMaxTokens falls back to default when neither source is usable', () => {
  const value = resolveRequestMaxTokens(
    { maxTokens: 0 },
    { maxTokens: -1 },
  );

  assert.equal(value, DEFAULT_MAX_TOKENS);
});

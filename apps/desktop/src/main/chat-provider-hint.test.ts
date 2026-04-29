import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROXY_PROVIDER_ID,
  normalizeProviderId,
  providersForServiceMetadata,
  sanitizeProviderHint,
} from './chat-provider-hint.js';

test('normalizeProviderId trims and lowercases real provider names', () => {
  assert.equal(normalizeProviderId(' OpenAI '), 'openai');
  assert.equal(normalizeProviderId('Anthropic'), 'anthropic');
});

test('normalizeProviderId returns null for empty or non-string input', () => {
  assert.equal(normalizeProviderId(''), null);
  assert.equal(normalizeProviderId('   '), null);
  assert.equal(normalizeProviderId(undefined), null);
  assert.equal(normalizeProviderId(null), null);
  assert.equal(normalizeProviderId(123), null);
});

test('sanitizeProviderHint strips the local proxy sentinel', () => {
  // Regression: the buyer proxy rejects a request as
  //   "Pinned peer ... does not offer provider=antseed-proxy"
  // when this internal label leaks into x-antseed-provider. Treating
  // the sentinel as "no hint" makes the buyer proxy auto-select.
  assert.equal(sanitizeProviderHint(PROXY_PROVIDER_ID), null);
  assert.equal(sanitizeProviderHint('ANTSEED-PROXY'), null);
  assert.equal(sanitizeProviderHint('  antseed-proxy  '), null);
});

test('sanitizeProviderHint preserves real upstream provider names', () => {
  assert.equal(sanitizeProviderHint('openai'), 'openai');
  assert.equal(sanitizeProviderHint(' Anthropic '), 'anthropic');
  assert.equal(sanitizeProviderHint('local-llm'), 'local-llm');
});

test('sanitizeProviderHint returns null for missing or invalid input', () => {
  assert.equal(sanitizeProviderHint(undefined), null);
  assert.equal(sanitizeProviderHint(null), null);
  assert.equal(sanitizeProviderHint(''), null);
  assert.equal(sanitizeProviderHint('   '), null);
});

test('providersForServiceMetadata resolves MiniMax to openai instead of openai-responses', () => {
  const providers = providersForServiceMetadata(
    ['openai-responses', 'openai'],
    {
      providerServiceApiProtocols: {
        'openai-responses': {
          services: {
            'gpt-5.5': ['openai-responses'],
          },
        },
        openai: {
          services: {
            'minimax-m2.7-highspeed': ['openai-chat-completions'],
          },
        },
      },
      providerPricing: {
        'openai-responses': {
          services: {
            'gpt-5.5': {},
          },
        },
        openai: {
          services: {
            'minimax-m2.7-highspeed': {},
          },
        },
      },
    },
    'minimax-m2.7-highspeed',
  );

  assert.deepEqual(providers, ['openai']);
});

test('providersForServiceMetadata falls back to first provider without per-service metadata', () => {
  assert.deepEqual(
    providersForServiceMetadata(['openai-responses', 'openai'], {}, 'legacy-service'),
    ['openai-responses'],
  );
});

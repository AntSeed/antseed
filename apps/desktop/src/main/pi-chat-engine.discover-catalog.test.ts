import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatServiceCatalogFromPeers } from './chat-service-catalog.js';

test('buildChatServiceCatalogFromPeers keeps provider-specific service pricing for multi-provider peers', () => {
  const peerId = 'a'.repeat(40);
  const catalog = buildChatServiceCatalogFromPeers([{
    peerId,
    displayName: 'darksignal',
    host: '127.0.0.1',
    port: 6882,
    providers: ['anthropic', 'openai'],
    services: ['claude-sonnet-4-5-20250929', 'gpt-4o-mini'],
    providerPricing: {
      anthropic: {
        defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
        services: {
          'claude-sonnet-4-5-20250929': { inputUsdPerMillion: 11, outputUsdPerMillion: 21 },
        },
      },
      openai: {
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        services: {
          'gpt-4o-mini': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
        },
      },
    },
    providerServiceApiProtocols: {
      anthropic: { services: { 'claude-sonnet-4-5-20250929': ['anthropic-messages'] } },
      openai: { services: { 'gpt-4o-mini': ['openai-chat-completions'] } },
    },
  }]);

  const anthropic = catalog.find((entry) => entry.provider === 'anthropic' && entry.id === 'claude-sonnet-4-5-20250929');
  const openai = catalog.find((entry) => entry.provider === 'openai' && entry.id === 'gpt-4o-mini');

  assert.ok(anthropic);
  assert.ok(openai);
  assert.equal(anthropic!.inputUsdPerMillion, 11);
  assert.equal(anthropic!.outputUsdPerMillion, 21);
  assert.equal(openai!.inputUsdPerMillion, 0.15);
  assert.equal(openai!.outputUsdPerMillion, 0.6);
  assert.equal(openai!.protocol, 'openai-chat-completions');
});

test('buildChatServiceCatalogFromPeers falls back to each provider defaults for unpriced provider-specific services', () => {
  const peerId = 'b'.repeat(40);
  const catalog = buildChatServiceCatalogFromPeers([{
    peerId,
    host: '127.0.0.1',
    port: 6882,
    providers: ['anthropic', 'openai'],
    providerPricing: {
      anthropic: {
        defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
        services: { 'claude-haiku': {} },
      },
      openai: {
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        services: { 'gpt-4o-mini': {} },
      },
    },
    providerServiceApiProtocols: {
      anthropic: { services: { 'claude-haiku': ['anthropic-messages'] } },
      openai: { services: { 'gpt-4o-mini': ['openai-chat-completions'] } },
    },
  }]);

  const openai = catalog.find((entry) => entry.provider === 'openai' && entry.id === 'gpt-4o-mini');

  assert.ok(openai);
  assert.equal(openai!.inputUsdPerMillion, 1);
  assert.equal(openai!.outputUsdPerMillion, 2);
});

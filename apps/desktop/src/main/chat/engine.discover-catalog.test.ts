import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatServiceCatalogFromPeers } from './service-catalog.js';

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
        defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5 },
        services: {
          'gpt-4o-mini': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, cachedInputUsdPerMillion: 0.05 },
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
  assert.equal(openai!.cachedInputUsdPerMillion, 0.05);
  assert.equal(openai!.protocol, 'openai-chat-completions');
});

test('buildChatServiceCatalogFromPeers keeps one cheapest canonical offer per peer', () => {
  const peerId = 'e'.repeat(40);
  const catalog = buildChatServiceCatalogFromPeers([{
    peerId,
    displayName: 'surplusintelligence.ai',
    host: '127.0.0.1',
    port: 6882,
    providers: ['anthropic', 'claude-oauth', 'openai'],
    providerPricing: {
      anthropic: {
        defaults: { inputUsdPerMillion: 18, outputUsdPerMillion: 9 },
        services: { 'claude-opus-4.8': { inputUsdPerMillion: 18, outputUsdPerMillion: 9 } },
      },
      'claude-oauth': {
        defaults: { inputUsdPerMillion: 2.25, outputUsdPerMillion: 11.25 },
        services: { 'opus-4.8-coding-only': { inputUsdPerMillion: 2.25, outputUsdPerMillion: 11.25 } },
      },
      openai: {
        defaults: { inputUsdPerMillion: 0.35, outputUsdPerMillion: 0.95 },
        services: { 'claude-opus-4-8': { inputUsdPerMillion: 0.35, outputUsdPerMillion: 0.95 } },
      },
    },
    providerServiceApiProtocols: {
      anthropic: { services: { 'claude-opus-4.8': ['anthropic-messages'] } },
      'claude-oauth': { services: { 'opus-4.8-coding-only': ['anthropic-messages'] } },
      openai: { services: { 'claude-opus-4-8': ['openai-chat-completions'] } },
    },
  }]);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.peerId, peerId);
  assert.equal(catalog[0]?.provider, 'openai');
  assert.equal(catalog[0]?.id, 'claude-opus-4-8');
  assert.equal(catalog[0]?.inputUsdPerMillion, 0.35);
  assert.equal(catalog[0]?.outputUsdPerMillion, 0.95);
});

test('buildChatServiceCatalogFromPeers keeps image protocols and peer-specific capabilities', () => {
  const peerId = 'c'.repeat(40);
  const catalog = buildChatServiceCatalogFromPeers([{
    peerId,
    host: '127.0.0.1',
    port: 6882,
    providers: ['openai'],
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-image-test': ['openai-images'] } },
    },
    providerServiceCapabilities: {
      openai: {
        services: {
          'gpt-image-test': {
            inputs: ['text'],
            outputs: ['image'],
            supportedParameters: ['quality', 'output_format'],
          },
        },
      },
    },
    providerServiceUnitBillingModels: {
      openai: {
        services: {
          'gpt-image-test': {
            'openai-images': {
              version: 1,
              components: [
                { unit: 'output_images', priceUsd: 0.04, match: { quality: 'standard' } },
                { unit: 'output_images', priceUsd: 0.08, match: { quality: 'hd' } },
              ],
            },
          },
        },
      },
    },
  }]);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.protocol, 'openai-images');
  assert.deepEqual(catalog[0]?.capabilities, {
    inputs: ['text'],
    outputs: ['image'],
    supportedParameters: ['quality', 'output_format'],
  });
  assert.equal(catalog[0]?.minImageUsdPerImage, 0.04);
  assert.equal(catalog[0]?.maxImageUsdPerImage, 0.08);
});

test('explicit image protocol wins over a conflicting chat protocol', () => {
  const catalog = buildChatServiceCatalogFromPeers([{
    peerId: 'd'.repeat(40),
    host: '127.0.0.1',
    port: 6882,
    providers: ['openai'],
    providerServiceApiProtocols: {
      openai: { services: { conflicted: ['openai-chat-completions', 'openai-images'] } },
    },
  }]);

  assert.equal(catalog.find((entry) => entry.id === 'conflicted')?.protocol, 'openai-images');
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

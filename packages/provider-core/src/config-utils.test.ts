import { describe, expect, it } from 'vitest';
import { MAX_SERVICES_PER_PROVIDER } from '@antseed/node';
import { isImageModelId, parseServiceCapabilitiesJson, parseServiceUnitBillingModelsJson } from './config-utils.js';

describe('isImageModelId', () => {
  it.each([
    'gpt-image-2',
    'openai/gpt-image-1-5',
    'dall-e-3',
    'grok-imagine-image-2-0',
    'venice-sd35',
    'krea-2-turbo',
    'krea-v2-large',
    'flux-2-pro',
    'hunyuan-image-v3',
    'ideogram-v4',
    'imagineart-1.5-pro',
    'luma-uni-1-max',
    'nano-banana-pro',
    'recraft-v4-pro',
    'seedream-v5-lite',
    'qwen-image-3-pro',
    'wan-2-7-pro-text-to-image',
    'lustify-v8',
    'wai-Illustrious',
    'z-image-turbo',
    'chroma',
  ])('recognizes image model %s', (model) => {
    expect(isImageModelId(model)).toBe(true);
  });

  it.each([
    'gpt-5.5',
    'flux-capacitor-chat',
    'qwen3-vl-235b',
    'recraft-v3-text',
    'seedream-chat',
    'acme/chroma-chat',
    'my-flux-2-pro-wrapper',
  ])('does not classify text model %s as an image model', (model) => {
    expect(isImageModelId(model)).toBe(false);
  });
});

describe('parseServiceUnitBillingModelsJson', () => {
  it('rejects unknown service API protocol keys', () => {
    expect(() => parseServiceUnitBillingModelsJson(JSON.stringify({
      'gpt-image-1': {
        'not-a-protocol': { version: 2, components: [{ priceMicroUsdc: '0' }] },
      },
    }))).toThrow(/known service API protocol/);
  });

  it('accepts known service API protocol keys', () => {
    expect(parseServiceUnitBillingModelsJson(JSON.stringify({
      'gpt-image-1': {
        'openai-images': { version: 2, components: [{ priceMicroUsdc: '0' }] },
      },
    }))).toEqual({
      'gpt-image-1': {
        'openai-images': { version: 2, components: [{ priceMicroUsdc: '0' }] },
      },
    });
  });
});

describe('parseServiceCapabilitiesJson', () => {
  it('preserves seller-defined effort choices and rejects malformed or contradictory values', () => {
    const capabilities = { model: { reasoning: true, reasoningEfforts: ['adaptive', 'deep-analysis'] } };
    expect(parseServiceCapabilitiesJson(JSON.stringify(capabilities))).toEqual(capabilities);
    for (const caps of [{ reasoningEfforts: [''] }, { reasoningEfforts: ['high', 'high'] }, { reasoning: false, reasoningEfforts: ['high'] }]) {
      expect(() => parseServiceCapabilitiesJson(JSON.stringify({ model: caps }))).toThrow('reasoningEfforts');
    }
  });
  it('returns undefined for empty input', () => {
    expect(parseServiceCapabilitiesJson(undefined)).toBeUndefined();
    expect(parseServiceCapabilitiesJson('{}')).toBeUndefined();
  });

  it('parses a full capabilities map', () => {
    expect(parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': {
        contextWindow: 200000,
        maxOutputTokens: 16384,
        inputs: ['text', 'image'],
        reasoning: true,
        toolUse: false,
      },
      'gpt-image-1': {
        outputs: ['image'],
        supportedParameters: ['background', 'output_format', 'size'],
      },
    }))).toEqual({
      'gpt-5.5': {
        contextWindow: 200000,
        maxOutputTokens: 16384,
        inputs: ['text', 'image'],
        reasoning: true,
        toolUse: false,
      },
      'gpt-image-1': {
        outputs: ['image'],
        supportedParameters: ['background', 'output_format', 'size'],
      },
    });
  });

  it('rejects duplicate input modalities (same as the metadata validator)', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { inputs: ['text', 'image', 'text'] },
    }))).toThrow(/Duplicate input modality/);
  });

  it('rejects unknown input modalities', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { inputs: ['text', 'hologram'] },
    }))).toThrow(/Unsupported input modality "hologram"/);
  });

  it('rejects unknown output modalities', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-image-1': { outputs: ['hologram'] },
    }))).toThrow(/Unsupported output modality "hologram"/);
  });

  it('rejects malformed supported parameters', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-image-1': { supportedParameters: ['Output-Format'] },
    }))).toThrow(/must be lowercase snake_case/);
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-image-1': { supportedParameters: ['seed', 'seed'] },
    }))).toThrow(/Duplicate supported parameter "seed"/);
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-image-1': { supportedParameters: Array.from({ length: 33 }, (_, i) => `param_${i}`) },
    }))).toThrow(/exceeds max 32/);
  });

  it('rejects token counts above the announce-time wire ceiling', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { contextWindow: 2_000_000_000 },
    }))).toThrow(/positive integer <= 1000000000/);
  });

  it('rejects more services than the metadata validator allows', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_SERVICES_PER_PROVIDER + 1 }, (_, i) => [`svc-${i}`, { contextWindow: 1000 }]),
    );
    expect(() => parseServiceCapabilitiesJson(JSON.stringify(many)))
      .toThrow(`must not define more than ${MAX_SERVICES_PER_PROVIDER} services`);
  });

  it('rejects non-integer token counts', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { contextWindow: -1 },
    }))).toThrow(/positive integer/);
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { maxOutputTokens: 1.5 },
    }))).toThrow(/positive integer/);
  });

  it('rejects non-boolean flags', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { reasoning: 'yes' },
    }))).toThrow(/must be a boolean/);
  });
});

describe('legacy seller quantity-billing migration', () => {
  it.each([['openai-images', 'output_images'], ['openai-chat-completions', 'successful_requests'], ['antseed-routing', 'successful_requests']])('migrates %s without changing its adapter quantity', (protocol, unit) => {
    const input = { service: { [protocol]: { version: 1, components: [{ unit, priceUsd: 0.04 }] } } };
    expect(parseServiceUnitBillingModelsJson(JSON.stringify(input))).toEqual({ service: { [protocol]: { version: 2, components: [{ priceMicroUsdc: '40000' }] } } });
    expect(input.service[protocol].version).toBe(1);
  });
  it.each([
    ['openai-images', [{ unit: 'successful_requests', priceUsd: 0.04 }]],
    ['antseed-routing', [{ unit: 'output_images', priceUsd: 0.04 }]],
    ['openai-images', [{ unit: 'output_images', priceUsd: 0.04, match: { arbitrary: 'high' } }]],
    ['antseed-routing', [{ unit: 'successful_requests', priceUsd: 0.04, match: { quality: 'high' } }]],
    ['openai-images', [{ unit: 'output_images', priceUsd: 0.0000001 }]],
    ['openai-images', [{ unit: 'output_images', priceUsd: -1 }]],
  ])('rejects ambiguous or inexact legacy conversion %j', (protocol, components) => {
    expect(() => parseServiceUnitBillingModelsJson(JSON.stringify({ service: { [protocol as string]: { version: 1, components } } }))).toThrow('cannot safely migrate');
  });
  it('migrates a legacy free model and validates the resulting v2 shape', () => {
    expect(parseServiceUnitBillingModelsJson(JSON.stringify({ service: { 'openai-images': { version: 1, components: [] } } }))).toEqual({ service: { 'openai-images': { version: 2, components: [] } } });
    expect(() => parseServiceUnitBillingModelsJson(JSON.stringify({ service: { 'openai-images': { version: 2, components: [{ priceMicroUsdc: '01' }] } } }))).toThrow();
  });
  it('preserves legacy conditional and additive components without mutating input', () => {
    const components = [
      { unit: 'output_images', priceUsd: 0.04 },
      { unit: 'output_images', priceUsd: 0.02, match: { quality: 'hd', size: '1536x1024' } },
    ];
    const input = { service: { 'openai-images': { version: 1, components } } };
    expect(parseServiceUnitBillingModelsJson(JSON.stringify(input))).toEqual({ service: { 'openai-images': { version: 2, components: [
      { priceMicroUsdc: '40000' }, { priceMicroUsdc: '20000', match: { quality: 'hd', size: '1536x1024' } },
    ] } } });
    expect(input.service['openai-images'].version).toBe(1);
    expect(components[0]!.unit).toBe('output_images');
  });
  it('normalizes interim local flat v2 input but rejects mixed formats', () => {
    expect(parseServiceUnitBillingModelsJson(JSON.stringify({ service: { 'openai-images': { version: 2, priceMicroUsdc: '123' } } })))
      .toEqual({ service: { 'openai-images': { version: 2, components: [{ priceMicroUsdc: '123' }] } } });
    expect(() => parseServiceUnitBillingModelsJson(JSON.stringify({ service: { 'openai-images': { version: 2, priceMicroUsdc: '123', components: [] } } }))).toThrow('Unsupported');
  });
});

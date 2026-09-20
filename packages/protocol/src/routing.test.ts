import { describe, expect, it } from 'vitest';
import { MAX_ROUTING_PREFERENCE_BYTES, assertRoutingPreferences, createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingPreferenceSchema, validateRoutingRequest, validateRoutingServiceMetadata, validateRoutingUsageContext, type RoutingPreferenceSchema } from './routing.js';

const schema: RoutingPreferenceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    policy: { type: 'string', enum: ['first', 'last'], default: 'first' },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    settings: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean', default: true } } },
    labels: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 2 },
  },
};

describe('router-defined preferences', () => {
  it('validates candidate effort labels without coercion', () => {
    const metadata = createRoutingServiceMetadata(schema);
    const candidate = { serviceId: 'model', peerId: 'a'.repeat(40), inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
    const request = { version: 1, service: 'selector', preferencesSchemaHash: metadata.preferencesSchemaHash,
      request: { path: '/v1/chat/completions', body: {} }, candidates: [candidate], preferences: {} };
    for (const reasoningEfforts of [undefined, [], ['none', 'high']]) {
      expect(() => validateRoutingRequest({ ...request, candidates: [{ ...candidate, reasoningEfforts }] }, metadata)).not.toThrow();
    }
    for (const reasoningEfforts of [null, 'high', ['unknown'], [1], ['high', 'high']]) {
      expect(() => validateRoutingRequest({ ...request, candidates: [{ ...candidate, reasoningEfforts }] }, metadata)).toThrow('reasoning efforts');
    }
  });
  it('validates optional usage history without requiring cache reports', () => {
    const observation = { id: 'event-1', offer: { peerId: 'a'.repeat(40), provider: 'example', serviceId: 'model' }, inputTokens: 100, ageMs: 10 };
    const context = { conversationRef: 'opaque', usageObservations: [observation], historyTruncated: false };
    expect(() => validateRoutingUsageContext(context)).not.toThrow();
    expect(context.usageObservations[0]).not.toHaveProperty('cachedInputTokens');
    for (const cachedInputTokens of [0, 80]) expect(() => validateRoutingUsageContext({ ...context, usageObservations: [{ ...observation, cachedInputTokens }] })).not.toThrow();
    for (const invalid of [
      { ...context, unexpected: true }, { ...context, historyTruncated: 'false' }, { ...context, conversationRef: '' },
      { ...context, usageObservations: [observation, observation] },
      ...[-1, 101, null, '80', 0.5].map((cachedInputTokens) => ({ ...context, usageObservations: [{ ...observation, cachedInputTokens }] })),
      ...[-1, Infinity, Number.MAX_SAFE_INTEGER + 1].map((inputTokens) => ({ ...context, usageObservations: [{ ...observation, inputTokens }] })),
      { ...context, usageObservations: [{ ...observation, ageMs: -1 }] },
      { ...context, usageObservations: [{ ...observation, prompt: 'must not be accepted' }] },
      { ...context, usageObservations: [{ ...observation, offer: { ...observation.offer, peerId: 'invalid' } }] },
      { ...context, usageObservations: Array.from({ length: 65 }, (_, index) => ({ ...observation, id: `event-${index}` })) },
      { ...context, usageObservations: Array.from({ length: 64 }, (_, index) => ({ ...observation, id: `event-${index}`, offer: { ...observation.offer, provider: 'x'.repeat(256), serviceId: 'y'.repeat(256) } })) },
    ]) expect(() => validateRoutingUsageContext(invalid)).toThrow();
    const metadata = createRoutingServiceMetadata(schema);
    const request = { version: 1, service: 'selector', preferencesSchemaHash: metadata.preferencesSchemaHash, request: { path: '/v1/chat/completions', body: {} }, candidates: [{ serviceId: 'model', peerId: 'a'.repeat(40), inputUsdPerMillion: 1, outputUsdPerMillion: 1 }], preferences: {}, context };
    expect(() => validateRoutingRequest(request, metadata)).not.toThrow();
    expect(() => validateRoutingRequest({ ...request, context: { ...context, usageObservations: [observation, observation] } }, metadata)).toThrow();
  });
  it('preserves nested types and uses only advertised defaults', () => {
    const values = { count: 2, settings: {}, labels: ['one'] };
    expect(resolveRoutingPreferences(schema, values)).toEqual({ policy: 'first', count: 2, settings: { enabled: true }, labels: ['one'] });
    expect(values).toEqual({ count: 2, settings: {}, labels: ['one'] });
    expect(resolveRoutingPreferences(schema, { policy: 'last' })).toEqual({ policy: 'last' });
  });
  it.each([{ count: '2' }, { count: 0 }, { count: 1.1 }, { policy: 'other' }, { unknown: true }, { settings: { enabled: 'true' } }, { labels: [''] }, { labels: ['a', 'b', 'c'] }])('rejects invalid values with field errors: %j', (values) => {
    expect(() => resolveRoutingPreferences(schema, values)).toThrow(/preferences\./);
  });
  it('enforces required fields, but allows their declared defaults', () => {
    expect(() => resolveRoutingPreferences({ ...schema, required: ['count'] }, {})).toThrow('preferences.count');
    expect(resolveRoutingPreferences({ ...schema, required: ['policy'] }, {})).toEqual({ policy: 'first' });
  });
  it.each(['$ref', '$schema', 'pattern', 'oneOf', 'allOf', 'format', 'execute'])('rejects unsupported schema keyword %s', (key) => {
    expect(() => validateRoutingPreferenceSchema({ ...schema, [key]: 'untrusted' })).toThrow('unsupported schema keyword');
  });
  it('rejects invalid defaults, enums, bounds and implicit additional properties', () => {
    for (const properties of [{ value: { type: 'boolean', default: 'yes' } }, { value: { type: 'integer', minimum: 5, maximum: 2 } }, { value: { type: 'string', enum: ['x', 'x'] } }]) {
      expect(() => validateRoutingPreferenceSchema({ type: 'object', additionalProperties: false, properties })).toThrow();
    }
    expect(() => validateRoutingPreferenceSchema({ type: 'object', properties: {} })).toThrow();
  });
  it('bounds size and nesting and rejects non-JSON/prototype keys', () => {
    expect(() => assertRoutingPreferences({ text: 'x'.repeat(16384) })).toThrow('16 KiB');
    expect(() => assertRoutingPreferences({ number: Infinity })).toThrow();
    expect(() => assertRoutingPreferences(JSON.parse('{"__proto__":{}}'))).toThrow();
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 10; depth++) nested = { nested };
    expect(() => assertRoutingPreferences(nested)).toThrow('nesting');
  });
  it('hashes schemas independently of object key order and detects tampering', () => {
    const metadata = createRoutingServiceMetadata(schema);
    expect(createRoutingServiceMetadata({ properties: schema.properties, additionalProperties: false, type: 'object' }).preferencesSchemaHash).toBe(metadata.preferencesSchemaHash);
    expect(() => validateRoutingServiceMetadata(metadata)).not.toThrow();
    metadata.preferencesSchema.properties!.policy!.default = 'last';
    expect(() => validateRoutingServiceMetadata(metadata)).toThrow('hash mismatch');
  });
  it('rejects stale schema hashes and invalid requests', () => {
    const metadata = createRoutingServiceMetadata(schema);
    const request = { version: 1, service: 'selector', preferencesSchemaHash: metadata.preferencesSchemaHash, request: { path: '/v1/chat/completions', body: {} }, candidates: [{ serviceId: 'model', peerId: 'a'.repeat(40), inputUsdPerMillion: null, outputUsdPerMillion: 1 }], preferences: {} };
    expect(() => validateRoutingRequest(request, metadata)).not.toThrow();
    expect(() => validateRoutingRequest({ ...request, preferencesSchemaHash: 'stale' }, metadata)).toThrow('refresh');
    expect(() => validateRoutingRequest({ ...request, preferences: { count: '2' } }, metadata)).toThrow();
    expect(() => validateRoutingRequest({ ...request, candidates: [] }, metadata)).toThrow();
  });
});

describe('routing preference expansion limits', () => {
  function expandingSchema(): RoutingPreferenceSchema {
    let child: RoutingPreferenceSchema = { type: 'string', default: 'x' };
    for (let depth = 0; depth < 3; depth++) {
      child = {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: { child } },
        default: Array.from({ length: 30 }, () => ({})),
      };
    }
    return { type: 'object', additionalProperties: false, properties: { child } };
  }

  it('rejects compact schemas whose nested defaults expand beyond the byte limit', () => {
    const preferencesSchema = expandingSchema();
    expect(new TextEncoder().encode(JSON.stringify(preferencesSchema)).length).toBeLessThan(1024);
    expect(() => validateRoutingPreferenceSchema(preferencesSchema)).toThrow('16 KiB');
    expect(() => createRoutingServiceMetadata(preferencesSchema)).toThrow('16 KiB');
  });

  it('rejects expanding defaults before checking an untrusted descriptor hash', () => {
    expect(() => validateRoutingServiceMetadata({
      version: 1, preferencesSchema: expandingSchema(), preferencesSchemaHash: 'untrusted',
    })).toThrow('16 KiB');
  });

  it('also bounds defaults expanded while validating enum values', () => {
    const preferencesSchema: RoutingPreferenceSchema = {
      type: 'object', additionalProperties: false,
      properties: {
        entries: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', default: 'example' } } },
          enum: [Array.from({ length: 2000 }, () => ({}))],
        },
      },
    };
    expect(new TextEncoder().encode(JSON.stringify(preferencesSchema)).length).toBeLessThan(MAX_ROUTING_PREFERENCE_BYTES);
    expect(() => validateRoutingPreferenceSchema(preferencesSchema)).toThrow('16 KiB');
  });

  it('shares the validation work limit across sibling defaults', () => {
    const rows: RoutingPreferenceSchema = {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, { type: 'boolean' as const }])),
      },
      default: Array.from({ length: 400 }, () => ({})),
    };
    const single: RoutingPreferenceSchema = { type: 'object', additionalProperties: false, properties: { first: rows } };
    const combined: RoutingPreferenceSchema = { ...single, properties: { first: rows, second: structuredClone(rows) } };
    expect(new TextEncoder().encode(JSON.stringify(combined)).length).toBeLessThan(MAX_ROUTING_PREFERENCE_BYTES);
    expect(() => validateRoutingPreferenceSchema(single)).not.toThrow();
    expect(() => validateRoutingPreferenceSchema(combined)).toThrow('work limit');
  });

  it('also limits validation work when resolving supplied preferences', () => {
    const preferencesSchema: RoutingPreferenceSchema = {
      type: 'object', additionalProperties: false,
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, { type: 'boolean' as const }])),
          },
        },
      },
    };
    expect(() => validateRoutingPreferenceSchema(preferencesSchema)).not.toThrow();
    expect(() => resolveRoutingPreferences(preferencesSchema, { rows: Array.from({ length: 700 }, () => ({})) }))
      .toThrow('work limit');
  });

  it.each(['é🙂', '"\\\n'])('counts UTF-8 bytes, escapes and container punctuation during expansion: %j', (text) => {
    const preferencesSchema: RoutingPreferenceSchema = {
      type: 'object', additionalProperties: false,
      properties: {
        groups: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { 'quoted"key': { type: 'string', default: text } } },
        },
        padding: { type: 'string' },
      },
    };
    const expected = { groups: [{ 'quoted"key': text }, { 'quoted"key': text }], padding: '' };
    expected.padding = 'x'.repeat(MAX_ROUTING_PREFERENCE_BYTES - new TextEncoder().encode(JSON.stringify(expected)).length);
    const input = { groups: [{}, {}], padding: expected.padding };
    expect(resolveRoutingPreferences(preferencesSchema, input)).toEqual(expected);
    expect(() => resolveRoutingPreferences(preferencesSchema, { ...input, padding: `${input.padding}x` })).toThrow('16 KiB');
    expect(input.groups).toEqual([{}, {}]);
  });
});

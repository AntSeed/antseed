import { describe, expect, it } from 'vitest';
import { MAX_ROUTING_PREFERENCE_BYTES, assertRoutingPreferences, createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingPreferenceSchema, validateRoutingRequest, validateRoutingServiceMetadata, validateRoutingUsageContext, type RoutingPreferenceSchema } from './routing.js';

const schema: RoutingPreferenceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    policy: { type: 'string', enum: ['first', 'last'], default: 'first' },
  },
};

describe('router-defined preferences', () => {
  it('validates candidate effort labels without coercion', () => {
    const metadata = createRoutingServiceMetadata(schema);
    const candidate = { serviceId: 'model', peerId: 'a'.repeat(40), inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
    const request = { version: 1, service: 'selector', preferencesSchemaHash: metadata.preferencesSchemaHash,
      request: { path: '/v1/chat/completions', body: {} }, candidates: [candidate], preferences: {} };
    for (const reasoningEfforts of [undefined, [], ['none', 'high'], ['adaptive', 'deep-analysis']]) {
      expect(() => validateRoutingRequest({ ...request, candidates: [{ ...candidate, reasoningEfforts }] }, metadata)).not.toThrow();
    }
    for (const reasoningEfforts of [null, 'high', [''], [' deep'], [1], ['high', 'high'], ['x'.repeat(65)], Array.from({ length: 33 }, (_, index) => `effort-${index}`)]) {
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
  it('applies enum defaults without mutating values', () => {
    const values = {};
    expect(resolveRoutingPreferences(schema, values)).toEqual({ policy: 'first' });
    expect(values).toEqual({});
    expect(resolveRoutingPreferences(schema, { policy: 'last' })).toEqual({ policy: 'last' });
  });
  it.each([{ policy: 2 }, { policy: true }, { policy: 'other' }, { unknown: 'value' }, { policy: {} }, { policy: ['first'] }])('rejects invalid preferences %j', values => {
    expect(() => resolveRoutingPreferences(schema, values)).toThrow();
  });
  it('validates required fields and advertised defaults', () => {
    const required = { ...schema, properties: { policy: { type: 'string' as const, enum: ['first', 'last'] } }, required: ['policy'] };
    expect(() => resolveRoutingPreferences(required, {})).toThrow('Required');
    expect(resolveRoutingPreferences({ ...schema, required: ['policy'] }, {})).toEqual({ policy: 'first' });
  });
  it.each([
    { type: 'number', enum: [1, 3, 5] }, { type: 'boolean', enum: [true, false] },
    { type: 'object', properties: {} }, { type: 'array', items: { type: 'string' } },
    { type: 'string' }, { type: 'string', enum: [] }, { type: 'string', enum: ['first', 'first'] },
    { type: 'string', enum: [''] }, { type: 'string', enum: [1] },
    { type: 'string', enum: ['first'], default: 'last' }, { type: 'string', enum: ['first'], description: 1 },
    { type: 'string', enum: ['first'], title: 'Policy' }, { type: 'string', enum: ['first'], enumLabels: ['First'] },
  ])('rejects unsupported enum schemas %j', field => {
    expect(() => validateRoutingPreferenceSchema({ ...schema, properties: { field } })).toThrow();
  });
  it('supports provider-owned Levanto and Morph string choices', () => {
    for (const [key, choices] of [['costQuality', ['Cheapest', 'Cheaper', 'Balanced', 'Higher quality', 'Best quality']], ['policy', ['balanced', 'cost_efficient', 'capability_heavy', 'domain_skills']]] as const) {
      const metadata = createRoutingServiceMetadata({ type: 'object', additionalProperties: false,
        properties: { [key]: { type: 'string', description: 'Select a routing preference', enum: [...choices], default: choices[0] } } });
      expect(resolveRoutingPreferences(metadata.preferencesSchema, {})).toEqual({ [key]: choices[0] });
      expect(() => validateRoutingServiceMetadata(metadata)).not.toThrow();
    }
  });
  it('bounds schemas and values and rejects prototype-related keys', () => {
    expect(() => assertRoutingPreferences({ text: 'x'.repeat(16384) })).toThrow('16 KiB');
    expect(() => assertRoutingPreferences({ number: Infinity })).toThrow();
    expect(() => assertRoutingPreferences(JSON.parse('{"__proto__":"first"}'))).toThrow();
    expect(() => validateRoutingPreferenceSchema({ ...schema, properties: { policy: { ...schema.properties.policy, description: 'x'.repeat(16384) } } })).toThrow();
    expect(() => validateRoutingPreferenceSchema({ ...schema, required: ['missing'] })).toThrow();
  });
  it('leaves inference request bodies as arbitrary JSON', () => {
    const metadata = createRoutingServiceMetadata(schema);
    expect(() => validateRoutingRequest({ version: 1, service: 'selector', preferencesSchemaHash: metadata.preferencesSchemaHash,
      request: { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'hello' }], temperature: 0.5, stream: true } },
      candidates: [{ serviceId: 'model', peerId: 'a'.repeat(40), inputUsdPerMillion: 1, outputUsdPerMillion: 1 }], preferences: {} }, metadata)).not.toThrow();
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
  function expandingSchema(): unknown {
    let child: unknown = { type: 'string', default: 'x' };
    for (let depth = 0; depth < 3; depth++) {
      child = {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: { child } },
        default: Array.from({ length: 30 }, () => ({})),
      };
    }
    return { type: 'object', additionalProperties: false, properties: { child } };
  }

  it('rejects compact nested defaults without expanding them', () => {
    const preferencesSchema = expandingSchema();
    expect(new TextEncoder().encode(JSON.stringify(preferencesSchema)).length).toBeLessThan(1024);
    expect(() => validateRoutingPreferenceSchema(preferencesSchema)).toThrow('string choices');
    expect(() => createRoutingServiceMetadata(preferencesSchema as RoutingPreferenceSchema)).toThrow('string choices');
  });

  it('rejects expanding defaults before checking an untrusted descriptor hash', () => {
    expect(() => validateRoutingServiceMetadata({
      version: 1, preferencesSchema: expandingSchema(), preferencesSchemaHash: 'untrusted',
    })).toThrow('string choices');
  });

  it('rejects nested enum values without expanding defaults', () => {
    const preferencesSchema = {
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
    expect(() => validateRoutingPreferenceSchema(preferencesSchema)).toThrow('string choices');
  });

  it('rejects sibling default fan-out instead of doing recursive validation work', () => {
    const rows = {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['field' + index, { type: 'boolean' }])),
      },
      default: Array.from({ length: 400 }, () => ({})),
    };
    const single = { type: 'object', additionalProperties: false, properties: { first: rows } };
    const combined = { ...single, properties: { first: rows, second: structuredClone(rows) } };
    expect(new TextEncoder().encode(JSON.stringify(combined)).length).toBeLessThan(MAX_ROUTING_PREFERENCE_BYTES);
    expect(() => validateRoutingPreferenceSchema(single)).toThrow('string choices');
    expect(() => validateRoutingPreferenceSchema(combined)).toThrow('string choices');
  });

  it('rejects supplied nested preferences before recursive resolution', () => {
    const preferencesSchema = {
      type: 'object', additionalProperties: false,
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['field' + index, { type: 'boolean' }])),
          },
        },
      },
    };
    expect(() => resolveRoutingPreferences(preferencesSchema as unknown as RoutingPreferenceSchema, { rows: Array.from({ length: 700 }, () => ({})) }))
      .toThrow('string choices');
    expect(() => resolveRoutingPreferences(schema, { policy: Array.from({ length: 700 }, () => ({})) }))
      .toThrow('flat object');
  });

  it.each(['é🙂', '"\\\n'])('counts UTF-8 bytes, escapes and punctuation at the schema/value limits: %j', (text) => {
    const field = { type: 'string' as const, enum: [text], default: text, description: '' };
    const preferencesSchema: RoutingPreferenceSchema = {
      type: 'object', additionalProperties: false, properties: { 'quoted"key': field },
    };
    field.description = 'x'.repeat(MAX_ROUTING_PREFERENCE_BYTES - new TextEncoder().encode(JSON.stringify(preferencesSchema)).length);
    expect(() => createRoutingServiceMetadata(preferencesSchema)).not.toThrow();
    expect(resolveRoutingPreferences(preferencesSchema, {})).toEqual({ 'quoted"key': text });
    field.description += 'x';
    expect(() => validateRoutingPreferenceSchema(preferencesSchema)).toThrow('16 KiB');

    const input = { 'quoted"key': text, padding: '' };
    input.padding = 'x'.repeat(MAX_ROUTING_PREFERENCE_BYTES - new TextEncoder().encode(JSON.stringify(input)).length);
    expect(() => assertRoutingPreferences(input)).not.toThrow();
    expect(() => assertRoutingPreferences({ ...input, padding: input.padding + 'x' })).toThrow('16 KiB');
  });
});

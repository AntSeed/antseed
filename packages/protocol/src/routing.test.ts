import { describe, expect, it } from 'vitest';
import { assertRoutingPreferences, createRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingPreferenceSchema, validateRoutingRequest, validateRoutingServiceMetadata, type RoutingPreferenceSchema } from './routing.js';

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

import { describe, expect, it } from 'vitest';
import { createRoutingCatalog, validateRoutingCatalog } from './routing-catalog.js';

const model = { provider: 'openai', serviceId: 'model-a' };
describe('routing model catalogs', () => {
  it('hashes an optional service title without changing wire model identifiers', () => {
    const catalog = createRoutingCatalog([model], undefined, { title: 'Auto Router' });
    expect(catalog.title).toBe('Auto Router');
    expect(catalog.models).toEqual([model]);
    expect(catalog.version).toBe(1);
    expect(() => validateRoutingCatalog(catalog)).not.toThrow();
    expect(catalog.revision).not.toBe(createRoutingCatalog([model]).revision);
    expect(() => validateRoutingCatalog({ ...catalog, title: 'Other Router' })).toThrow('revision');
  });

  it.each(['', ' ', ' padded ', 'bad\nname', 'a'.repeat(129)])('rejects invalid catalog title %j', title => {
    expect(() => createRoutingCatalog([], undefined, { title })).toThrow('title');
  });

  it('hashes router-owned string-enum settings and rejects unsupported schemas', () => {
    const schema = { type: 'object' as const, additionalProperties: false as const, properties: {
      strategy: { type: 'string' as const, enum: ['fast', 'balanced'], default: 'balanced' },
    } };
    const catalog = createRoutingCatalog([model], schema);
    expect(catalog.preferencesSchema).toEqual(schema);
    schema.properties.strategy.default = 'fast';
    expect(createRoutingCatalog([model], schema).revision).not.toBe(catalog.revision);
    expect(catalog.preferencesSchema.properties.strategy!.default).toBe('balanced');
    expect(() => validateRoutingCatalog({ ...catalog, preferencesSchema: schema })).toThrow('revision');
    expect(() => validateRoutingCatalog({ ...catalog, preferencesSchema: { ...schema, properties: { strategy: { type: 'number', enum: [1, 2] } } } })).toThrow('string choices');
  });
  it('creates stable revisions and accepts empty catalogs without implying all models', () => {
    const other = { ...model, serviceId: 'model-b' };
    expect(createRoutingCatalog([model, other])).toEqual(createRoutingCatalog([other, model]));
    expect(createRoutingCatalog([model]).revision).not.toBe(createRoutingCatalog([other]).revision);
    expect(() => validateRoutingCatalog(createRoutingCatalog([]))).not.toThrow();
  });
  it('rejects altered, duplicate, oversized and malformed catalogs', () => {
    const valid = createRoutingCatalog([model]);
    for (const value of [null, [], { ...valid, revision: 'old' }, { ...valid, version: 2 },
      { ...valid, models: [{ ...model, serviceId: 'model-b' }] }, { ...valid, extra: true },
      { ...valid, routingRequestVersions: [1, 2] }]) {
      expect(() => validateRoutingCatalog(value)).toThrow();
    }
    expect(() => createRoutingCatalog([model, model])).toThrow('Duplicate');
    expect(() => createRoutingCatalog([{ ...model, serviceId: '*' }])).toThrow();
    expect(() => createRoutingCatalog(Array.from({ length: 257 }, (_, index) => ({ ...model, serviceId: `model-${index}` })))).toThrow();
    expect(() => createRoutingCatalog(Array.from({ length: 256 }, (_, index) => ({ provider: 'a'.repeat(64), serviceId: String(index).padStart(64, 'b') })))).toThrow('size');
  });
});

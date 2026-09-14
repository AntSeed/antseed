import { describe, expect, it } from 'vitest';
import { readRouterSettings, validateRouterSettings } from '../src/routing/router-settings.js';

describe('plugin-owned router settings', () => {
  it('preserves independent plugin and instance namespaces', () => {
    const input = { 'plugin:classifier': { policy: 'fast' }, 'instance:premium': { policy: 'quality' } };
    expect(readRouterSettings(input)).toEqual(input);
    expect(readRouterSettings(input)['plugin:classifier']).not.toBe(input['plugin:classifier']);
  });
  it.each([null, [], { bad: {} }, { 'plugin:a': { secret: {} } }, { 'plugin:a': { value: 'x'.repeat(4097) } }])('rejects invalid storage %j', (input) => {
    expect(() => readRouterSettings(input)).toThrow();
  });
  it('validates plugin-defined fields without a universal cost-quality mapping', () => {
    const schema = [{ key: 'policy', label: 'Policy', type: 'string' as const, options: ['fast', 'quality'] }];
    expect(validateRouterSettings(schema, { policy: 'fast' })).toEqual({ policy: 'fast' });
    expect(() => validateRouterSettings(schema, { costQuality: '5' })).toThrow();
    expect(() => validateRouterSettings(schema, { policy: 'unknown' })).toThrow();
    expect(validateRouterSettings([], {})).toEqual({});
  });
  it.each(['', 'NaN', '-1', '11'])('rejects out-of-range numeric value %s', (value) => {
    expect(() => validateRouterSettings([{ key: 'budget', label: 'Budget', type: 'number', min: 0, max: 10 }], { budget: value })).toThrow();
  });
});

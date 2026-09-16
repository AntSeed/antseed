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

  it('accepts scalar zero and explicit false without applying UI defaults', () => {
    const schema = [
      { key: 'threshold', label: 'Threshold', type: 'number' as const, min: 0, max: 1, default: '0.5' },
      { key: 'share', label: 'Share', type: 'boolean' as const, default: 'false' },
    ];
    expect(validateRouterSettings(schema, { threshold: '0', share: 'false' })).toEqual({ threshold: '0', share: 'false' });
    expect(validateRouterSettings(schema, {})).toEqual({});
    expect(() => validateRouterSettings(schema, { share: 'yes' })).toThrow();
  });

  it('bounds namespace and field counts without mutating other instances', () => {
    expect(() => readRouterSettings(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`instance:router-${index}`, {}])))).toThrow();
    expect(() => readRouterSettings({ 'plugin:classifier': Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`field${index}`, 'value'])) })).toThrow();
    const input = { 'instance:one': { policy: 'fast' }, 'instance:two': { policy: 'slow' } };
    const copy = readRouterSettings(input);
    copy['instance:one']!.policy = 'changed';
    expect(input['instance:one'].policy).toBe('fast');
    expect(copy['instance:two']!.policy).toBe('slow');
  });
});

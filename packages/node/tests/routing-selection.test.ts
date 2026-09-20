import { describe, expect, it } from 'vitest';
import { isRoutingSelection } from '../src/routing/selection.js';
import { readRouterSettings } from '../src/routing/router-settings.js';

describe('typed routing selection', () => {
  const service = { peerId: 'a'.repeat(40), provider: 'fixture', serviceId: 'selector' };
  it('accepts flat string choices only for network selections', () => {
    expect(isRoutingSelection({ kind: 'router', service, preferences: { policy: 'balanced' } })).toBe(true);
    expect(isRoutingSelection({ kind: 'router', preferences: {} })).toBe(false);
    expect(isRoutingSelection({ kind: 'model', model: 'model', preferences: {} })).toBe(false);
  });
  it.each([[], 'text', { value: Infinity }, { value: undefined }, { value: 'x'.repeat(16384) }])('rejects invalid offline preference structure', (preferences) => {
    expect(isRoutingSelection({ kind: 'router', service, preferences })).toBe(false);
  });
  it('rejects obsolete classifier settings without converting instructions', () => {
    expect(() => readRouterSettings({ 'plugin:classifier': { instructions: 'old value' } })).toThrow('selection.preferences');
    expect(readRouterSettings({ 'plugin:local': { custom: 'value' } })).toEqual({ 'plugin:local': { custom: 'value' } });
  });
});

describe('routing selection', () => {
  it.each([
    { kind: 'model', model: null },
    { kind: 'model', model: 'service' },
    { kind: 'router' },
    { kind: 'router', service: { peerId: 'a'.repeat(40), provider: 'openai', serviceId: 'classifier' } },
  ])('accepts a single selection: %j', (selection) => {
    expect(isRoutingSelection(selection)).toBe(true);
  });

  it.each([
    null, [], {}, { kind: 'model' }, { kind: 'model', model: '' },
    { kind: 'model', model: 'service', service: {} },
    { kind: 'router', model: 'fallback' }, { kind: 'router', service: null },
    { kind: 'router', service: { peerId: 'invalid', provider: 'openai', serviceId: 'classifier' } },
    { kind: 'router', service: { peerId: 'a'.repeat(40), provider: '', serviceId: 'classifier' } },
    { kind: 'router', service: { peerId: 'a'.repeat(40), provider: 'openai', serviceId: 'classifier', billing: {} } },
  ])('rejects conflicting or incomplete selections: %j', (selection) => {
    expect(isRoutingSelection(selection)).toBe(false);
  });
});

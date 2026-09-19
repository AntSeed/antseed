import { describe, expect, it } from 'vitest';
import { isRoutingSelection } from '../src/routing/selection.js';

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

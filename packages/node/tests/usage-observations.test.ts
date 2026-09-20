import { describe, expect, it } from 'vitest';
import { validateRoutingUsageContext } from '@antseed/protocol';
import { RoutingObservationHistory } from '../src/routing/usage-observations.js';
import type { ConversationIdentity } from '../src/routing/conversation-identity.js';

const conversation: ConversationIdentity = { tool: 'test-tool', sessionKey: 'private-session', parentSessionKey: null, isUserThread: true };
const offer = { peerId: 'a'.repeat(40), provider: 'provider-entry', serviceId: 'model-a' };

describe('routing usage observations', () => {
  it('keeps missing cache usage distinct from a reported zero and accumulates skipped turns', () => {
    let now = 100;
    const history = new RoutingObservationHistory(() => now);
    history.record(conversation, offer, { inputTokens: 10 });
    now = 200;
    history.record(conversation, offer, { inputTokens: 20, cachedInputTokens: 0 });
    now = 300;
    history.record(conversation, offer, { inputTokens: 30, cachedInputTokens: 15 });
    const context = history.snapshot(conversation, 'router-a', [offer])!;
    expect(context.usageObservations.map(({ ageMs }) => ageMs)).toEqual([200, 100, 0]);
    expect(context.usageObservations[0]).not.toHaveProperty('cachedInputTokens');
    expect(context.usageObservations[1]!.cachedInputTokens).toBe(0);
    expect(context.usageObservations[2]!.cachedInputTokens).toBe(15);
    expect(context.historyTruncated).toBe(false);
    expect(() => validateRoutingUsageContext(context)).not.toThrow();
    expect(JSON.stringify(context)).not.toContain('private-session');
  });

  it('scopes identifiers to the router and conversation and returns independent snapshots', () => {
    const history = new RoutingObservationHistory(() => 100);
    history.record(conversation, offer, { inputTokens: 10, cachedInputTokens: 4 });
    const first = history.snapshot(conversation, 'router-a', [offer])!;
    expect(history.snapshot(conversation, 'router-a', [offer])).toEqual(first);
    const second = history.snapshot(conversation, 'router-b', [offer])!;
    expect(second.conversationRef).not.toBe(first.conversationRef);
    expect(second.usageObservations[0]!.id).not.toBe(first.usageObservations[0]!.id);
    const other = history.snapshot({ ...conversation, sessionKey: 'other' }, 'router-a', [offer])!;
    expect(other.conversationRef).not.toBe(first.conversationRef);
    expect(other.usageObservations).toEqual([]);
    expect(history.snapshot({ ...conversation, parentSessionKey: 'parent' }, 'router-a', [offer])!.usageObservations).toEqual([]);
    first.usageObservations[0]!.offer.serviceId = 'changed';
    expect(history.snapshot(conversation, 'router-a', [offer])!.usageObservations[0]!.offer.serviceId).toBe('model-a');
    expect(history.snapshot(null, 'router-a', [offer])).toBeUndefined();
  });

  it('keeps offers separate and sends only history matching eligible candidates', () => {
    const history = new RoutingObservationHistory();
    history.record(conversation, offer, { inputTokens: 10, cachedInputTokens: 1 });
    history.record(conversation, { ...offer, peerId: 'b'.repeat(40) }, { inputTokens: 20, cachedInputTokens: 2 });
    history.record(conversation, { ...offer, serviceId: 'model-b' }, { inputTokens: 30, cachedInputTokens: 3 });
    history.record(conversation, { ...offer, provider: 'another-provider' }, { inputTokens: 40, cachedInputTokens: 4 });
    expect(history.snapshot(conversation, 'router', [offer])!.usageObservations.map(({ inputTokens }) => inputTokens)).toEqual([10]);
    const values = history.snapshot(conversation, 'router', [offer, { ...offer, provider: 'another-provider' }])!.usageObservations;
    expect(values.map(({ inputTokens }) => inputTokens)).toEqual([10, 40]);
    expect(values.map(({ offer: entry }) => entry.provider)).toEqual(['provider-entry', 'another-provider']);
  });

  it('bounds count and wire size and explicitly marks truncation', () => {
    const history = new RoutingObservationHistory();
    for (let index = 0; index < 70; index++) history.record(conversation, offer, { inputTokens: index });
    const result = history.snapshot(conversation, 'router', [offer])!;
    expect(result.historyTruncated).toBe(true);
    expect(result.usageObservations.length).toBeLessThanOrEqual(64);
    expect(result.usageObservations.at(-1)!.inputTokens).toBe(69);
    const largeOffer = { ...offer, provider: 'x'.repeat(256), serviceId: 'y'.repeat(256) };
    for (let index = 0; index < 64; index++) history.record(conversation, largeOffer, { inputTokens: index });
    const large = history.snapshot(conversation, 'router', [largeOffer])!;
    expect(large.historyTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(16384);
    expect(() => validateRoutingUsageContext(large)).not.toThrow();
  });

  it('expires observations, rotates evicted conversation references, and clears history', () => {
    let now = 0;
    const history = new RoutingObservationHistory(() => now, 1, 100);
    history.record(conversation, offer, { inputTokens: 10 });
    const initial = history.snapshot(conversation, 'router', [offer])!;
    now = 60;
    history.record(conversation, offer, { inputTokens: 20 });
    now = 110;
    const trimmed = history.snapshot(conversation, 'router', [offer])!;
    expect(trimmed.conversationRef).toBe(initial.conversationRef);
    expect(trimmed.historyTruncated).toBe(true);
    expect(trimmed.usageObservations.map(({ inputTokens }) => inputTokens)).toEqual([20]);
    history.snapshot({ ...conversation, sessionKey: 'other' }, 'router', []);
    const reset = history.snapshot(conversation, 'router', [offer])!;
    expect(reset.conversationRef).not.toBe(initial.conversationRef);
    expect(reset.usageObservations).toEqual([]);
    now = 211;
    expect(history.snapshot(conversation, 'router', [])!.conversationRef).not.toBe(reset.conversationRef);
    history.record(conversation, offer, { inputTokens: 99 });
    history.clear();
    expect(history.snapshot(conversation, 'router', [offer])!.usageObservations).toEqual([]);
  });

  it('ignores untracked or malformed observations', () => {
    const history = new RoutingObservationHistory();
    history.record(null, offer, { inputTokens: 10 });
    history.record(conversation, offer, { inputTokens: -1 });
    history.record(conversation, offer, { inputTokens: 1, cachedInputTokens: 2 });
    expect(history.snapshot(conversation, 'router', [offer])!.usageObservations).toEqual([]);
    expect(() => new RoutingObservationHistory(Date.now, 0)).toThrow('bounds');
  });

  it('does not double count a repeated inference result and never exposes its request ID', () => {
    const history = new RoutingObservationHistory();
    history.record(conversation, offer, { inputTokens: 10 }, 'private-request-id');
    history.record(conversation, offer, { inputTokens: 10 }, 'private-request-id');
    const result = history.snapshot(conversation, 'router', [offer])!;
    expect(result.usageObservations).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-request-id');
  });
});

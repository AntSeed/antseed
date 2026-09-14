import { describe, expect, it } from 'vitest';
import { RoutingContextTracker } from '../src/routing/routing-context.js';
import type { ConversationIdentity } from '../src/routing/conversation-identity.js';
import type { SerializedHttpRequest } from '../src/types/http.js';

const conversation: ConversationIdentity = { tool: 'test', sessionKey: 'one', parentSessionKey: null, isUserThread: true };
const route = { peerId: 'peer', serviceId: 'model' };
const user = { role: 'user', content: 'private repeated prompt' };
function request(messages: unknown[] = [user], headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): SerializedHttpRequest {
  return { requestId: 'request', path: '/v1/chat/completions', method: 'POST', headers,
    body: new TextEncoder().encode(JSON.stringify({ model: 'auto', messages, ...extra })) };
}
function started() {
  const tracker = new RoutingContextTracker();
  expect(tracker.observe(request(), conversation).trigger).toBe('new-session');
  tracker.recordRoute(conversation, 'request', route);
  return tracker;
}

describe('routing context and local cadence gate', () => {
  it('does not claim a session or reuse without identity', () => {
    expect(started().observe(request(), null, { cadence: 'session' })).toMatchObject({ shouldRoute: true, previousRoute: null });
  });
  it.each([
    { role: 'tool', content: 'result', tool_call_id: 'one' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'result' }] },
    { type: 'function_call_output', call_id: 'one', output: 'result' },
  ])('reuses on tool-result continuation %j', (tool) => {
    expect(started().observe(request([user, { role: 'assistant', content: 'working' }, tool]), conversation, { cadence: 'turn' }))
      .toMatchObject({ trigger: 'continuation', shouldRoute: false, previousRoute: route });
  });
  it('recognizes an identical user message appended as a new turn', () => {
    expect(started().observe(request([user, { role: 'assistant', content: 'answer' }, user]), conversation, { cadence: 'turn' }))
      .toMatchObject({ trigger: 'new-turn', shouldRoute: true });
  });
  it('uses an explicit turn ID when clients send only the same text', () => {
    expect(started().observe(request([user], { 'x-antseed-turn-id': 'next' }), conversation, { cadence: 'turn' }))
      .toMatchObject({ trigger: 'new-turn', shouldRoute: true });
  });
  it('distinguishes session stickiness from turn and request cadence', () => {
    const next = request([user, { role: 'assistant', content: 'answer' }, user]);
    expect(started().observe(next, conversation, { cadence: 'session' }).shouldRoute).toBe(false);
    expect(started().observe(next, conversation, { cadence: 'turn' }).shouldRoute).toBe(true);
    expect(started().observe(request(), conversation, { cadence: 'request' }).shouldRoute).toBe(true);
  });
  it.each([
    request([{ role: 'system', content: 'compacted summary' }, user]),
    request([user], {}, { system: 'rewritten system' }),
    request([user], { 'x-antseed-context-revision': 'compacted-v2' }),
    request([user], {}, { tools: [{ name: 'new-tool' }] }),
  ])('reconsiders rewritten context without asserting a cold cache', (next) => {
    expect(started().observe(next, conversation, { cadence: 'session' })).toMatchObject({
      trigger: 'context-rewrite', shouldRoute: true, contextRewritten: true, cacheState: 'unknown', previousRoute: route,
    });
  });
  it('routes again on explicit refresh, settings change, or ineligible previous route', () => {
    expect(started().observe(request([user], { 'x-antseed-route-refresh': 'true' }), conversation, { cadence: 'session' }).trigger).toBe('explicit');
    expect(started().observe(request(), conversation, { cadence: 'session', settings: { policy: 'new' } }).trigger).toBe('settings-changed');
    expect(started().observe(request(), conversation, { cadence: 'session', isRouteAvailable: () => false }))
      .toMatchObject({ trigger: 'route-unavailable', shouldRoute: true, previousRoute: null });
  });
  it('does not let late completion overwrite a newer decision', () => {
    const tracker = started();
    tracker.observe({ ...request(), requestId: 'newer' }, conversation);
    tracker.recordRoute(conversation, 'newer', { peerId: 'new', serviceId: 'new' });
    tracker.recordRoute(conversation, 'request', route);
    expect(tracker.observe(request(), conversation).previousRoute?.peerId).toBe('new');
  });
  it('isolates tools, sessions and parents and expires old state', () => {
    const tracker = started();
    for (const different of [{ ...conversation, tool: 'other' }, { ...conversation, sessionKey: 'two' }, { ...conversation, parentSessionKey: 'parent' }]) {
      expect(tracker.observe(request(), different).trigger).toBe('new-session');
    }
    let now = 0;
    const bounded = new RoutingContextTracker(() => now, 100, 1);
    bounded.observe(request(), conversation);
    now = 100;
    expect(bounded.observe(request(), conversation).trigger).toBe('new-session');
    bounded.observe(request(), { ...conversation, sessionKey: 'two' });
    expect(bounded.observe(request(), conversation).trigger).toBe('new-session');
  });
  it('stores hashes instead of prompt content and reroutes when no decision completed', () => {
    const tracker = new RoutingContextTracker();
    tracker.observe(request(), conversation);
    expect(tracker.observe(request(), conversation, { cadence: 'session' }).shouldRoute).toBe(true);
    tracker.recordRoute(conversation, 'request', { ...route, request: { body: 'private repeated prompt' } } as typeof route);
    expect(JSON.stringify([...(tracker as any).sessions.values()])).not.toContain('private repeated prompt');
  });
  it('does not infer unseen Responses API history from a previous-response pointer', () => {
    expect(started().observe(request([user], {}, { previous_response_id: 'remote' }), conversation, { cadence: 'session' }))
      .toMatchObject({ trigger: 'request', shouldRoute: true, previousRoute: null });
  });
});

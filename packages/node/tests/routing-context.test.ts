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

describe('routing context and latest-user-text reuse', () => {
  it('preserves model-only intent and ordered exact-to-auto fallbacks across continuations', () => {
    const tracker = started();
    const recommendations = [route, { serviceId: 'model' }];
    tracker.recordRoutes(conversation, 'request', recommendations);
    recommendations.pop();
    const observed = tracker.observe(request(), conversation);
    expect(observed.previousRoutes).toEqual([route, { serviceId: 'model' }]);
    observed.previousRoutes!.pop();
    expect(tracker.observe(request(), conversation, { isRouteAvailable: (candidate) => !candidate.peerId }))
      .toMatchObject({ shouldRoute: false, previousRoute: { serviceId: 'model' }, previousRoutes: [{ serviceId: 'model' }] });
  });

  it('forgets a changed conversation selection and its children but not other conversations', () => {
    const tracker = started();
    const child = { ...conversation, sessionKey: 'child', parentSessionKey: 'one' };
    const other = { ...conversation, sessionKey: 'other' };
    tracker.observe(request(), child);
    tracker.recordRoute(child, 'request', route);
    tracker.observe(request(), other);
    tracker.recordRoute(other, 'request', route);
    tracker.forgetConversation('test', 'one');
    expect(tracker.observe(request(), conversation).trigger).toBe('new-session');
    expect(tracker.observe(request(), child).trigger).toBe('new-session');
    expect(tracker.observe(request(), other).shouldRoute).toBe(false);
  });

  it('does not claim a session or reuse without identity', () => {
    expect(started().observe(request(), null)).toMatchObject({ shouldRoute: true, previousRoute: null });
  });
  it.each([
    { role: 'tool', content: 'result', tool_call_id: 'one' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'result' }] },
    { type: 'function_call_output', call_id: 'one', output: 'result' },
  ])('reuses on tool-result continuation %j', (tool) => {
    expect(started().observe(request([user, { role: 'assistant', content: 'working' }, tool]), conversation))
      .toMatchObject({ trigger: 'continuation', shouldRoute: false, previousRoute: route });
  });
  it('intentionally reuses when identical user text is appended as another turn', () => {
    expect(started().observe(request([user, { role: 'assistant', content: 'answer' }, user]), conversation))
      .toMatchObject({ trigger: 'continuation', shouldRoute: false, previousRoute: route });
  });
  it('reconsiders when the latest user text changes', () => {
    expect(started().observe(request([user, { role: 'user', content: 'different task' }]), conversation))
      .toMatchObject({ trigger: 'new-turn', shouldRoute: true });
  });
  it('handles text blocks and Responses API inputs', () => {
    for (const content of [[{ type: 'text', text: user.content }], [{ type: 'input_text', text: user.content }]]) {
      expect(started().observe(request([{ role: 'user', content }]), conversation).shouldRoute).toBe(false);
    }
    expect(started().observe(request([], {}, { input: user.content }), conversation).shouldRoute).toBe(false);
    expect(started().observe(request([], {}, { messages: undefined, input: [user] }), conversation).shouldRoute).toBe(false);
  });
  it.each([
    request([{ role: 'system', content: 'compacted summary' }, user]),
    request([user], {}, { system: 'rewritten system' }),
    request([user], { 'x-antseed-context-revision': 'compacted-v2' }),
    request([user], {}, { tools: [{ name: 'new-tool' }] }),
    request([user], { 'x-antseed-turn-id': 'next', 'x-antseed-route-refresh': 'true' }),
  ])('intentionally ignores earlier history and legacy refresh hints when user text is unchanged', (next) => {
    expect(started().observe(next, conversation)).toMatchObject({
      trigger: 'continuation', shouldRoute: false, previousRoute: route,
    });
  });
  it('routes again when the previous route is ineligible', () => {
    expect(started().observe(request(), conversation, { isRouteAvailable: () => false }))
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
    expect(tracker.observe(request(), conversation).shouldRoute).toBe(true);
    tracker.recordRoute(conversation, 'request', { ...route, request: { body: 'private repeated prompt' } } as typeof route);
    expect(JSON.stringify([...(tracker as any).sessions.values()])).not.toContain('private repeated prompt');
  });
  it('does not reuse when no user text can be observed', () => {
    expect(started().observe(request([], {}, { previous_response_id: 'remote' }), conversation))
      .toMatchObject({ trigger: 'request', shouldRoute: true, previousRoute: null });
  });

  it('does not reuse an old route after a changed-text selection failed or was cancelled', () => {
    const tracker = started();
    const changed = request([{ role: 'user', content: 'new task' }]);
    expect(tracker.observe(changed, conversation).trigger).toBe('new-turn');
    expect(tracker.observe(changed, conversation))
      .toMatchObject({ trigger: 'route-unavailable', shouldRoute: true, previousRoute: null });
  });

  it('discards old tracking when an intervening request has unobservable history', () => {
    const tracker = started();
    tracker.observe(request([], {}, { previous_response_id: 'remote' }), conversation);
    expect(tracker.observe(request(), conversation).trigger).toBe('new-session');
  });
  it.each([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'image' } }] },
    { role: 'user', content: null },
    { role: 'user', content: [] },
  ])('does not reuse for a latest user message without observable text: %j', (message) => {
    expect(started().observe(request([user, message]), conversation).shouldRoute).toBe(true);
  });
});

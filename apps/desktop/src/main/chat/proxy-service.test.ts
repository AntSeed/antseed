import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchProxyConversationRoute, makeProxyService } from './proxy-service.js';

test('makeProxyService sends soft affinity for auto routes and hard pins explicit routes', () => {
  const auto = makeProxyService('model-a', 8377, 'openai-chat-completions', 'peer-a', null, false, 'auto', 'conv-a');
  assert.equal(auto.headers?.['x-antseed-prefer-peer'], 'peer-a');
  assert.equal(auto.headers?.['x-antseed-pin-peer'], undefined);
  assert.equal(auto.headers?.['x-vpr-session-id'], 'conv-a');

  const pinned = makeProxyService('model-a', 8377, 'openai-chat-completions', 'peer-b', null, false, 'pinned', 'conv-b');
  assert.equal(pinned.headers?.['x-antseed-pin-peer'], 'peer-b');
  assert.equal(pinned.headers?.['x-antseed-prefer-peer'], undefined);
});

test('fetchProxyConversationRoute reads the actual routed peer from the buyer conversation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /vpr%3Aconv-a$/);
    return new Response(JSON.stringify({
      conversation: { lastModel: `${'ab'.repeat(20)}@kimi-k3` },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await fetchProxyConversationRoute(8377, 'conv-a'), {
      peerId: 'ab'.repeat(20),
      service: 'kimi-k3',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

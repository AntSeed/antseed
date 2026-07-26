import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANTSEED_PEER_CUSTOM_TYPE,
  normalizeChatPeerSelectionRequest,
  resolveLatestPeerBinding,
} from './chat-peer-selection.js';

test('normalizeChatPeerSelectionRequest preserves legacy string payloads', () => {
  assert.deepEqual(normalizeChatPeerSelectionRequest(' peer-123 '), {
    conversationId: null,
    peerId: 'peer-123',
    service: null,
    provider: null,
  });

  assert.deepEqual(normalizeChatPeerSelectionRequest(null), {
    conversationId: null,
    peerId: null,
    service: null,
    provider: null,
  });
});

test('normalizeChatPeerSelectionRequest trims conversation-scoped payloads', () => {
  assert.deepEqual(
    normalizeChatPeerSelectionRequest({ conversationId: ' conv-1 ', peerId: ' peer-1 ' }),
    {
      conversationId: 'conv-1',
      peerId: 'peer-1',
      service: null,
      provider: null,
    },
  );
});

test('normalizeChatPeerSelectionRequest carries the model rebinding through', () => {
  assert.deepEqual(
    normalizeChatPeerSelectionRequest({
      conversationId: 'conv-1',
      peerId: null,
      service: ' glm-3.2 ',
      provider: ' openai ',
    }),
    {
      conversationId: 'conv-1',
      peerId: null,
      service: 'glm-3.2',
      provider: 'openai',
    },
  );
});

test('resolveLatestPeerBinding treats a newer clear entry as authoritative', () => {
  const binding = resolveLatestPeerBinding([
    {
      type: 'custom',
      customType: ANTSEED_PEER_CUSTOM_TYPE,
      data: { peerId: 'peer-old', peerLabel: 'Old peer' },
    },
    {
      type: 'custom',
      customType: ANTSEED_PEER_CUSTOM_TYPE,
      data: {},
    },
  ]);

  assert.equal(binding, null);
});

test('resolveLatestPeerBinding returns the latest non-empty peer binding', () => {
  const binding = resolveLatestPeerBinding([
    {
      type: 'custom',
      customType: ANTSEED_PEER_CUSTOM_TYPE,
      data: { peerId: 'peer-old', peerLabel: 'Old peer' },
    },
    {
      type: 'custom',
      customType: ANTSEED_PEER_CUSTOM_TYPE,
      data: { peerId: ' peer-new ', peerLabel: ' New peer ' },
    },
  ]);

  assert.deepEqual(binding, { peerId: 'peer-new', peerLabel: 'New peer' });
});

test('resolveLatestPeerBinding surfaces the recorded route mode', () => {
  const binding = resolveLatestPeerBinding([
    { type: 'custom', customType: ANTSEED_PEER_CUSTOM_TYPE, data: { peerId: 'peer-1', routeMode: 'pinned' } },
  ]);
  assert.deepEqual(binding, { peerId: 'peer-1', routeMode: 'pinned' });
});

test('a legacy binding without a route mode resolves to undefined', () => {
  // Threads predate route-mode tracking; callers treat these as auto.
  const binding = resolveLatestPeerBinding([
    { type: 'custom', customType: ANTSEED_PEER_CUSTOM_TYPE, data: { peerId: 'peer-1' } },
  ]);
  assert.deepEqual(binding, { peerId: 'peer-1' });
});

test('an unrecognized route mode is ignored rather than trusted', () => {
  const binding = resolveLatestPeerBinding([
    { type: 'custom', customType: ANTSEED_PEER_CUSTOM_TYPE, data: { peerId: 'peer-1', routeMode: 'whatever' } },
  ]);
  assert.deepEqual(binding, { peerId: 'peer-1' });
});

test('the newest binding wins when the route mode changes', () => {
  const binding = resolveLatestPeerBinding([
    { type: 'custom', customType: ANTSEED_PEER_CUSTOM_TYPE, data: { peerId: 'peer-1', routeMode: 'auto' } },
    { type: 'custom', customType: ANTSEED_PEER_CUSTOM_TYPE, data: { peerId: 'peer-2', routeMode: 'pinned' } },
  ]);
  assert.deepEqual(binding, { peerId: 'peer-2', routeMode: 'pinned' });
});

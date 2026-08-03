import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANTSEED_PEER_CUSTOM_TYPE,
  normalizeChatPeerSelectionRequest,
  resolveLatestPeerBinding,
} from './peer-selection.js';

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

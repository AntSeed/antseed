import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPersistedPeerBindingPinned,
  projectPeerBinding,
  projectPersistedConversationRoute,
} from './conversation-store.js';

test('projectPeerBinding restores a persisted pinned route mode', () => {
  assert.deepEqual(
    projectPeerBinding({ peerId: 'peer-a', peerLabel: 'Peer A', routeMode: 'pinned' }),
    { peerId: 'peer-a', peerLabel: 'Peer A', routeMode: 'pinned' },
  );
});

test('only explicit persisted pins remain pinned after upgrade', () => {
  assert.equal(isPersistedPeerBindingPinned({ peerId: 'peer-a' }), false);
  assert.equal(isPersistedPeerBindingPinned({ peerId: 'peer-a', routeMode: 'pinned' }), true);
  assert.equal(isPersistedPeerBindingPinned({ peerId: 'peer-a', routeMode: 'auto' }), false);
});

test('legacy persisted conversations reopen in model-only Auto mode', () => {
  assert.deepEqual(
    projectPersistedConversationRoute({ peerId: 'peer-a' }),
    { peerId: undefined, routeMode: 'auto' },
  );
  assert.deepEqual(
    projectPersistedConversationRoute({ peerId: 'peer-a', routeMode: 'pinned' }),
    { peerId: 'peer-a', routeMode: 'pinned' },
  );
});

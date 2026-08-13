import test from 'node:test';
import assert from 'node:assert/strict';

import { isPersistedPeerBindingPinned, projectPeerBinding } from './conversation-store.js';

test('projectPeerBinding restores a persisted pinned route mode', () => {
  assert.deepEqual(
    projectPeerBinding({ peerId: 'peer-a', peerLabel: 'Peer A', routeMode: 'pinned' }),
    { peerId: 'peer-a', peerLabel: 'Peer A', routeMode: 'pinned' },
  );
});

test('legacy persisted peers without routeMode remain pinned after upgrade', () => {
  assert.equal(isPersistedPeerBindingPinned({ peerId: 'peer-a' }), true);
  assert.equal(isPersistedPeerBindingPinned({ peerId: 'peer-a', routeMode: 'pinned' }), true);
  assert.equal(isPersistedPeerBindingPinned({ peerId: 'peer-a', routeMode: 'auto' }), false);
});

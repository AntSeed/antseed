import test from 'node:test';
import assert from 'node:assert/strict';

import { projectPeerBinding } from './conversation-store.js';

test('projectPeerBinding restores a persisted pinned route mode', () => {
  assert.deepEqual(
    projectPeerBinding({ peerId: 'peer-a', peerLabel: 'Peer A', routeMode: 'pinned' }),
    { peerId: 'peer-a', peerLabel: 'Peer A', routeMode: 'pinned' },
  );
});

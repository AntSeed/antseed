import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sortConversationsWithinPeer } from './sidebar-conversation-sort.js';

test('sortConversationsWithinPeer puts favorites first by favoritedAt without reordering non-favorites', () => {
  const conversations = [
    { id: 'recent-regular', updatedAt: 400 },
    { id: 'older-favorite', favorite: true, favoritedAt: 100 },
    { id: 'old-regular', updatedAt: 100 },
    { id: 'newer-favorite', favorite: true, favoritedAt: 200 },
  ];

  assert.deepEqual(
    sortConversationsWithinPeer(conversations).map((conv) => conv.id),
    ['newer-favorite', 'older-favorite', 'recent-regular', 'old-regular'],
  );
});

test('sortConversationsWithinPeer treats positive favoritedAt as favorite', () => {
  const conversations = [
    { id: 'regular' },
    { id: 'favorite-by-time', favoritedAt: 1 },
  ];

  assert.deepEqual(
    sortConversationsWithinPeer(conversations).map((conv) => conv.id),
    ['favorite-by-time', 'regular'],
  );
});

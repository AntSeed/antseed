import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialUiState } from '../core/state.js';
import { initChatModule } from './chat.js';
import type { DesktopBridge } from '../types/bridge.js';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('setConversationFavorite persists toggle and refreshes conversations', async () => {
  const uiState = createInitialUiState();
  uiState.chatConversations = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: 1,
      updatedAt: 2,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const calls: Array<{ id: string; favorite: boolean }> = [];
  let listCalls = 0;

  const bridge: DesktopBridge = {
    chatAiSetConversationFavorite: async (id, favorite) => {
      calls.push({ id, favorite });
      return {
        ok: true,
        data: { id, favorite, favoritedAt: 123 },
      };
    },
    chatAiListConversations: async () => {
      listCalls += 1;
      return {
        ok: true,
        data: [{ id: 'conv-a', title: 'Conversation A', favorite: true, favoritedAt: 123 }],
      };
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  await api.setConversationFavorite('conv-a', true);

  assert.deepEqual(calls, [{ id: 'conv-a', favorite: true }]);
  assert.equal(listCalls, 1);
  assert.equal((uiState.chatConversations[0] as Record<string, unknown>).favorite, true);
  assert.equal((uiState.chatConversations[0] as Record<string, unknown>).favoritedAt, 123);
});

test('stale favorite toggle completion does not overwrite a newer toggle', async () => {
  const uiState = createInitialUiState();
  uiState.chatConversations = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      favorite: false,
      createdAt: 1,
      updatedAt: 2,
    },
  ];

  const first = createDeferred<{ ok: true }>();
  const second = createDeferred<{ ok: true }>();
  const calls: Array<{ id: string; favorite: boolean }> = [];
  let listCalls = 0;

  const bridge: DesktopBridge = {
    chatAiSetConversationFavorite: async (id, favorite) => {
      calls.push({ id, favorite });
      return calls.length === 1 ? first.promise : second.promise;
    },
    chatAiListConversations: async () => {
      listCalls += 1;
      return {
        ok: true,
        data: [{ id: 'conv-a', title: 'Conversation A', favorite: false }],
      };
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  const favoritePromise = api.setConversationFavorite('conv-a', true);
  const unfavoritePromise = api.setConversationFavorite('conv-a', false);

  first.resolve({ ok: true });
  await favoritePromise;
  assert.equal(listCalls, 0, 'stale completion should not refresh conversations');
  assert.equal((uiState.chatConversations[0] as Record<string, unknown>).favorite, false);

  second.resolve({ ok: true });
  await unfavoritePromise;
  assert.equal(listCalls, 1);
  assert.deepEqual(calls, [
    { id: 'conv-a', favorite: true },
    { id: 'conv-a', favorite: false },
  ]);
});

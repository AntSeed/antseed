import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVprMenuBarAction } from './vpr-menu-bar.js';

test('menu-bar action normalizer accepts navigation and lifecycle actions', () => {
  assert.deepEqual(normalizeVprMenuBarAction({ type: 'dismiss' }), { type: 'dismiss' });
  assert.deepEqual(normalizeVprMenuBarAction({ type: 'open-main' }), { type: 'open-main' });
  assert.deepEqual(normalizeVprMenuBarAction({ type: 'open-chats' }), { type: 'open-chats' });
  assert.deepEqual(
    normalizeVprMenuBarAction({ type: 'open-floating-window' }),
    { type: 'open-floating-window' },
  );
  assert.deepEqual(normalizeVprMenuBarAction({ type: 'open-deposit' }), { type: 'open-deposit' });
});

test('menu-bar action normalizer accepts routing actions', () => {
  assert.deepEqual(
    normalizeVprMenuBarAction({ type: 'select-model', provider: 'openai', serviceId: 'gpt' }),
    { type: 'select-model', provider: 'openai', serviceId: 'gpt' },
  );
  assert.deepEqual(
    normalizeVprMenuBarAction({
      type: 'pin-chat-model',
      conversationId: 'chat-1',
      provider: 'anthropic',
      serviceId: 'claude',
    }),
    {
      type: 'pin-chat-model',
      conversationId: 'chat-1',
      provider: 'anthropic',
      serviceId: 'claude',
    },
  );
  assert.deepEqual(
    normalizeVprMenuBarAction({ type: 'open-chat-app', conversationId: 'chat-1' }),
    { type: 'open-chat-app', conversationId: 'chat-1' },
  );
});

test('menu-bar action normalizer rejects malformed payloads', () => {
  const malformed = [
    null,
    'open-main',
    [],
    {},
    { type: 'unknown' },
    { type: 'select-model', provider: '', serviceId: 'gpt' },
    { type: 'select-model', provider: 'openai', serviceId: 1 },
    { type: 'pin-chat-model', conversationId: '', provider: 'openai', serviceId: 'gpt' },
    { type: 'pin-chat-model', conversationId: 'chat', provider: null, serviceId: 'gpt' },
    { type: 'open-chat-app', conversationId: '   ' },
  ];

  for (const action of malformed) assert.equal(normalizeVprMenuBarAction(action), null);
});

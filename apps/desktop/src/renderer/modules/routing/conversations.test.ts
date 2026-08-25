import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BuyerConversationSummary } from '../../types/bridge.js';
import {
  conversationPinnedPeerId,
  conversationPinnedServiceId,
  conversationRoutedPeerId,
  conversationTitle,
} from './conversations.js';

function conversation(overrides: Partial<BuyerConversationSummary>): BuyerConversationSummary {
  return {
    id: 'opencode:session',
    tool: 'opencode',
    sessionKey: 'session',
    label: null,
    snippet: null,
    pinnedModel: null,
    peerSource: 'auto',
    lastModel: null,
    lastActiveAt: 0,
    spentUsdc: '0',
    ...overrides,
  } as BuyerConversationSummary;
}

test('conversation titles prefer labels, integration titles, snippets, then session ids', () => {
  assert.equal(conversationTitle(conversation({
    label: 'VPR label',
    integrationTitle: 'Codex title',
    snippet: 'First prompt',
  })), 'VPR label');
  assert.equal(conversationTitle(conversation({
    integrationTitle: 'Codex title',
    snippet: 'First prompt',
  })), 'Codex title');
  assert.equal(conversationTitle(conversation({ snippet: 'First prompt' })), 'First prompt');
  assert.equal(conversationTitle(conversation({
    sessionKey: '01a03917-8caf-75f0-84da-4303a1da306c',
    snippet: '',
  })), '01a03917-8ca');
});

test('model-only automatic routes expose a service without a pinned peer', () => {
  const record = conversation({ pinnedModel: 'gpt-5.6-sol' });
  assert.equal(conversationPinnedServiceId(record), 'gpt-5.6-sol');
  assert.equal(conversationPinnedPeerId(record), null);
  assert.equal(conversationRoutedPeerId(record), null);
});

test('explicit seller routes expose both peer and service', () => {
  const peerId = 'a'.repeat(40);
  const record = conversation({
    pinnedModel: `${peerId}@openai-gpt-56-sol`,
    peerSource: 'user',
    lastModel: `${peerId}@openai-gpt-56-sol`,
  });
  assert.equal(conversationPinnedServiceId(record), 'openai-gpt-56-sol');
  assert.equal(conversationPinnedPeerId(record), peerId);
  assert.equal(conversationRoutedPeerId(record), peerId);
});

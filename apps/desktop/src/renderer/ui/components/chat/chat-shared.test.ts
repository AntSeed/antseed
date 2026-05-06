import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssistantTurnContent,
  getAssistantTurnId,
  hasAssistantProcessContent,
  hasAssistantResponseContent,
  isAssistantProcessBlock,
  isAssistantResponseBlock,
  splitAssistantContentBlocks,
  splitAssistantMessageContent,
  summarizeAssistantProcess,
  type ChatMessage,
  type ContentBlock,
} from './chat-shared.js';

test('assistant content split separates response blocks from background process blocks', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'checking context' },
    { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'README.md' } },
    { type: 'text', text: 'Final answer' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' },
  ];

  const parts = splitAssistantContentBlocks(blocks);

  assert.deepEqual(parts.responseBlocks.map((block) => block.type), ['text', 'image']);
  assert.deepEqual(parts.processBlocks.map((block) => block.type), ['thinking', 'tool_use', 'tool_result']);
});

test('assistant turn content preserves original order while annotating response/process lanes', () => {
  const turn = buildAssistantTurnContent([
    { type: 'thinking', thinking: 'checking' },
    { type: 'text', text: 'First answer chunk' },
    { type: 'tool_use', id: 'tool-1', name: 'read' },
    { type: 'text', text: 'Second answer chunk' },
  ]);

  assert.deepEqual(turn.orderedParts.map((part) => part.kind), ['process', 'response', 'process', 'response']);
  assert.deepEqual(turn.orderedParts.map((part) => part.block.type), ['thinking', 'text', 'tool_use', 'text']);
  assert.deepEqual(turn.responseBlocks.map((block) => block.type), ['text', 'text']);
  assert.deepEqual(turn.processBlocks.map((block) => block.type), ['thinking', 'tool_use']);
});

test('assistant process block predicate is centralized for reasoning and tools', () => {
  assert.equal(isAssistantProcessBlock({ type: 'thinking', thinking: 'x' }), true);
  assert.equal(isAssistantProcessBlock({ type: 'tool_use', name: 'bash' }), true);
  assert.equal(isAssistantProcessBlock({ type: 'tool_result', content: 'ok' }), true);
  assert.equal(isAssistantProcessBlock({ type: 'text', text: 'answer' }), false);
  assert.equal(isAssistantResponseBlock({ type: 'text', text: 'answer' }), true);
});

test('unknown block types stay in the response path as a safe fallback', () => {
  const parts = splitAssistantContentBlocks([
    { type: 'custom_future_block', content: 'keep visible until intentionally routed' },
  ]);

  assert.deepEqual(parts.responseBlocks.map((block) => block.type), ['custom_future_block']);
  assert.deepEqual(parts.processBlocks, []);
});

test('string assistant content is treated as response content', () => {
  const parts = splitAssistantMessageContent({ role: 'assistant', content: 'plain response' });

  assert.deepEqual(parts.responseBlocks, [{ type: 'text', text: 'plain response' }]);
  assert.deepEqual(parts.processBlocks, []);
});

test('non-assistant messages never expose process blocks', () => {
  const message: ChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
    ],
  };

  const parts = splitAssistantMessageContent(message);

  assert.deepEqual(parts.responseBlocks.map((block) => block.type), ['text', 'tool_result']);
  assert.deepEqual(parts.processBlocks, []);
});

test('assistant content presence helpers report response and process availability', () => {
  const mixed: ChatMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'planning' },
      { type: 'text', text: 'done' },
    ],
  };
  const processOnly: ChatMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', name: 'grep' }],
  };

  assert.equal(hasAssistantResponseContent(mixed), true);
  assert.equal(hasAssistantProcessContent(mixed), true);
  assert.equal(hasAssistantResponseContent(processOnly), false);
  assert.equal(hasAssistantProcessContent(processOnly), true);
});

test('getAssistantTurnId prefers explicit id, then createdAt, then index', () => {
  const withId: ChatMessage = { role: 'assistant', content: [], id: 'abc' } as ChatMessage;
  const withTs: ChatMessage = { role: 'assistant', content: [], createdAt: 1234 };
  const bare: ChatMessage = { role: 'assistant', content: [] };

  assert.equal(getAssistantTurnId(withId, 5), 'id:abc');
  assert.equal(getAssistantTurnId(withTs, 5), 'ts:1234');
  assert.equal(getAssistantTurnId(bare, 7), 'idx:7');
});

test('summarizeAssistantProcess tallies counts plus running/error states', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'plan', streaming: true },
    { type: 'tool_use', id: 't1', name: 'bash', status: 'running' },
    { type: 'tool_use', id: 't2', name: 'grep', status: 'success' },
    { type: 'tool_use', id: 't3', name: 'edit', status: 'error' },
    { type: 'tool_result', tool_use_id: 't9', content: 'oops', is_error: true },
  ];

  const summary = summarizeAssistantProcess(blocks);

  assert.equal(summary.thinking, 1);
  assert.equal(summary.toolUse, 3);
  assert.equal(summary.toolResult, 1);
  assert.equal(summary.running, 2);
  assert.equal(summary.errors, 2);
  assert.equal(summary.total, 5);
});

test('summarizeAssistantProcess returns zeroed summary for empty input', () => {
  const summary = summarizeAssistantProcess([]);
  assert.deepEqual(summary, { thinking: 0, toolUse: 0, toolResult: 0, running: 0, errors: 0, total: 0 });
});

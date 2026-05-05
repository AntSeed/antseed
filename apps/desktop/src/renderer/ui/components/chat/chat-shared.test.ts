import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssistantTurnContent,
  hasAssistantProcessContent,
  hasAssistantResponseContent,
  isAssistantProcessBlock,
  isAssistantResponseBlock,
  splitAssistantContentBlocks,
  splitAssistantMessageContent,
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

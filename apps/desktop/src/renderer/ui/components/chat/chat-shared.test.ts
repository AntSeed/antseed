import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssistantTurnContent,
  classifyFileAction,
  countDiffStats,
  extractToolDiff,
  extractToolFilePath,
  getAssistantTurnId,
  groupAssistantActivity,
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

test('classifyFileAction maps known tool names to file action kinds', () => {
  assert.equal(classifyFileAction('read_file'), 'read');
  assert.equal(classifyFileAction('view'), 'read');
  assert.equal(classifyFileAction('write_file'), 'write');
  assert.equal(classifyFileAction('edit'), 'edit');
  assert.equal(classifyFileAction('str_replace_editor'), 'edit');
  assert.equal(classifyFileAction('list_directory'), 'list');
  assert.equal(classifyFileAction('bash'), null);
  assert.equal(classifyFileAction(''), null);
  assert.equal(classifyFileAction(undefined), null);
});

test('extractToolFilePath pulls the most likely path key from tool input', () => {
  assert.equal(extractToolFilePath('read_file', { path: 'README.md' }), 'README.md');
  assert.equal(extractToolFilePath('write_file', { filePath: 'src/x.ts' }), 'src/x.ts');
  assert.equal(extractToolFilePath('edit', { file: 'a.ts', other: 'noise' }), 'a.ts');
  assert.equal(extractToolFilePath('list_directory', { directory: 'src' }), 'src');
  assert.equal(extractToolFilePath('read_file', {}), '');
  assert.equal(extractToolFilePath('read_file', null), '');
});

test('extractToolDiff prefers details.diff and falls back to unified diff in content', () => {
  assert.equal(extractToolDiff({ type: 'tool_use', details: { diff: 'D' } }), 'D');
  const inlineDiff = '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(extractToolDiff({ type: 'tool_use', content: inlineDiff }), inlineDiff);
  assert.equal(extractToolDiff({ type: 'tool_use', content: 'plain output' }), '');
});

test('countDiffStats counts +/- lines but ignores file header lines', () => {
  const diff = '--- a.ts\n+++ b.ts\n@@ -1,2 +1,3 @@\n-old\n+new1\n+new2\n unchanged\n';
  assert.deepEqual(countDiffStats(diff), { additions: 2, removals: 1 });
  assert.deepEqual(countDiffStats(''), { additions: 0, removals: 0 });
});

test('groupAssistantActivity projects process blocks into Plan/Actions/Files/Results', () => {
  const blocks: ContentBlock[] = [
    { type: 'thinking', thinking: 'plan A' },
    { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'README.md' }, status: 'success', content: 'hello' },
    { type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'ls' }, status: 'success', content: 'a\nb' },
    { type: 'tool_use', id: 'e1', name: 'edit', input: { path: 'src/x.ts' }, status: 'error', content: 'boom' },
    { type: 'tool_use', id: 'r2', name: 'read_file', input: { path: 'README.md' }, status: 'success', content: 'hello v2' },
    { type: 'tool_result', tool_use_id: 'b1', name: 'bash', is_error: true, content: 'detached error' },
  ];

  const grouped = groupAssistantActivity(blocks);

  assert.equal(grouped.plan.length, 1);
  assert.equal(grouped.plan[0].text, 'plan A');

  assert.equal(grouped.actions.length, 4);
  assert.deepEqual(grouped.actions.map((a) => a.toolName), ['read_file', 'bash', 'edit', 'read_file']);

  // Files dedup by path; later read_file wins for README.md.
  assert.equal(grouped.files.length, 2);
  const readme = grouped.files.find((f) => f.path === 'README.md');
  assert.ok(readme);
  assert.equal(readme!.id, 'r2');
  assert.equal(readme!.kind, 'read');
  const edited = grouped.files.find((f) => f.path === 'src/x.ts');
  assert.ok(edited);
  assert.equal(edited!.kind, 'edit');
  assert.equal(edited!.status, 'error');

  // Results = errored tool_use entries + standalone is_error tool_result.
  assert.equal(grouped.results.length, 2);
  assert.deepEqual(grouped.results.map((r) => r.id), ['e1', 'b1']);
});

test('groupAssistantActivity returns empty groups for empty input', () => {
  const grouped = groupAssistantActivity([]);
  assert.deepEqual(grouped, { plan: [], actions: [], files: [], results: [] });
});

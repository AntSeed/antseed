import test from 'node:test';
import assert from 'node:assert/strict';

import { ANTSTATION_SYSTEM_PROMPT, buildAntstationSystemPrompt } from './chat-system-prompt.js';

test('prompt has AntStation identity, not pi', () => {
  const prompt = buildAntstationSystemPrompt(undefined);
  assert.ok(prompt.includes('AntStation'));
  assert.ok(!prompt.includes('operating inside pi'));
});

test('prompt lists all built-in and custom tools', () => {
  const prompt = buildAntstationSystemPrompt(undefined);
  for (const tool of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
    'web_fetch', 'open_browser_preview', 'start_dev_server']) {
    assert.ok(prompt.includes(`- ${tool}:`), `missing tool "${tool}"`);
  }
});

test('prompt uses pi section names', () => {
  const prompt = buildAntstationSystemPrompt(undefined);
  assert.ok(prompt.includes('Available tools:'));
  assert.ok(prompt.includes('Guidelines:'));
});

test('guidelines include key tool rules', () => {
  const prompt = buildAntstationSystemPrompt(undefined);
  assert.ok(/never.*bash.*dev server/i.test(prompt));
  assert.ok(prompt.includes('web_fetch'));
  assert.ok(prompt.includes('edits[].oldText must match exactly'));
});

test('no pi documentation section', () => {
  const prompt = buildAntstationSystemPrompt(undefined);
  assert.ok(!prompt.includes('Pi documentation'));
});

test('custom base prompt overrides default', () => {
  const custom = 'You are a helpful assistant.';
  const prompt = buildAntstationSystemPrompt(custom);
  assert.ok(prompt.includes(custom));
  assert.ok(!prompt.includes(ANTSTATION_SYSTEM_PROMPT));
});

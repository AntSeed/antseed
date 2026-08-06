import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveBrandKey } from './BrandIcon.js';

test('model family wins over the transport provider slug', () => {
  // Sellers advertise models over a protocol whose provider slug ("openai",
  // "anthropic") says nothing about the model's own brand.
  assert.equal(resolveBrandKey('openai', 'Kimi K3'), 'kimi');
  assert.equal(resolveBrandKey('openai', 'GLM 5.2'), 'glm');
  assert.equal(resolveBrandKey('openai', 'DeepSeek V4'), 'deepseek');
  assert.equal(resolveBrandKey('openai', 'Qwen 3.5'), 'qwen');
  assert.equal(resolveBrandKey('openai', 'Gemini 3 Pro'), 'gemini');
  assert.equal(resolveBrandKey('openai', 'Grok 4.5'), 'grok');
  assert.equal(resolveBrandKey('openai', 'Mistral Large'), 'mistral');
  assert.equal(resolveBrandKey('openai', 'Llama 4'), 'llama');
  assert.equal(resolveBrandKey('anthropic', 'Kimi K3'), 'kimi');
});

test('vendor slugs still resolve their own models', () => {
  assert.equal(resolveBrandKey('anthropic', 'Claude Fable 5'), 'anthropic');
  assert.equal(resolveBrandKey('openai', 'GPT 5.6 Luna'), 'openai');
  assert.equal(resolveBrandKey('openai', 'gpt-5.6-sol'), 'openai');
});

test('unknown identifiers fall back to the generic mark', () => {
  assert.equal(resolveBrandKey('acme', 'mystery-model'), 'generic');
  assert.equal(resolveBrandKey(), 'generic');
});

test('connected-app tool names resolve their marks', () => {
  assert.equal(resolveBrandKey('crush', 'Crush'), 'crush');
  assert.equal(resolveBrandKey('goose', 'Goose'), 'goose');
  assert.equal(resolveBrandKey('zed', 'Zed'), 'zed');
  assert.equal(resolveBrandKey('codex', 'Codex'), 'codex');
  assert.equal(resolveBrandKey('pi', 'pi'), 'pi');
  // Standalone-word guards: no false hits inside other identifiers.
  assert.equal(resolveBrandKey('amazed-tool', 'thing'), 'generic');
  assert.equal(resolveBrandKey('pixel-model', 'thing'), 'generic');
});

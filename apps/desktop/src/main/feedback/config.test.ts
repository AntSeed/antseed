import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseTelegramChatId,
  resolveFeedbackTelegramConfig,
} from './config.js';

const validToken = ['123456789', 'abcdefghijklmnopqrstuvwxyz_ABCDEF'].join(':');

test('reports missing source-build configuration', () => {
  assert.deepEqual(resolveFeedbackTelegramConfig({}, { botToken: null, chatId: null }), {
    configured: false,
    error: 'Feedback is unavailable in this build.',
  });
});

test('resolves a valid runtime Telegram feedback configuration', () => {
  const result = resolveFeedbackTelegramConfig({
    ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN: validToken,
    ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID: '@antseed_feedback',
  });
  assert.equal(result.configured, true);
  if (result.configured) {
    assert.equal(result.config.botToken, validToken);
    assert.equal(result.config.chatId, '@antseed_feedback');
  }
});

test('uses baked configuration unless runtime values override it', () => {
  const baked = { botToken: validToken, chatId: '@baked_feedback' };
  const bakedResult = resolveFeedbackTelegramConfig({}, baked);
  assert.equal(bakedResult.configured, true);
  if (bakedResult.configured) assert.equal(bakedResult.config.chatId, '@baked_feedback');

  const runtimeResult = resolveFeedbackTelegramConfig({
    ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN: validToken,
    ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID: '@runtime_feedback',
  }, baked);
  assert.equal(runtimeResult.configured, true);
  if (runtimeResult.configured) assert.equal(runtimeResult.config.chatId, '@runtime_feedback');
});

test('runtime override requires both values and can disable baked defaults', () => {
  const baked = { botToken: validToken, chatId: '@baked_feedback' };
  const incomplete = resolveFeedbackTelegramConfig({
    ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN: validToken,
  }, baked);
  assert.equal(incomplete.configured, false);

  const disabled = resolveFeedbackTelegramConfig({
    ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN: '',
    ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID: '',
  }, baked);
  assert.deepEqual(disabled, { configured: false, error: 'Feedback is unavailable in this build.' });
});

test('rejects invalid tokens and parses numeric and public-channel chat identifiers', () => {
  const invalidToken = resolveFeedbackTelegramConfig({
    ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN: 'not-a-token',
    ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID: '@antseed_feedback',
  });
  assert.deepEqual(invalidToken, {
    configured: false,
    error: 'Telegram feedback bot configuration is invalid.',
  });
  assert.equal(parseTelegramChatId('-1001234567890'), -1001234567890);
  assert.equal(parseTelegramChatId('@antseed_feedback'), '@antseed_feedback');
  assert.equal(parseTelegramChatId('not a chat'), null);
});

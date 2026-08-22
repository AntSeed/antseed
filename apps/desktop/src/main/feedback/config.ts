import {
  BAKED_FEEDBACK_TELEGRAM_BOT_TOKEN,
  BAKED_FEEDBACK_TELEGRAM_CHAT_ID,
} from '../generated/baked-defaults.js';

export const FEEDBACK_TELEGRAM_BOT_TOKEN_ENV = 'ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN';
export const FEEDBACK_TELEGRAM_CHAT_ID_ENV = 'ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID';

export type FeedbackTelegramConfig = {
  botToken: string;
  chatId: number | string;
};

export type FeedbackTelegramConfigResolution =
  | { configured: true; config: FeedbackTelegramConfig }
  | { configured: false; error: string };

type FeedbackTelegramBakedDefaults = {
  botToken: string | null;
  chatId: string | null;
};

export function isValidTelegramBotToken(value: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(value);
}

export function parseTelegramChatId(value: string): number | string | null {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export function resolveFeedbackTelegramConfig(
  env: NodeJS.ProcessEnv = process.env,
  baked: FeedbackTelegramBakedDefaults = {
    botToken: BAKED_FEEDBACK_TELEGRAM_BOT_TOKEN,
    chatId: BAKED_FEEDBACK_TELEGRAM_CHAT_ID,
  },
): FeedbackTelegramConfigResolution {
  const hasRuntimeOverride =
    Object.prototype.hasOwnProperty.call(env, FEEDBACK_TELEGRAM_BOT_TOKEN_ENV)
    || Object.prototype.hasOwnProperty.call(env, FEEDBACK_TELEGRAM_CHAT_ID_ENV);
  const botToken = (
    hasRuntimeOverride
      ? env[FEEDBACK_TELEGRAM_BOT_TOKEN_ENV]
      : baked.botToken
  )?.trim() ?? '';
  const rawChatId = (
    hasRuntimeOverride
      ? env[FEEDBACK_TELEGRAM_CHAT_ID_ENV]
      : baked.chatId
  )?.trim() ?? '';

  if (!botToken && !rawChatId) {
    return { configured: false, error: 'Feedback is unavailable in this build.' };
  }
  if (!botToken || !rawChatId) {
    return { configured: false, error: 'Telegram feedback configuration is incomplete.' };
  }
  if (!isValidTelegramBotToken(botToken)) {
    return { configured: false, error: 'Telegram feedback bot configuration is invalid.' };
  }
  const chatId = parseTelegramChatId(rawChatId);
  if (chatId === null) {
    return { configured: false, error: 'Telegram feedback channel configuration is invalid.' };
  }
  return { configured: true, config: { botToken, chatId } };
}

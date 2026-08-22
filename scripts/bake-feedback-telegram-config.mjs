#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_ENV = 'ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN';
const CHAT_ID_ENV = 'ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetArgIndex = process.argv.indexOf('--target');
const target = targetArgIndex >= 0 && process.argv[targetArgIndex + 1]
  ? resolve(process.argv[targetArgIndex + 1])
  : join(root, 'apps/desktop/src/main/generated/baked-defaults.ts');

function readEnvFileValue(filePath, key) {
  if (!existsSync(filePath)) return undefined;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match?.[1] === key) return match[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

function configuredValue(key) {
  return (
    process.env[key]
    ?? readEnvFileValue(join(root, '.env.local'), key)
    ?? readEnvFileValue(join(root, '.env'), key)
    ?? ''
  ).trim();
}

const botToken = configuredValue(TOKEN_ENV);
const chatId = configuredValue(CHAT_ID_ENV);
const required = process.argv.includes('--require');

if (!botToken && !chatId) {
  const message = 'Telegram feedback credentials are not set; baked feedback remains disabled.';
  if (required) {
    console.error(`bake-feedback-telegram-config: ${message}`);
    process.exit(1);
  }
  console.log(`bake-feedback-telegram-config: ${message}`);
  process.exit(0);
}

if (!botToken || !chatId) {
  console.error(`bake-feedback-telegram-config: ${TOKEN_ENV} and ${CHAT_ID_ENV} must both be set.`);
  process.exit(1);
}
if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
  console.error(`bake-feedback-telegram-config: ${TOKEN_ENV} is invalid.`);
  process.exit(1);
}
if (!/^(?:-?\d+|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chatId)) {
  console.error(`bake-feedback-telegram-config: ${CHAT_ID_ENV} is invalid.`);
  process.exit(1);
}

let source = readFileSync(target, 'utf8');
source = source.replace(
  /export const BAKED_FEEDBACK_TELEGRAM_BOT_TOKEN: string \| null = .*;/,
  `export const BAKED_FEEDBACK_TELEGRAM_BOT_TOKEN: string | null = ${JSON.stringify(botToken)};`,
);
source = source.replace(
  /export const BAKED_FEEDBACK_TELEGRAM_CHAT_ID: string \| null = .*;/,
  `export const BAKED_FEEDBACK_TELEGRAM_CHAT_ID: string | null = ${JSON.stringify(chatId)};`,
);
if (!source.includes(JSON.stringify(botToken)) || !source.includes(JSON.stringify(chatId))) {
  console.error('bake-feedback-telegram-config: generated defaults exports were not found.');
  process.exit(1);
}
writeFileSync(target, source);
console.log('bake-feedback-telegram-config: baked Telegram feedback configuration.');

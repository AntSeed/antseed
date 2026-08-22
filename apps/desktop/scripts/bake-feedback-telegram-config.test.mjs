import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'bake-feedback-telegram-config.mjs');

test('bakes Telegram feedback credentials without printing the token', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'antseed-feedback-bake-'));
  const target = join(tempDir, 'baked-defaults.ts');
  const token = ['123456789', 'abcdefghijklmnopqrstuvwxyz_ABCDEF'].join(':');
  writeFileSync(target, [
    'export const BAKED_FEEDBACK_TELEGRAM_BOT_TOKEN: string | null = null;',
    'export const BAKED_FEEDBACK_TELEGRAM_CHAT_ID: string | null = null;',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [script, '--require', '--target', target], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN: token,
      ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID: '@antseed_feedback',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
  const baked = readFileSync(target, 'utf8');
  assert.match(baked, new RegExp(token));
  assert.match(baked, /@antseed_feedback/);
});

test('required mode rejects incomplete configuration', () => {
  const result = spawnSync(process.execPath, [script, '--require'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ANTSEED_FEEDBACK_TELEGRAM_BOT_TOKEN: ['123456789', 'abcdefghijklmnopqrstuvwxyz_ABCDEF'].join(':'),
      ANTSEED_FEEDBACK_TELEGRAM_CHAT_ID: '',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must both be set/);
});

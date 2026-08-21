import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LogEvent } from '../runtime/log-parser.js';
import { buildFeedbackDiagnosticLog } from './diagnostic-log.js';

function log(line: string, timestamp = 1_700_000_000_000): LogEvent {
  return { mode: 'connect', stream: 'system', line, timestamp };
}

test('privacy-redacts sensitive diagnostic values with stable placeholders', () => {
  const peerId = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const botToken = ['123456789', 'abcdefghijklmnopqrstuvwxyz_ABCDEF'].join(':');
  const webhook = ['https://discord.com/api/webhooks', '123456789', 'webhook-secret-value'].join('/');
  const output = new TextDecoder().decode(buildFeedbackDiagnosticLog([
    log(`token=${botToken} authorization=Basic-sensitive webhook=${webhook} email=user@example.com`),
    log(`home=/Users/alex/project ip=192.168.1.10 wallet=0x${'a'.repeat(40)} peer=${peerId}`),
    log('again user@example.com and 192.168.1.10'),
  ]));

  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz_ABCDEF/);
  assert.doesNotMatch(output, /user@example\.com/);
  assert.doesNotMatch(output, /webhook-secret-value|Basic-sensitive/);
  assert.doesNotMatch(output, /\/Users\/alex/);
  assert.doesNotMatch(output, /192\.168\.1\.10/);
  assert.doesNotMatch(output, new RegExp(peerId));
  assert.equal(output.match(/<EMAIL_1>/g)?.length, 2);
  assert.equal(output.match(/<IP_1>/g)?.length, 2);
  assert.match(output, /<WALLET_1>/);
  assert.match(output, /<PEER_1>/);
  assert.match(output, /<WEBHOOK_1>/);
  assert.match(output, /<SECRET_2>/);
});

test('retains only the newest 500 runtime entries', () => {
  const logs = Array.from({ length: 501 }, (_value, index) => log(`entry-${index}`, index));
  const output = new TextDecoder().decode(buildFeedbackDiagnosticLog(logs));
  assert.doesNotMatch(output, /entry-0(?:\D|$)/);
  assert.match(output, /entry-1(?:\D|$)/);
  assert.match(output, /entry-500(?:\D|$)/);
});

test('keeps the newest entries within the byte budget', () => {
  const output = new TextDecoder().decode(buildFeedbackDiagnosticLog([
    log(`old-${'x'.repeat(100)}`, 1),
    log(`middle-${'y'.repeat(100)}`, 2),
    log('newest-entry', 3),
  ], 260));
  assert.ok(Buffer.byteLength(output, 'utf8') <= 260);
  assert.match(output, /newest-entry/);
  assert.doesNotMatch(output, /old-/);
  assert.match(output, /earlier log entries omitted/);
});

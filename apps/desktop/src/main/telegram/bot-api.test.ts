import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createTelegramBotClient } from './bot-api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function telegramMessage(messageId: number) {
  return { message_id: messageId, chat: { id: -1001, type: 'channel' }, date: 1 };
}

test('sends a media group and diagnostic document as multipart replies', async () => {
  const calls: Array<{ url: string; body: FormData }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body as FormData });
    const result = String(url).endsWith('/sendMediaGroup')
      ? [telegramMessage(2), telegramMessage(3)]
      : telegramMessage(4);
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = createTelegramBotClient(['123456789', 'abcdefghijklmnopqrstuvwxyz_ABCDEF'].join(':'));
  const uploads = [
    { data: new Uint8Array([1]), filename: 'one.png', mimeType: 'image/png' },
    { data: new Uint8Array([2]), filename: 'two.png', mimeType: 'image/png' },
  ];
  await client.sendMediaGroup('@feedback', uploads, { caption: 'Feedback ABC', replyToMessageId: 1 });
  await client.sendDocument('@feedback', {
    data: new TextEncoder().encode('logs'),
    filename: 'logs.txt',
    mimeType: 'text/plain',
  }, { replyToMessageId: 1 });

  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /sendMediaGroup$/);
  assert.equal(calls[0]!.body.get('chat_id'), '@feedback');
  assert.equal(calls[0]!.body.get('reply_parameters'), JSON.stringify({ message_id: 1 }));
  assert.match(String(calls[0]!.body.get('media')), /attach:\/\/photo0/);
  assert.ok(calls[0]!.body.get('photo0') instanceof Blob);
  assert.match(calls[1]!.url, /sendDocument$/);
  assert.ok(calls[1]!.body.get('document') instanceof Blob);
});

test('sends one image as a multipart reply', async () => {
  const calls: Array<{ url: string; body: FormData }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body as FormData });
    return new Response(JSON.stringify({ ok: true, result: telegramMessage(2) }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = createTelegramBotClient(['123456789', 'abcdefghijklmnopqrstuvwxyz_ABCDEF'].join(':'));
  await client.sendPhoto('@feedback', {
    data: new Uint8Array([1]),
    filename: 'one.webp',
    mimeType: 'image/webp',
  }, { caption: 'Feedback ABC', replyToMessageId: 1 });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /sendPhoto$/);
  assert.equal(calls[0]!.body.get('reply_parameters'), JSON.stringify({ message_id: 1 }));
  assert.ok(calls[0]!.body.get('photo') instanceof Blob);
});

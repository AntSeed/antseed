import test from 'node:test';
import assert from 'node:assert/strict';

import { transcribeWithWhisper } from './speech-to-text.js';

function audioDataUrl(mimeType = 'audio/webm', content = 'hello audio'): string {
  return `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`;
}

test('transcribeWithWhisper requires an API key', async () => {
  const result = await transcribeWithWhisper(
    { dataUrl: audioDataUrl() },
    { apiKeyEnvName: 'OPENAI_API_KEY' },
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /OPENAI_API_KEY/);
});

test('transcribeWithWhisper posts audio to Whisper and returns transcript', async () => {
  let observedUrl = '';
  let observedAuthorization = '';
  let observedModel: unknown = null;
  let observedFile: unknown = null;

  const result = await transcribeWithWhisper(
    { dataUrl: audioDataUrl('audio/webm;codecs=opus') },
    {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.example/v1/',
      fetchImpl: async (url, init) => {
        observedUrl = url;
        observedAuthorization = init.headers['Authorization'] ?? '';
        observedModel = init.body.get('model');
        observedFile = init.body.get('file');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ text: '  ship it professionally  ' }),
        };
      },
    },
  );

  assert.deepEqual(result, { ok: true, text: 'ship it professionally' });
  assert.equal(observedUrl, 'https://api.openai.example/v1/audio/transcriptions');
  assert.equal(observedAuthorization, 'Bearer sk-test');
  assert.equal(observedModel, 'whisper-1');
  assert.ok(observedFile instanceof Blob);
});

test('transcribeWithWhisper rejects unsupported audio formats', async () => {
  const result = await transcribeWithWhisper(
    { dataUrl: audioDataUrl('text/plain') },
    { apiKey: 'sk-test' },
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported audio format/);
});

test('transcribeWithWhisper surfaces Whisper API errors', async () => {
  const result = await transcribeWithWhisper(
    { dataUrl: audioDataUrl() },
    {
      apiKey: 'sk-test',
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'bad key' } }),
      }),
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /401/);
  assert.match(result.error, /bad key/);
});

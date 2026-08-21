import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { FeedbackSubmitRequest } from '../../shared/feedback.js';
import { formatFeedbackMessage, submitTelegramFeedback, validateFeedbackRequest } from './service.js';

const originalFetch = globalThis.fetch;
const config = {
  botToken: ['123456789', 'abcdefghijklmnopqrstuvwxyz_ABCDEF'].join(':'),
  chatId: '@antseed_feedback',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(overrides: Partial<FeedbackSubmitRequest> = {}): FeedbackSubmitRequest {
  return {
    feedback: 'The app is useful.',
    contactEmail: 'user@example.com',
    images: [],
    includeDiagnosticLogs: false,
    ...overrides,
  };
}

test('validates feedback and attachment limits', () => {
  assert.throws(() => validateFeedbackRequest(request({ feedback: ' ' })), /enter some feedback/i);
  assert.throws(() => validateFeedbackRequest(request({ feedback: 'x'.repeat(3_001) })), /3,000 characters/i);
  assert.throws(() => validateFeedbackRequest(request({ contactEmail: 'invalid' })), /valid contact email/i);
  assert.throws(() => validateFeedbackRequest(request({
    images: Array.from({ length: 11 }, (_value, index) => ({
      name: `${index}.png`,
      mimeType: 'image/png',
      size: 1,
      dataBase64: 'YQ==',
    })),
  })), /no more than 10 images/i);
  assert.doesNotThrow(() => validateFeedbackRequest(request()));
});

test('formats one plain root message with app metadata', () => {
  const content = formatFeedbackMessage({
    feedbackId: 'ABC12345',
    feedback: 'Great routing.',
    contactEmail: '',
    appVersion: '0.2.27',
    platform: 'darwin arm64',
    imageCount: 2,
    diagnosticStatus: 'included',
  });
  assert.match(content, /^AntSeed Feedback · ABC12345/);
  assert.match(content, /AntSeed VPR: 0\.2\.27/);
  assert.match(content, /Diagnostic logs: included \(privacy-redacted\)/);

  const maximumContent = formatFeedbackMessage({
    feedbackId: 'ABC12345',
    feedback: 'x'.repeat(3_000),
    contactEmail: `${'a'.repeat(242)}@example.com`,
    appVersion: '0.2.27',
    platform: 'darwin arm64 25.0.0',
    imageCount: 10,
    diagnosticStatus: 'included',
  });
  assert.ok(maximumContent.length <= 4_096);
});

test('returns partial success when Telegram accepts text but rejects an image', async () => {
  const methods: string[] = [];
  globalThis.fetch = async (url) => {
    const method = String(url).split('/').pop()!;
    methods.push(method);
    if (method === 'sendPhoto') {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad photo' }), { status: 400 });
    }
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: 77, chat: { id: -1001, type: 'channel' }, date: 1 },
    }));
  };

  const result = await submitTelegramFeedback({
    config,
    request: request({
      images: [{
        name: 'image.png',
        mimeType: 'image/png',
        size: 3,
        dataBase64: Buffer.from('abc').toString('base64'),
      }],
      includeDiagnosticLogs: true,
    }),
    logs: [{ mode: 'connect', stream: 'system', line: 'ready', timestamp: 1 }],
    appVersion: '0.2.27',
  });

  assert.equal(result.ok, true);
  assert.match(result.attachmentWarnings?.join(' ') ?? '', /image attachments/);
  assert.deepEqual(methods, ['sendMessage', 'sendPhoto', 'sendDocument']);
});

test('retains failure semantics when the root message is rejected', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error_code: 401,
    description: 'Unauthorized',
  }), { status: 401 });
  const result = await submitTelegramFeedback({
    config,
    request: request(),
    logs: [],
    appVersion: '0.2.27',
  });
  assert.deepEqual(result, { ok: false, error: 'Unable to send feedback. Please try again.' });
});

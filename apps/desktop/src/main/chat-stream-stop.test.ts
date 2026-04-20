import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyChatStreamFailure, formatChatStreamStopForLog } from './chat-stream-stop.js';

test('classifyChatStreamFailure detects retryable upstream 502 failures', () => {
  const reason = classifyChatStreamFailure({
    error: new Error('Upstream request failed with status 502 Bad Gateway'),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 502);
  assert.equal(reason.retryable, true);
});

test('classifyChatStreamFailure detects timeout failures', () => {
  const reason = classifyChatStreamFailure({
    error: { message: 'headers timeout', code: 'UND_ERR_HEADERS_TIMEOUT' },
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'timeout');
  assert.equal(reason.errorCode, 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal(reason.retryable, true);
});

test('classifyChatStreamFailure detects transport disconnects', () => {
  const reason = classifyChatStreamFailure({
    error: { message: 'socket hang up', code: 'ECONNRESET' },
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'network_error');
  assert.equal(reason.errorCode, 'ECONNRESET');
  assert.equal(reason.retryable, true);
});

test('classifyChatStreamFailure preserves explicit aborts', () => {
  const reason = classifyChatStreamFailure({
    error: new Error('The operation was aborted'),
    stopReason: 'aborted',
  });

  assert.equal(reason.kind, 'aborted');
  assert.equal(reason.retryable, false);
});

test('classifyChatStreamFailure does not treat transport-side aborts as user aborts', () => {
  // "Connection aborted by remote" should be a retryable transport failure,
  // not a user-initiated abort.
  const reason = classifyChatStreamFailure({
    error: { message: 'Connection aborted by remote', code: 'ECONNRESET' },
    stopReason: 'error',
  });

  assert.notEqual(reason.kind, 'aborted');
  assert.equal(reason.kind, 'network_error');
  assert.equal(reason.source, 'transport');
  assert.equal(reason.retryable, true);
});

test('classifyChatStreamFailure does not leak HTTP response body into user-facing message', () => {
  const reason = classifyChatStreamFailure({
    error: {
      message: 'Upstream request failed',
      status: 500,
      body: 'sk-secret-token-LEAKED and internal stack trace',
    },
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 500);
  assert.ok(
    !reason.message.includes('sk-secret-token-LEAKED'),
    `expected body content not to leak into message, got: ${reason.message}`,
  );
});

test('parseStatusCodeFromText does not treat bare leading digits as HTTP status codes', () => {
  // Previously "128 tokens remaining" would be parsed as HTTP 128 by a bare
  // /^\s*(\d{3})\b/ heuristic. The regex was removed in favour of patterns
  // that require an HTTP-shaped context ("status 502", "HTTP 502", etc.).
  const reason = classifyChatStreamFailure({
    error: new Error('128 tokens remaining before limit'),
    stopReason: 'error',
  });

  assert.notEqual(reason.kind, 'http_error');
  assert.equal(reason.statusCode, undefined);
});

test('classifyChatStreamFailure falls back to stream_error when stopReason is error', () => {
  const reason = classifyChatStreamFailure({
    error: new Error('Something weird happened upstream'),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'stream_error');
  assert.equal(reason.source, 'upstream');
  assert.equal(reason.retryable, false);
  assert.ok(reason.message.includes('Something weird happened upstream'));
});

test('classifyChatStreamFailure falls back to unknown when no signals match', () => {
  const reason = classifyChatStreamFailure({});

  assert.equal(reason.kind, 'unknown');
  assert.equal(reason.source, 'unknown');
  assert.equal(reason.retryable, false);
});

test('classifyChatStreamFailure recurses through `cause` chains', () => {
  // Plain objects avoid Error.name='Error' being collected as an errorCode.
  const outer = {
    message: 'wrapper',
    cause: {
      message: 'fetch failed',
      cause: { message: 'socket hang up', code: 'ECONNRESET' },
    },
  };

  const reason = classifyChatStreamFailure({ error: outer, stopReason: 'error' });

  assert.equal(reason.kind, 'network_error');
  assert.equal(reason.errorCode, 'ECONNRESET');
  assert.equal(reason.retryable, true);
});

test('formatChatStreamStopForLog includes kind, status, code, and retryability', () => {
  const out = formatChatStreamStopForLog({
    kind: 'http_error',
    source: 'upstream',
    retryable: true,
    message: 'nope',
    statusCode: 502,
    errorCode: 'ERR_UPSTREAM',
  });

  assert.match(out, /http_error/);
  assert.match(out, /status=502/);
  assert.match(out, /code=ERR_UPSTREAM/);
  assert.match(out, /retryable/);
  assert.match(out, /: nope$/);
});

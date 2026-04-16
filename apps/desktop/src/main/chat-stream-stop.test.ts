import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyChatStreamFailure } from './chat-stream-stop.js';

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

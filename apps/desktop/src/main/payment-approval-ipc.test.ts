import test from 'node:test';
import assert from 'node:assert/strict';

// ── Payment approval JSON protocol tests ──
// The CLI and desktop communicate via structured JSON lines on stdout/stdin.
// These tests verify the JSON protocol without spawning real processes.

const APPROVAL_REQUEST_KEY = '__antseed_payment_approval_request';
const APPROVAL_RESPONSE_KEY = '__antseed_payment_approval_response';

function isPaymentApprovalRequest(line: string): Record<string, unknown> | null {
  if (!line.includes(APPROVAL_REQUEST_KEY)) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const request = parsed[APPROVAL_REQUEST_KEY];
    if (request && typeof request === 'object' && !Array.isArray(request)) {
      return request as Record<string, unknown>;
    }
  } catch { /* not JSON */ }
  return null;
}

function buildApprovalResponse(approved: boolean): string {
  return JSON.stringify({ [APPROVAL_RESPONSE_KEY]: { approved } });
}

function parseApprovalResponse(line: string): { approved: boolean } | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const response = parsed[APPROVAL_RESPONSE_KEY] as { approved: boolean } | undefined;
    if (response && typeof response.approved === 'boolean') {
      return { approved: response.approved };
    }
  } catch { /* not JSON */ }
  return null;
}

// ── Request detection ──

test('isPaymentApprovalRequest parses valid request', () => {
  const info = {
    peerId: 'abc123',
    sellerEvmAddr: '0x' + 'ab'.repeat(20),
    suggestedAmount: '1000000',
    firstSignCap: '1000000',
    tokenRate: '500',
    buyerAvailableUsdc: '5000000',
    isFirstSign: true,
    cooldownRemainingSecs: 0,
  };
  const line = JSON.stringify({ [APPROVAL_REQUEST_KEY]: info });
  const result = isPaymentApprovalRequest(line);
  assert.notEqual(result, null);
  assert.equal(result!.peerId, 'abc123');
  assert.equal(result!.sellerEvmAddr, '0x' + 'ab'.repeat(20));
  assert.equal(result!.suggestedAmount, '1000000');
  assert.equal(result!.isFirstSign, true);
});

test('isPaymentApprovalRequest returns null for normal log lines', () => {
  assert.equal(isPaymentApprovalRequest('[proxy] GET /v1/messages'), null);
  assert.equal(isPaymentApprovalRequest('Connected to P2P network'), null);
  assert.equal(isPaymentApprovalRequest(''), null);
  assert.equal(isPaymentApprovalRequest('{}'), null);
});

test('isPaymentApprovalRequest returns null for malformed JSON', () => {
  assert.equal(isPaymentApprovalRequest('{not json}'), null);
  assert.equal(isPaymentApprovalRequest('{"__antseed_payment_approval_request": "not-object"}'), null);
  assert.equal(isPaymentApprovalRequest('{"__antseed_payment_approval_request": null}'), null);
});

test('isPaymentApprovalRequest returns null for array value', () => {
  assert.equal(isPaymentApprovalRequest('{"__antseed_payment_approval_request": [1,2,3]}'), null);
});

// ── Response building ──

test('buildApprovalResponse creates approved response', () => {
  const response = buildApprovalResponse(true);
  const parsed = JSON.parse(response) as Record<string, unknown>;
  const inner = parsed[APPROVAL_RESPONSE_KEY] as { approved: boolean };
  assert.equal(inner.approved, true);
});

test('buildApprovalResponse creates rejected response', () => {
  const response = buildApprovalResponse(false);
  const parsed = JSON.parse(response) as Record<string, unknown>;
  const inner = parsed[APPROVAL_RESPONSE_KEY] as { approved: boolean };
  assert.equal(inner.approved, false);
});

// ── Response parsing ──

test('parseApprovalResponse parses approved response', () => {
  const line = buildApprovalResponse(true);
  const result = parseApprovalResponse(line);
  assert.deepEqual(result, { approved: true });
});

test('parseApprovalResponse parses rejected response', () => {
  const line = buildApprovalResponse(false);
  const result = parseApprovalResponse(line);
  assert.deepEqual(result, { approved: false });
});

test('parseApprovalResponse returns null for non-response', () => {
  assert.equal(parseApprovalResponse('hello'), null);
  assert.equal(parseApprovalResponse('{}'), null);
  assert.equal(parseApprovalResponse('{"other": true}'), null);
});

test('parseApprovalResponse rejects missing approved field', () => {
  const line = JSON.stringify({ [APPROVAL_RESPONSE_KEY]: { other: true } });
  assert.equal(parseApprovalResponse(line), null);
});

// ── Round-trip ──

test('request and response round-trip preserves all fields', () => {
  const info = {
    peerId: 'deadbeef1234',
    sellerEvmAddr: '0x' + 'ff'.repeat(20),
    suggestedAmount: '2000000',
    firstSignCap: '1000000',
    tokenRate: '1000',
    buyerAvailableUsdc: '10000000',
    isFirstSign: false,
    cooldownRemainingSecs: 86400,
  };

  // CLI sends request
  const requestLine = JSON.stringify({ [APPROVAL_REQUEST_KEY]: info });
  const parsedRequest = isPaymentApprovalRequest(requestLine);
  assert.notEqual(parsedRequest, null);
  assert.equal(parsedRequest!.peerId, info.peerId);
  assert.equal(parsedRequest!.cooldownRemainingSecs, 86400);

  // Desktop sends response
  const responseLine = buildApprovalResponse(true);
  const parsedResponse = parseApprovalResponse(responseLine);
  assert.deepEqual(parsedResponse, { approved: true });
});

// ── USDC formatting (matching component logic) ──

function formatUsdc(baseUnits: string | null | undefined): string {
  if (!baseUnits) return '—';
  const n = Number(baseUnits) / 1_000_000;
  return `$${n.toFixed(2)}`;
}

test('formatUsdc converts base units to dollar display', () => {
  assert.equal(formatUsdc('1000000'), '$1.00');
  assert.equal(formatUsdc('5000000'), '$5.00');
  assert.equal(formatUsdc('500000'), '$0.50');
  assert.equal(formatUsdc('0'), '$0.00');
});

test('formatUsdc handles null/undefined', () => {
  assert.equal(formatUsdc(null), '—');
  assert.equal(formatUsdc(undefined), '—');
  assert.equal(formatUsdc(''), '—');
});

// ── Cooldown formatting ──

function formatCooldown(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || secs <= 0) return 'Ready';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h remaining`;
  return `${Math.ceil(secs / 60)}m remaining`;
}

test('formatCooldown shows Ready when elapsed', () => {
  assert.equal(formatCooldown(0), 'Ready');
  assert.equal(formatCooldown(-1), 'Ready');
  assert.equal(formatCooldown(null), 'Ready');
  assert.equal(formatCooldown(undefined), 'Ready');
});

test('formatCooldown formats days and hours', () => {
  assert.equal(formatCooldown(86400), '1d 0h remaining');
  assert.equal(formatCooldown(172800 + 7200), '2d 2h remaining');
});

test('formatCooldown formats hours when less than a day', () => {
  assert.equal(formatCooldown(3600), '1h remaining');
  assert.equal(formatCooldown(7200), '2h remaining');
});

test('formatCooldown formats minutes when less than an hour', () => {
  assert.equal(formatCooldown(300), '5m remaining');
  assert.equal(formatCooldown(60), '1m remaining');
  assert.equal(formatCooldown(30), '1m remaining'); // ceil
});

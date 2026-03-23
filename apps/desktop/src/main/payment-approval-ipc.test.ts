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

function buildApprovalResponse(approved: boolean, peerId: string): string {
  return JSON.stringify({ [APPROVAL_RESPONSE_KEY]: { approved, peerId } });
}

function parseApprovalResponse(line: string, expectedPeerId: string): { approved: boolean } | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const response = parsed[APPROVAL_RESPONSE_KEY] as { approved: boolean; peerId?: string } | undefined;
    if (response && typeof response.approved === 'boolean' && response.peerId === expectedPeerId) {
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

test('buildApprovalResponse creates approved response with peerId', () => {
  const response = buildApprovalResponse(true, 'peer-abc');
  const parsed = JSON.parse(response) as Record<string, unknown>;
  const inner = parsed[APPROVAL_RESPONSE_KEY] as { approved: boolean; peerId: string };
  assert.equal(inner.approved, true);
  assert.equal(inner.peerId, 'peer-abc');
});

test('buildApprovalResponse creates rejected response with peerId', () => {
  const response = buildApprovalResponse(false, 'peer-xyz');
  const parsed = JSON.parse(response) as Record<string, unknown>;
  const inner = parsed[APPROVAL_RESPONSE_KEY] as { approved: boolean; peerId: string };
  assert.equal(inner.approved, false);
  assert.equal(inner.peerId, 'peer-xyz');
});

// ── Response parsing ──

test('parseApprovalResponse parses approved response for matching peerId', () => {
  const line = buildApprovalResponse(true, 'peer-abc');
  const result = parseApprovalResponse(line, 'peer-abc');
  assert.deepEqual(result, { approved: true });
});

test('parseApprovalResponse returns null for non-matching peerId', () => {
  const line = buildApprovalResponse(true, 'peer-abc');
  const result = parseApprovalResponse(line, 'peer-xyz');
  assert.equal(result, null);
});

test('parseApprovalResponse parses rejected response', () => {
  const line = buildApprovalResponse(false, 'peer-abc');
  const result = parseApprovalResponse(line, 'peer-abc');
  assert.deepEqual(result, { approved: false });
});

test('parseApprovalResponse returns null for non-response', () => {
  assert.equal(parseApprovalResponse('hello', 'any'), null);
  assert.equal(parseApprovalResponse('{}', 'any'), null);
  assert.equal(parseApprovalResponse('{"other": true}', 'any'), null);
});

test('parseApprovalResponse rejects missing approved field', () => {
  const line = JSON.stringify({ [APPROVAL_RESPONSE_KEY]: { other: true, peerId: 'p' } });
  assert.equal(parseApprovalResponse(line, 'p'), null);
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

  // Desktop sends response with peerId correlation
  const responseLine = buildApprovalResponse(true, info.peerId);
  const parsedResponse = parseApprovalResponse(responseLine, info.peerId);
  assert.deepEqual(parsedResponse, { approved: true });

  // Different peerId should not match
  assert.equal(parseApprovalResponse(responseLine, 'other-peer'), null);
});

// ── Concurrent approval correlation ──

test('concurrent approvals: each response matches only its peerId', () => {
  const peerA = 'peer-aaaa';
  const peerB = 'peer-bbbb';

  const responseA = buildApprovalResponse(true, peerA);
  const responseB = buildApprovalResponse(false, peerB);

  // A's response only matches A
  assert.deepEqual(parseApprovalResponse(responseA, peerA), { approved: true });
  assert.equal(parseApprovalResponse(responseA, peerB), null);

  // B's response only matches B
  assert.deepEqual(parseApprovalResponse(responseB, peerB), { approved: false });
  assert.equal(parseApprovalResponse(responseB, peerA), null);
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

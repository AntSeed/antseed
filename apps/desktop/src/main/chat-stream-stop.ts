// Note: `payment_required` is part of this union but is intentionally never
// produced by `classifyChatStreamFailure`. Payment-required stops are emitted
// via the dedicated `emitPaymentRequiredStreamError` path in pi-chat-engine.
// This type is also mirrored (for IPC) in:
//   - apps/desktop/src/main/preload.cts (ChatAiStreamStopReason)
//   - apps/desktop/src/renderer/types/bridge.ts (ChatAiStreamStopReason)
// Keep those in sync when fields change.
export type ChatStreamStopKind =
  | 'payment_required'
  | 'aborted'
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'stream_error'
  | 'unknown';

export type ChatStreamStopSource =
  | 'billing'
  | 'user'
  | 'transport'
  | 'upstream'
  | 'unknown';

export type ChatStreamStopReason = {
  kind: ChatStreamStopKind;
  source: ChatStreamStopSource;
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: string;
};

type ClassifyChatStreamFailureInput = {
  error?: unknown;
  message?: string;
  stopReason?: 'error' | 'aborted';
};

const COMMON_HTTP_STATUS_TEXT: Record<number, string> = {
  408: 'Request Timeout',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function collectErrorSignals(
  value: unknown,
  state = {
    visited: new Set<unknown>(),
    messages: [] as string[],
    statusCodes: [] as number[],
    errorCodes: [] as string[],
  },
): typeof state {
  if (value == null) {
    return state;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length > 0) {
      state.messages.push(text);
    }
    return state;
  }

  if (typeof value !== 'object') {
    return state;
  }

  if (state.visited.has(value)) {
    return state;
  }
  state.visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectErrorSignals(item, state);
    }
    return state;
  }

  const record = value as Record<string, unknown>;

  // Note: HTTP response `body` is intentionally excluded from user-facing
  // message collection — it can contain tokens, API internals, or other
  // sensitive content. Status codes are still extracted from dedicated
  // fields (`status`/`statusCode`/`httpStatus`) and via `parseStatusCodeFromText`.
  for (const key of ['message', 'errorMessage', 'finalError', 'statusText']) {
    const field = record[key];
    if (typeof field === 'string' && field.trim().length > 0) {
      state.messages.push(field.trim());
    }
  }

  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const field = record[key];
    const parsed = Number(field);
    if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 599) {
      state.statusCodes.push(Math.floor(parsed));
    }
  }

  for (const key of ['code', 'errorCode', 'name']) {
    const field = record[key];
    if (typeof field === 'string' && field.trim().length > 0) {
      state.errorCodes.push(field.trim());
    }
  }

  for (const key of ['cause', 'error', 'errors', 'details']) {
    if (key in record) {
      collectErrorSignals(record[key], state);
    }
  }

  return state;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
  }
  return result;
}

function parseStatusCodeFromText(text: string): number | undefined {
  // Only match status codes that appear in an HTTP-shaped context. A bare
  // leading-digit heuristic (e.g. `/^\s*(\d{3})\b/`) produced false positives
  // on messages like "128 tokens remaining" — which would be read as HTTP 128.
  const patterns = [
    /\bstatus(?:\s+code)?\s*(?:=|:)?\s*(\d{3})\b/i,
    /\bhttp\s*(\d{3})\b/i,
    /\bresponse failed:\s*(\d{3})\b/i,
    /\b(\d{3})\s+(?:bad gateway|gateway timeout|service unavailable|too many requests|request timeout|internal server error)\b/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 599) {
      return parsed;
    }
  }

  return undefined;
}

function parseErrorCodeFromText(text: string): string | undefined {
  const match = /\b(UND_ERR_[A-Z_]+|E[A-Z0-9_]+|ERR_[A-Z0-9_]+)\b/.exec(text);
  return match?.[1];
}

function describeHttpStatus(statusCode: number): string {
  return COMMON_HTTP_STATUS_TEXT[statusCode] ?? 'HTTP Error';
}

/**
 * Buyer-side faults the proxy reports as a structured 503 rather than a
 * peer-blaming 502. Matched on the codes the proxy and negotiator emit.
 */
const BUYER_FAULT_PATTERN =
  /buyer_request_failed|buyer-deposits-insufficient|buyer-session-state|buyer-transport-closed|buyer-budget-too-low|buyer-reserve-misconfigured|chain[-_]rpc[-_]unavailable|payment_negotiation_failed|deposits_not_configured|node-not-started|node-stopped/i;

function isBuyerFaultBody(normalized: string): boolean {
  return BUYER_FAULT_PATTERN.test(normalized);
}

function buildBuyerFaultMessage(normalized: string, statusCode: number): string {
  if (/chain[-_]rpc[-_]unavailable/i.test(normalized)) {
    return 'Could not reach the chain RPC to check your deposits. '
      + 'Check your network and the RPC URL in chain settings, then retry.';
  }
  if (/buyer-deposits-insufficient|deposits_not_configured/i.test(normalized)) {
    return 'Your deposit balance is too low to open a payment channel. '
      + 'Top up your deposits and retry.';
  }
  return `The request failed on this device (HTTP ${String(statusCode)}). `
    + 'This is a buyer-side problem, not the peer — check your deposits, network and chain settings.';
}

function buildHttpErrorMessage(statusCode: number, retryable: boolean): string {
  const statusText = describeHttpStatus(statusCode);
  return retryable
    ? `The stream stopped with HTTP ${String(statusCode)} (${statusText}). You can retry.`
    : `The stream stopped with HTTP ${String(statusCode)} (${statusText}).`;
}

export function classifyChatStreamFailure({
  error,
  message,
  stopReason,
}: ClassifyChatStreamFailureInput): ChatStreamStopReason {
  const signals = collectErrorSignals(error);
  if (typeof message === 'string' && message.trim().length > 0) {
    signals.messages.push(message.trim());
  }

  const rawMessage = uniqueStrings(signals.messages).join(' | ') || 'The stream stopped before completion.';
  const normalized = rawMessage.toLowerCase();
  const statusCode = signals.statusCodes[0] ?? parseStatusCodeFromText(rawMessage);
  const errorCode = signals.errorCodes.find(Boolean) ?? parseErrorCodeFromText(rawMessage);

  // Keep the text-based abort match narrow so transport-side aborts (e.g.
  // "connection aborted by remote") aren't misclassified as user-initiated.
  if (
    stopReason === 'aborted'
    || errorCode === 'AbortError'
    || /\brequest aborted\b|\baborted by user\b|\bthe operation was aborted\b|\boperation was aborted\b/.test(normalized)
  ) {
    return {
      kind: 'aborted',
      source: 'user',
      retryable: false,
      message: 'Request aborted.',
      ...(errorCode ? { errorCode } : {}),
    };
  }

  const timeoutLike =
    /\btimed out\b|\btimeout\b|\btime out\b|\bheaders timeout\b|\bconnect timeout\b|\bgateway timeout\b/.test(normalized)
    || errorCode === 'ETIMEDOUT'
    || errorCode === 'UND_ERR_CONNECT_TIMEOUT'
    || errorCode === 'UND_ERR_HEADERS_TIMEOUT';
  if (timeoutLike || statusCode === 408 || statusCode === 504) {
    return {
      kind: 'timeout',
      source: statusCode ? 'upstream' : 'transport',
      retryable: true,
      message: statusCode
        ? buildHttpErrorMessage(statusCode, true)
        : 'The stream timed out before completion. You can retry.',
      ...(statusCode ? { statusCode } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  if (typeof statusCode === 'number') {
    // 503 from the buyer proxy means the fault is on our side — empty deposits,
    // an unreachable chain RPC, bad config. Retrying, or worse failing over to
    // another peer, would walk the whole peer list while hiding the one thing
    // the user actually needs to fix.
    const buyerFault = statusCode === 503 && isBuyerFaultBody(normalized);
    const retryable = !buyerFault && (statusCode >= 500 || statusCode === 429);
    return {
      kind: 'http_error',
      source: buyerFault ? 'transport' : 'upstream',
      retryable,
      message: buyerFault
        ? buildBuyerFaultMessage(normalized, statusCode)
        : buildHttpErrorMessage(statusCode, retryable),
      statusCode,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  const networkLike =
    /\bnetwork error\b|\bfetch failed\b|\bfailed to fetch\b|\bconnection reset\b|\bconnection refused\b|\bsocket hang up\b|\breset before headers\b|\bupstream connect\b|\bterminated\b|\bunexpected end\b|\bstream ended unexpectedly\b|\bincomplete chunked encoding\b/.test(normalized)
    || errorCode === 'ECONNRESET'
    || errorCode === 'ECONNREFUSED'
    || errorCode === 'ENOTFOUND'
    || errorCode === 'EHOSTUNREACH'
    || errorCode === 'EPIPE';
  if (networkLike) {
    return {
      kind: 'network_error',
      source: 'transport',
      retryable: true,
      message: errorCode
        ? `The stream connection ended unexpectedly (${errorCode}). You can retry.`
        : 'The stream connection ended unexpectedly. You can retry.',
      ...(errorCode ? { errorCode } : {}),
    };
  }

  if (stopReason === 'error') {
    return {
      kind: 'stream_error',
      source: 'upstream',
      retryable: false,
      message: rawMessage === 'The stream stopped before completion.'
        ? rawMessage
        : `The stream stopped before completion: ${rawMessage}`,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  return {
    kind: 'unknown',
    source: 'unknown',
    retryable: false,
    message: rawMessage === 'The stream stopped before completion.'
      ? rawMessage
      : `The stream stopped before completion: ${rawMessage}`,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function formatChatStreamStopForLog(reason: ChatStreamStopReason): string {
  const parts: string[] = [reason.kind];
  if (reason.statusCode) {
    parts.push(`status=${String(reason.statusCode)}`);
  }
  if (reason.errorCode) {
    parts.push(`code=${reason.errorCode}`);
  }
  parts.push(reason.retryable ? 'retryable' : 'non-retryable');
  return `${parts.join(', ')}: ${reason.message}`;
}

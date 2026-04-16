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

  for (const key of ['message', 'errorMessage', 'finalError', 'statusText', 'body']) {
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
  const patterns = [
    /\bstatus(?:\s+code)?\s*(?:=|:)?\s*(\d{3})\b/i,
    /\bhttp\s*(\d{3})\b/i,
    /\bresponse failed:\s*(\d{3})\b/i,
    /\b(\d{3})\s+(?:bad gateway|gateway timeout|service unavailable|too many requests|request timeout|internal server error)\b/i,
    /^\s*(\d{3})\b/,
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

  if (stopReason === 'aborted' || errorCode === 'AbortError' || /\brequest aborted\b|\baborted\b/.test(normalized)) {
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
    const retryable = statusCode >= 500 || statusCode === 429;
    return {
      kind: 'http_error',
      source: 'upstream',
      retryable,
      message: buildHttpErrorMessage(statusCode, retryable),
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

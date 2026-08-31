import type {
  ChatFailureCode,
  ChatFailureStage,
  DepositFailureCode,
  DepositFailureStage,
  DiscoveryFailureCode,
} from './events.js';

export function classifyDiscoveryFailure(error: string): DiscoveryFailureCode {
  const normalized = error.toLowerCase();
  if (/timed? ?out|timeout|abort/.test(normalized)) return 'timeout';
  if (/json|parse|invalid|malformed|unexpected token/.test(normalized)) return 'invalid_data';
  if (/enoent|eacces|eperm|file|directory|read/.test(normalized)) return 'io_error';
  return 'unknown';
}

export type NormalizedDepositFailure = {
  failureCode: DepositFailureCode;
  failureStage: DepositFailureStage;
  retryable: boolean;
};

export function classifyDepositFailure(error: string, watcherReason?: string | null): NormalizedDepositFailure {
  if (watcherReason === 'payments-disabled') {
    return { failureCode: 'payments_disabled', failureStage: 'preflight', retryable: false };
  }
  if (watcherReason === 'no-deposit-relay') {
    return { failureCode: 'deposit_relay_unavailable', failureStage: 'preflight', retryable: false };
  }

  const normalized = error.toLowerCase();
  if (/domain mismatch|eip-712/.test(normalized)) {
    return { failureCode: 'domain_mismatch', failureStage: 'signing', retryable: false };
  }
  if (/no deposit relayers? (?:are )?reachable|relayer.*unreachable/.test(normalized)) {
    return { failureCode: 'relayer_unreachable', failureStage: 'dispatch', retryable: true };
  }
  if (/no deposit relayer accepted|relayer.*declined/.test(normalized)) {
    return { failureCode: 'relayer_declined', failureStage: 'dispatch', retryable: true };
  }
  if (/not confirmed in time|confirmation.*timed? ?out/.test(normalized)) {
    return { failureCode: 'confirmation_timeout', failureStage: 'confirmation', retryable: true };
  }
  if (/\brpc\b|failed to fetch|network error|connection (?:refused|reset)|enotfound|ehostunreach/.test(normalized)) {
    return { failureCode: 'rpc_unavailable', failureStage: 'preflight', retryable: true };
  }
  if (watcherReason !== undefined) {
    return { failureCode: 'watcher_unavailable', failureStage: 'preflight', retryable: true };
  }
  return { failureCode: 'unknown', failureStage: 'sweep', retryable: true };
}

export type ChatFailureReason = {
  kind: string;
  source: string;
  retryable: boolean;
  statusCode?: number;
};

export type NormalizedChatFailure = {
  failureCode: ChatFailureCode;
  failureStage: ChatFailureStage;
  retryable: boolean;
  statusCode?: number;
};

function inferStreamedHttpStatus(rawMessage: string): number | undefined {
  const match = /(?:^|:\s)([45]\d{2})\s+data:\s*\{/i.exec(rawMessage);
  if (!match) return undefined;
  const statusCode = Number(match[1]);
  return Number.isFinite(statusCode) ? statusCode : undefined;
}

export function classifyChatRequestFailure(
  reason: ChatFailureReason,
  rawMessage = '',
): NormalizedChatFailure {
  const normalized = rawMessage.toLowerCase();
  const statusCode = reason.statusCode ?? inferStreamedHttpStatus(rawMessage);
  if (/model_not_found|not served by this peer|model .* not (?:served|available)/.test(normalized)) {
    return {
      failureCode: 'model_not_served_by_peer',
      failureStage: 'request_validation',
      retryable: true,
      ...(statusCode ? { statusCode } : {}),
    };
  }
  if (reason.kind === 'payment_required') {
    return {
      failureCode: 'payment_required',
      failureStage: 'payment',
      retryable: false,
      statusCode: statusCode ?? 402,
    };
  }
  if (reason.kind === 'aborted') {
    return { failureCode: 'user_aborted', failureStage: 'user', retryable: false };
  }
  if (reason.kind === 'timeout') {
    return { failureCode: 'timeout', failureStage: 'transport', retryable: true };
  }
  if (statusCode === 429) {
    return { failureCode: 'rate_limited', failureStage: 'upstream', retryable: true, statusCode };
  }
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { failureCode: 'http_4xx', failureStage: 'upstream', retryable: reason.retryable, statusCode };
  }
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) {
    return { failureCode: 'http_5xx', failureStage: reason.source === 'transport' ? 'transport' : 'upstream', retryable: reason.retryable, statusCode };
  }
  if (reason.kind === 'network_error') {
    return { failureCode: 'network_error', failureStage: 'transport', retryable: reason.retryable };
  }
  if (reason.kind === 'stream_error') {
    return { failureCode: 'stream_error', failureStage: 'streaming', retryable: reason.retryable };
  }
  return {
    failureCode: 'unknown',
    failureStage: reason.source === 'transport' ? 'transport' : 'upstream',
    retryable: reason.retryable,
  };
}

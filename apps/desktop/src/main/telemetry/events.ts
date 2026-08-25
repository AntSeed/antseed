/**
 * Typed catalog of every telemetry event the desktop app may emit.
 *
 * This file is the single source of truth for what leaves the device. The
 * PostHog transport (./posthog.ts) only forwards events listed here, and
 * ./sanitize.ts drops any property not declared on the event. Both the event
 * names and their property sets are mirrored in the public privacy doc
 * (docs/telemetry.md) — keep them in sync.
 *
 * Hard rules (see the telemetry design issue):
 * - Never prompts, chat contents, assistant responses, file names or paths.
 * - Never wallet addresses, transaction hashes, or exact balances/amounts.
 * - Never peer IDs, env vars, command lines, logs, or stack traces.
 * - Only coarse buckets for durations and amounts.
 */

export const TELEMETRY_SCHEMA_VERSION = 1;

export type DurationBucket = 'under_30s' | '30s_2m' | '2m_5m' | 'over_5m';
export type SessionDurationBucket = DurationBucket | 'over_30m';
export type DepositAmountBucket = 'under_5' | '5_25' | '25_100' | '100_plus';
export type DaysSinceFirstOpen = '0' | '1_7' | '8_30' | '31_plus';
export type ServiceCategory = 'chat' | 'image' | 'other';
export type CountBucket = '0' | '1' | '2_5' | '6_20' | '21_plus';
export type OffersAvailableBucket = '0' | '1' | '2_3' | '4_plus';
export type HttpStatusBucket = 'none' | '4xx' | '5xx' | 'other';
export type DepositFailureCode =
  | 'payments_disabled'
  | 'deposit_relay_unavailable'
  | 'relayer_unreachable'
  | 'relayer_declined'
  | 'confirmation_timeout'
  | 'domain_mismatch'
  | 'rpc_unavailable'
  | 'watcher_unavailable'
  | 'unknown';
export type DepositFailureStage = 'preflight' | 'signing' | 'dispatch' | 'confirmation' | 'sweep';
export type ChatRequestOutcome = 'success' | 'failed' | 'cancelled';
export type ChatFailureCode =
  | 'none'
  | 'payment_required'
  | 'user_aborted'
  | 'timeout'
  | 'model_not_served_by_peer'
  | 'rate_limited'
  | 'http_4xx'
  | 'http_5xx'
  | 'network_error'
  | 'stream_error'
  | 'unknown';
export type ChatFailureStage = 'none' | 'request_validation' | 'payment' | 'user' | 'transport' | 'upstream' | 'streaming';
export type RouteMode = 'auto' | 'pinned';
export type FirstChatDepositSnapshot = {
  hadDeposit: boolean;
  depositBucket: DepositAmountBucket | 'none';
};

export type TelemetryEventProperties = {
  /** Emitted exactly once per local installation, on first launch. */
  app_first_opened: {
    first_open_date: string;
  };
  /** Emitted once per application launch. */
  app_started: {
    is_first_launch: boolean;
  };
  /** Emitted when first-run setup completes. */
  setup_completed: {
    duration_bucket: DurationBucket;
  };
  /** Emitted when a deposit is observed credited. */
  deposit_completed: {
    method_category: string;
    amount_bucket: DepositAmountBucket;
    is_first_deposit: boolean;
    days_since_first_open: DaysSinceFirstOpen;
  };
  /** Emitted when an automatic deposit attempt or watcher setup fails. */
  deposit_failed: {
    method_category: 'usdc';
    failure_code: DepositFailureCode;
    failure_stage: DepositFailureStage;
    retryable: boolean;
  };
  /** Emitted exactly once per installation, on the first valid chat request. */
  first_chat_started: {
    had_deposit: boolean;
    deposit_bucket: DepositAmountBucket | 'none';
    days_since_first_open: DaysSinceFirstOpen;
    service_category: ServiceCategory;
    has_attachments: boolean;
  };
  /** Emitted once for every valid remote chat attempt, including failures. */
  chat_request_finished: {
    outcome: ChatRequestOutcome;
    failure_code: ChatFailureCode;
    failure_stage: ChatFailureStage;
    public_model_id: string;
    service_category: ServiceCategory;
    route_mode: RouteMode;
    offers_available_bucket: OffersAvailableBucket;
    http_status_bucket: HttpStatusBucket;
    retryable: boolean;
    automatic_retry_attempted: boolean;
    automatic_retry_succeeded: boolean;
    had_partial_output: boolean;
    duration_bucket: DurationBucket;
    has_attachments: boolean;
  };
  /** Emitted after each discovery request, whether it succeeds or fails. */
  discovery_completed: {
    outcome: 'success' | 'failed';
    duration_bucket: DurationBucket;
    service_count_bucket: CountBucket;
    peer_count_bucket: CountBucket;
    result_count_bucket: CountBucket;
    was_empty: boolean;
  };
  /**
   * Emitted on clean shutdown (was_crash=false), or recovered on the next
   * launch after an unclean shutdown (was_crash=true, describing the
   * previous session).
   */
  app_closed: {
    was_crash: boolean;
    session_duration_bucket: SessionDurationBucket;
  };
};

export type TelemetryEventName = keyof TelemetryEventProperties;

/** Allowlisted property keys per event — anything else is dropped. */
export const TELEMETRY_EVENT_ALLOWLIST: { readonly [K in TelemetryEventName]: ReadonlySet<string> } = {
  app_first_opened: new Set(['first_open_date']),
  app_started: new Set(['is_first_launch']),
  setup_completed: new Set(['duration_bucket']),
  deposit_completed: new Set(['method_category', 'amount_bucket', 'is_first_deposit', 'days_since_first_open']),
  deposit_failed: new Set(['method_category', 'failure_code', 'failure_stage', 'retryable']),
  first_chat_started: new Set(['had_deposit', 'deposit_bucket', 'days_since_first_open', 'service_category', 'has_attachments']),
  chat_request_finished: new Set([
    'outcome',
    'failure_code',
    'failure_stage',
    'public_model_id',
    'service_category',
    'route_mode',
    'offers_available_bucket',
    'http_status_bucket',
    'retryable',
    'automatic_retry_attempted',
    'automatic_retry_succeeded',
    'had_partial_output',
    'duration_bucket',
    'has_attachments',
  ]),
  discovery_completed: new Set([
    'outcome',
    'duration_bucket',
    'service_count_bucket',
    'peer_count_bucket',
    'result_count_bucket',
    'was_empty',
  ]),
  app_closed: new Set(['was_crash', 'session_duration_bucket']),
};

export const DEPOSIT_AMOUNT_BUCKETS: ReadonlySet<string> = new Set(['under_5', '5_25', '25_100', '100_plus']);
export const DURATION_BUCKETS: ReadonlySet<string> = new Set(['under_30s', '30s_2m', '2m_5m', 'over_5m']);
export const SESSION_DURATION_BUCKETS: ReadonlySet<string> = new Set(['under_30s', '30s_2m', '2m_5m', 'over_5m', 'over_30m']);
export const DAYS_SINCE_FIRST_OPEN_BUCKETS: ReadonlySet<string> = new Set(['0', '1_7', '8_30', '31_plus']);
export const SERVICE_CATEGORIES: ReadonlySet<string> = new Set(['chat', 'image', 'other']);
export const COUNT_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2_5', '6_20', '21_plus']);
export const OFFERS_AVAILABLE_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2_3', '4_plus']);
export const HTTP_STATUS_BUCKETS: ReadonlySet<string> = new Set(['none', '4xx', '5xx', 'other']);
export const DEPOSIT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'payments_disabled',
  'deposit_relay_unavailable',
  'relayer_unreachable',
  'relayer_declined',
  'confirmation_timeout',
  'domain_mismatch',
  'rpc_unavailable',
  'watcher_unavailable',
  'unknown',
]);
export const DEPOSIT_FAILURE_STAGES: ReadonlySet<string> = new Set(['preflight', 'signing', 'dispatch', 'confirmation', 'sweep']);
export const CHAT_REQUEST_OUTCOMES: ReadonlySet<string> = new Set(['success', 'failed', 'cancelled']);
export const CHAT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'none',
  'payment_required',
  'user_aborted',
  'timeout',
  'model_not_served_by_peer',
  'rate_limited',
  'http_4xx',
  'http_5xx',
  'network_error',
  'stream_error',
  'unknown',
]);
export const CHAT_FAILURE_STAGES: ReadonlySet<string> = new Set([
  'none',
  'request_validation',
  'payment',
  'user',
  'transport',
  'upstream',
  'streaming',
]);
export const ROUTE_MODES: ReadonlySet<string> = new Set(['auto', 'pinned']);

export function durationBucket(ms: number): DurationBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 2 * 60_000) return '30s_2m';
  if (ms < 5 * 60_000) return '2m_5m';
  return 'over_5m';
}

export function sessionDurationBucket(ms: number): SessionDurationBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 2 * 60_000) return '30s_2m';
  if (ms < 5 * 60_000) return '2m_5m';
  if (ms < 30 * 60_000) return 'over_5m';
  return 'over_30m';
}

export function depositAmountBucket(amountUsdc: number): DepositAmountBucket {
  if (amountUsdc < 5) return 'under_5';
  if (amountUsdc < 25) return '5_25';
  if (amountUsdc < 100) return '25_100';
  return '100_plus';
}

/** Converts a local exact balance into the only coarse values telemetry accepts. */
export function firstChatDepositSnapshot(balanceUsdc: string): FirstChatDepositSnapshot | null {
  const amountUsdc = Number(balanceUsdc);
  if (!Number.isFinite(amountUsdc) || amountUsdc < 0) return null;
  if (amountUsdc === 0) return { hadDeposit: false, depositBucket: 'none' };
  return { hadDeposit: true, depositBucket: depositAmountBucket(amountUsdc) };
}

export function daysSinceFirstOpenBucket(days: number): DaysSinceFirstOpen {
  if (days <= 0) return '0';
  if (days <= 7) return '1_7';
  if (days <= 30) return '8_30';
  return '31_plus';
}

export function countBucket(count: number): CountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  return '21_plus';
}

export function offersAvailableBucket(count: number): OffersAvailableBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2_3';
  return '4_plus';
}

export function httpStatusBucket(statusCode?: number): HttpStatusBucket {
  if (typeof statusCode !== 'number') return 'none';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  if (statusCode >= 500 && statusCode < 600) return '5xx';
  return 'other';
}

const PUBLIC_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;

export function publicModelId(serviceId: string, isCurrentlyAdvertised: boolean): string {
  const normalized = serviceId.trim().toLowerCase();
  return isCurrentlyAdvertised && PUBLIC_MODEL_ID_PATTERN.test(normalized)
    ? normalized
    : 'custom_or_unknown';
}

const IMAGE_SERVICE_PATTERN = /image|dall|flux|sdxl|stable[-_]?diffusion|midjourney|imagen/i;
const CHAT_SERVICE_PATTERN = /chat|claude|gpt|llama|qwen|deepseek|mistral|gemini|kimi|glm|grok|command|o[13]/i;

/** Coarse category used independently of the separately guarded public model ID. */
export function classifyServiceCategory(serviceId: string): ServiceCategory {
  if (IMAGE_SERVICE_PATTERN.test(serviceId)) return 'image';
  if (CHAT_SERVICE_PATTERN.test(serviceId)) return 'chat';
  return 'other';
}

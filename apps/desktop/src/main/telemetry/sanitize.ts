/**
 * Strict property sanitizer for telemetry events.
 *
 * Every property value passes through here before leaving the device:
 * - keys not in the event's allowlist are dropped;
 * - strings are truncated;
 * - numbers are bounded to safe, finite integers;
 * - unsupported value types (objects, arrays, functions) are dropped.
 */
import {
  CHAT_FAILURE_CODES,
  CHAT_FAILURE_STAGES,
  CHAT_REQUEST_OUTCOMES,
  COUNT_BUCKETS,
  DAYS_SINCE_FIRST_OPEN_BUCKETS,
  DEPOSIT_FAILURE_CODES,
  DEPOSIT_FAILURE_STAGES,
  DEPOSIT_AMOUNT_BUCKETS,
  DURATION_BUCKETS,
  HTTP_STATUS_BUCKETS,
  OFFERS_AVAILABLE_BUCKETS,
  ROUTE_MODES,
  SERVICE_CATEGORIES,
  SESSION_DURATION_BUCKETS,
  TELEMETRY_EVENT_ALLOWLIST,
  type TelemetryEventName,
  type TelemetryEventProperties,
} from './events.js';

const MAX_STRING_LENGTH = 64;
const MAX_ABS_NUMBER = Number.MAX_SAFE_INTEGER;

function sanitizeString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
}

function sanitizeNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(-MAX_ABS_NUMBER, Math.min(MAX_ABS_NUMBER, value));
  return Math.round(clamped);
}

const PROPERTY_VALIDATORS: Record<string, ReadonlySet<string>> = {
  duration_bucket: DURATION_BUCKETS,
  session_duration_bucket: SESSION_DURATION_BUCKETS,
  amount_bucket: DEPOSIT_AMOUNT_BUCKETS,
  deposit_bucket: new Set(['none', ...DEPOSIT_AMOUNT_BUCKETS]),
  days_since_first_open: DAYS_SINCE_FIRST_OPEN_BUCKETS,
  service_category: SERVICE_CATEGORIES,
  route_mode: ROUTE_MODES,
  offers_available_bucket: OFFERS_AVAILABLE_BUCKETS,
  http_status_bucket: HTTP_STATUS_BUCKETS,
  service_count_bucket: COUNT_BUCKETS,
  peer_count_bucket: COUNT_BUCKETS,
  result_count_bucket: COUNT_BUCKETS,
};

const EVENT_PROPERTY_VALIDATORS: Partial<Record<TelemetryEventName, Record<string, ReadonlySet<string>>>> = {
  deposit_failed: {
    failure_code: DEPOSIT_FAILURE_CODES,
    failure_stage: DEPOSIT_FAILURE_STAGES,
  },
  chat_request_finished: {
    outcome: CHAT_REQUEST_OUTCOMES,
    failure_code: CHAT_FAILURE_CODES,
    failure_stage: CHAT_FAILURE_STAGES,
  },
  discovery_completed: {
    outcome: new Set(['success', 'failed']),
  },
};

const PUBLIC_MODEL_ID_PATTERN = /^(?:custom_or_unknown|[a-z0-9][a-z0-9._:/-]{0,63})$/;

export function sanitizeTelemetryProperties<K extends TelemetryEventName>(
  event: K,
  properties: TelemetryEventProperties[K],
): Record<string, string | number | boolean> {
  const allowlist = TELEMETRY_EVENT_ALLOWLIST[event];
  const out: Record<string, string | number | boolean> = {};
  const raw = (properties ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (!allowlist.has(key)) continue;
    if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      const num = sanitizeNumber(value);
      if (num !== null) out[key] = num;
    } else if (typeof value === 'string') {
      const propertyValidator = EVENT_PROPERTY_VALIDATORS[event]?.[key] ?? PROPERTY_VALIDATORS[key];
      if (propertyValidator && !propertyValidator.has(value)) continue;
      if (key === 'public_model_id' && !PUBLIC_MODEL_ID_PATTERN.test(value)) continue;
      out[key] = sanitizeString(value);
    }
    // Objects/arrays/null/undefined/functions are dropped.
  }
  return out;
}

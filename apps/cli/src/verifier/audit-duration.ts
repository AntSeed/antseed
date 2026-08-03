export const MIN_AUDIT_DURATION_MS = 24 * 60 * 60 * 1_000
export const MAX_AUDIT_DURATION_MS = 48 * 60 * 60 * 1_000
export const DEFAULT_AUDIT_DURATION_MS = MIN_AUDIT_DURATION_MS

export function assertAuditDurationMs(durationMs: number): number {
  if (
    !Number.isSafeInteger(durationMs)
    || durationMs < MIN_AUDIT_DURATION_MS
    || durationMs > MAX_AUDIT_DURATION_MS
  ) {
    throw new Error('audit duration must be between 24 and 48 hours')
  }
  return durationMs
}

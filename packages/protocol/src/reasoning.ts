export type ReasoningEffort = string;

export const MAX_REASONING_EFFORTS = 32;
export const MAX_REASONING_EFFORT_BYTES = 64;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)
    && new TextEncoder().encode(value).length <= MAX_REASONING_EFFORT_BYTES;
}

export function isReasoningEffortList(value: unknown): value is ReasoningEffort[] {
  return Array.isArray(value) && value.length <= MAX_REASONING_EFFORTS
    && Array.from(value).every(isReasoningEffort) && new Set(value).size === value.length;
}

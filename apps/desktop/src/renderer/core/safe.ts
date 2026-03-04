export type UnknownRecord = Record<string, unknown>;

export function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function safeArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function safeObject(value: unknown): UnknownRecord | null {
  if (value && typeof value === 'object') {
    return value as UnknownRecord;
  }
  return null;
}

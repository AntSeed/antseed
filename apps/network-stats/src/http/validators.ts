import type { Request } from 'express';

import type { HistoryRange } from '../store.js';

/**
 * Thrown by request-parsing helpers; turned into a 400 by `errorHandler`.
 * Keeping the class here (rather than middleware.ts) avoids a cycle:
 * middleware.ts imports this, and routes import both.
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

const HISTORY_RANGES: readonly HistoryRange[] = ['1d', '7d', '30d'] as const;

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === 'string' && (HISTORY_RANGES as readonly string[]).includes(value);
}

/**
 * Read `?range=` from the request, defaulting to `1d`. Throws `BadRequestError`
 * for unknown values so the handler stays linear (no manual `if (!ok) return`).
 */
export function parseHistoryRange(req: Request): HistoryRange {
  const raw = typeof req.query['range'] === 'string' ? req.query['range'] : '1d';
  if (!isHistoryRange(raw)) {
    throw new BadRequestError(`invalid range; expected one of ${HISTORY_RANGES.join(',')}`);
  }
  return raw;
}

/** Bucket seconds for a range — used when synthesising an empty payload. */
export function bucketSecondsForRange(range: HistoryRange): number {
  return range === '1d' ? 3600 : 86400;
}

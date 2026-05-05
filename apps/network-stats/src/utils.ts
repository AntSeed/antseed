/**
 * Shared utility helpers for the network-stats backend. Lives at the
 * bottom of the dependency graph — must not import from any other
 * file in this package, so anything in here can be used freely from
 * metrics.ts, server.ts, store.ts, etc.
 */

import type { PeerMetadata } from '@antseed/node';

/** Increment a string-keyed counter map in place. */
export function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Nearest-rank percentile. Caller must pass a non-empty sorted-ascending array. */
export function pct(sorted: number[], p: number): number {
  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

/** Ascending numeric comparator for Array#sort. */
export function asc(a: number, b: number): number {
  return a - b;
}

/** Ascending bigint comparator — `Array#sort` rejects the obvious `a - b` form. */
export function bigintAsc(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Descending bigint comparator. */
export function bigintDesc(a: bigint, b: bigint): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Last item with `item.ts <= tsCutoff` in an array sorted ascending by `ts`,
 * or null if no such item exists. Linear scan; callers use this on bounded
 * windows (insight history slices), so the simpler implementation beats a
 * binary search.
 */
export function lastAtOrBefore<T extends { ts: number }>(
  items: readonly T[],
  tsCutoff: number,
): T | null {
  let latest: T | null = null;
  for (const item of items) {
    if (item.ts <= tsCutoff) latest = item;
    else break;
  }
  return latest;
}

/**
 * Per-peer dedup of services / categories / protocols / providers across the
 * peer's provider entries. A peer that announces the same service through two
 * providers should still count once per peer; this helper centralises that
 * pattern so metrics + insights stay consistent.
 */
export interface PeerSets {
  services: Set<string>;
  categories: Set<string>;
  protocols: Set<string>;
  providers: Set<string>;
}

export function collectPeerSets(peer: PeerMetadata): PeerSets {
  const services = new Set<string>();
  const categories = new Set<string>();
  const protocols = new Set<string>();
  const providers = new Set<string>();
  for (const provider of peer.providers) {
    providers.add(provider.provider);
    for (const svc of provider.services) services.add(svc);
    for (const cats of Object.values(provider.serviceCategories ?? {})) {
      for (const cat of cats) categories.add(cat);
    }
    for (const protos of Object.values(provider.serviceApiProtocols ?? {})) {
      for (const proto of protos) protocols.add(proto);
    }
  }
  return { services, categories, protocols, providers };
}

/** Compact summary distribution used wherever we expose per-metric percentiles. */
export interface NumericDistribution {
  count: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
}

export function distribution(values: readonly number[]): NumericDistribution {
  // Caller usually passes non-empty arrays, but return a stable zeroed shape
  // so future callers don't accidentally divide by zero.
  if (values.length === 0) {
    return { count: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort(asc);
  const sum = sorted.reduce((acc, x) => acc + x, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    p25: pct(sorted, 0.25),
    median: pct(sorted, 0.5),
    p75: pct(sorted, 0.75),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  };
}

/**
 * Lorenz-curve Gini on a non-negative bigint array. Null for n<2; 0 when
 * total is 0.
 */
export function gini(values: readonly bigint[]): number | null {
  if (values.length < 2) return null;
  const sorted = [...values].sort(bigintAsc);
  let total = 0n;
  for (const v of sorted) total += v;
  if (total === 0n) return 0;
  // G = (2 * sum(i * x_i) - (n + 1) * sum) / (n * sum), 1-indexed.
  let weightedSum = 0n;
  for (let i = 0; i < sorted.length; i++) {
    weightedSum += BigInt(i + 1) * sorted[i]!;
  }
  const n = BigInt(sorted.length);
  const numerator = 2n * weightedSum - (n + 1n) * total;
  const denominator = n * total;
  return Number(numerator) / Number(denominator);
}

export function herfindahl(values: readonly bigint[]): number | null {
  let total = 0n;
  for (const v of values) total += v;
  if (total === 0n) return null;
  let h = 0;
  const totalNum = Number(total);
  for (const v of values) {
    const share = Number(v) / totalNum;
    h += share * share;
  }
  return h;
}

export function topShare(values: readonly bigint[], k: number): number | null {
  let total = 0n;
  for (const v of values) total += v;
  if (total === 0n) return null;
  const sorted = [...values].sort(bigintDesc);
  let head = 0n;
  for (let i = 0; i < Math.min(k, sorted.length); i++) head += sorted[i]!;
  return Number(head) / Number(total);
}

/**
 * Lowercase an EVM address and ensure it has a `0x` prefix. Returns null
 * for null/undefined/empty input so callers can pipeline this through
 * optional fields without an extra check.
 */
export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

export function getPeerLookupAddress(peer: { peerId?: string | null; sellerContract?: string | null }): string | null {
  // Contract-backed sellers announce the settlement address separately; use
  // that for on-chain volume lookup when present.
  return normalizeAddress(peer.sellerContract) ?? normalizeAddress(peer.peerId);
}

/**
 * Run `fn` over `items` with at most `concurrency` calls in flight at once,
 * preserving input order in the result array. Workers pull from a shared
 * cursor — uniform tail latency even when individual calls vary widely.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }));

  return results;
}

/** Minimal slice of ethers.AbstractProvider — just block timestamp lookup. */
export interface BlockProvider {
  getBlock(blockNumber: number): Promise<{ timestamp: number } | null>;
}

/**
 * Fetch block timestamps for the given block numbers in small parallel
 * batches. Returns a Map of block → timestamp plus a count of failed lookups.
 *
 * Uses Promise.allSettled so a transient single-block failure (e.g. a 429 from
 * a public RPC) doesn't tank the whole resolution — the caller can decide what
 * to do with `failedCount` (typically: log a warning and skip those events).
 */
export async function resolveBlockTimestamps(
  provider: BlockProvider,
  blocks: readonly number[],
  opts: { batchSize?: number } = {},
): Promise<{ timestamps: Map<number, number>; failedCount: number }> {
  const batchSize = opts.batchSize ?? 8;
  const timestamps = new Map<number, number>();
  let failedCount = 0;
  for (let i = 0; i < blocks.length; i += batchSize) {
    const slice = blocks.slice(i, i + batchSize);
    const settled = await Promise.allSettled(slice.map((b) => provider.getBlock(b)));
    for (let j = 0; j < slice.length; j++) {
      const result = settled[j]!;
      if (result.status === 'fulfilled' && result.value) {
        timestamps.set(slice[j]!, result.value.timestamp);
      } else {
        failedCount++;
      }
    }
  }
  return { timestamps, failedCount };
}

// ─── progress reporter ──────────────────────────────────────────────────────
//
// In-place terminal progress bar for long-running scans (currently only the
// one-shot chain backfill uses this).
//
// The reporter rewrites a single terminal row each tick using `\r\x1b[K`
// (carriage return + clear-to-end-of-line) so the user sees one updating
// line instead of hundreds of scrolling chunk logs. Throttled to ~10 fps
// so we don't flood the pipe under fast RPCs.
//
// Under `concurrently` (dev), each child write is wrapped with a `[server] `
// prefix; the leading `\r\x1b[K` we emit clears that prefix from the row
// before redrawing, so the bar still updates cleanly in place.
//
// If stdout isn't a TTY-style writer, or the caller passed a custom log
// (so we don't trash test output), we fall back to once-per-5% line logs
// routed through the caller's `log`. That's what the heuristic
// `log === defaultLog` selects on — callers wanting in-place rendering must
// pass the exported `defaultLog` reference (or omit `log` entirely so the
// default kicks in).

/**
 * Stable default logger reference. Held at module scope (rather than a fresh
 * closure per-call) so the in-place progress bar can detect "caller didn't
 * override `log`" via referential equality and safely write to stdout
 * without an implicit newline.
 */
export const defaultLog = (msg: string): void => {
  console.log(msg);
};

export interface ProgressReporter {
  /** Paint a tick. `force=true` bypasses throttling — use for the final 100% frame. */
  draw(scanned: number, eventsSoFar: number, force?: boolean): void;
  /** Commit the in-place line by writing a newline so subsequent log() output starts fresh. */
  finish(): void;
}

export interface ProgressReporterOptions {
  /** Prefix shown at the start of the bar line, e.g. `[backfill]`. */
  prefix: string;
  /** Total work units (denominator for the percentage). */
  totalBlocks: number;
  /** Logger used for the line-fallback path. Pass `defaultLog` to enable in-place rendering. */
  log: (msg: string) => void;
}

const PROGRESS_STEP_PCT = 5;
const PROGRESS_INTERVAL_MS = 100;
const BAR_WIDTH = 20;

export function createProgressReporter(opts: ProgressReporterOptions): ProgressReporter {
  const { prefix, totalBlocks, log } = opts;
  const useInPlace =
    log === defaultLog
    && typeof process !== 'undefined'
    && typeof process.stdout?.write === 'function';
  let lastDrawnAt = 0;
  let lastDrawnPct = -1;
  let inPlaceActive = false;

  const renderBar = (pct: number): string => {
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
  };

  return {
    draw(scanned: number, eventsSoFar: number, force = false): void {
      const pct = totalBlocks === 0 ? 100 : Math.floor((scanned / totalBlocks) * 100);
      const now = Date.now();
      if (!force) {
        if (useInPlace) {
          if (pct === lastDrawnPct && now - lastDrawnAt < PROGRESS_INTERVAL_MS) return;
        } else {
          // Fall back to throttled, full-line logs every PROGRESS_STEP_PCT.
          if (pct < lastDrawnPct + PROGRESS_STEP_PCT) return;
        }
      }
      lastDrawnAt = now;
      lastDrawnPct = pct;
      const line = `${prefix} [${renderBar(pct)}] ${pct.toString().padStart(3)}%  blocks=${scanned}/${totalBlocks}  events=${eventsSoFar}`;
      if (useInPlace) {
        process.stdout.write(`\r\x1b[K${line}`);
        inPlaceActive = true;
      } else {
        log(line);
      }
    },
    finish(): void {
      if (inPlaceActive) {
        process.stdout.write('\n');
        inPlaceActive = false;
      }
    },
  };
}

/**
 * ResponseCache — materialized read-model cache for the public stats API.
 *
 * Design goals:
 *   1. Routes read prebuilt JSON; expensive compute (SQL fan-out, agentId
 *      resolution, history aggregation) happens out of band.
 *   2. Stale-while-revalidate: when an entry crosses the freshness budget
 *      but is still within the stale window, the request returns the cached
 *      bytes immediately and a single background recompute refreshes the slot.
 *   3. Single-flight: concurrent reads that trigger a refresh share one
 *      compute promise — no thundering-herd against SQLite.
 *   4. Cold start: an entry that doesn't exist yet (or has crossed staleMs)
 *      blocks the caller on `compute()` so the first response is never empty.
 *   5. Pluggable: `ResponseCache` is an interface so we can swap to Redis (or
 *      a SQLite-backed shared cache) when the service goes multi-instance.
 *
 * The HTTP wiring (ETag / Cache-Control / X-Cache-State / 304) lives in
 * `sendCachedJson` so any route can opt in with one line.
 */

import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

export type CacheState = 'fresh' | 'stale' | 'cold';

export interface CachedEnvelope<T> {
  payload: T;
  /** ms since epoch when this payload was produced. */
  generatedAt: number;
  /** ms since epoch of the underlying source data, when known. Drives X-Data-Updated-At. */
  sourceUpdatedAt: number | null;
  /** ms since epoch — before this, the entry is `fresh` and served without revalidation. */
  freshUntilMs: number;
  /** ms since epoch — between freshUntilMs and this, the entry is `stale` (SWR). After it, callers block on recompute. */
  staleUntilMs: number;
  /** Stable hash of the serialized payload — drives ETag + 304 short-circuits. */
  etag: string;
  /** Computed at read time so the caller can route fresh vs stale vs cold to different headers. */
  state: CacheState;
}

export interface CacheKeyConfig<T> {
  /**
   * Compute the payload from scratch. Called on cold reads, on background
   * SWR refreshes, and after a hard expiry. Returning `sourceUpdatedAt` lets
   * the cache surface "data last changed at" headers; omit if the source has
   * no meaningful timestamp (e.g. pure derived rollups).
   *
   * Set `cacheable: false` to mark the result as non-storable — useful when
   * the compute completed but the payload reflects a transient degraded
   * state (e.g. an RPC lookup failed and the response contains nulls that
   * shouldn't poison the slot until the next refresh window). The current
   * caller still receives the envelope; subsequent reads bypass the cached
   * bytes and re-run compute.
   */
  compute: () => Promise<{ payload: T; sourceUpdatedAt?: number | null; cacheable?: boolean }>;
  /** ms after generatedAt that the entry is considered fresh. Reads short-circuit during this window. */
  freshMs: number;
  /** ms after generatedAt that SWR stops being safe — reads block on recompute past this. */
  staleMs: number;
}

export interface ResponseCache {
  /**
   * SWR-style read. Always resolves to an envelope; the `state` field tells
   * the caller whether it served fresh, stale (background refresh in flight),
   * or cold-computed bytes.
   */
  read<T>(key: string, config: CacheKeyConfig<T>): Promise<CachedEnvelope<T>>;
  /**
   * Mark an entry stale so the next read does an SWR refresh. No-op when the
   * key isn't populated yet — cold reads will compute fresh anyway.
   */
  invalidate(key: string): void;
}

interface InternalEntry<T> {
  envelope: CachedEnvelope<T>;
  /** When a refresh is running, all concurrent reads await this. Cleared once the refresh resolves. */
  inFlight: Promise<CachedEnvelope<T>> | null;
}

/**
 * In-process implementation. State is a `Map<string, InternalEntry>` —
 * scoped to one server instance. Tests build their own and dispose with the
 * server; production wires one in `createServer` next to `AgentIdCache`.
 */
export class InProcessResponseCache implements ResponseCache {
  private readonly entries = new Map<string, InternalEntry<unknown>>();
  /** Override for tests; defaults to Date.now. Kept as a field, not a constructor arg, to avoid leaking it into the public API. */
  now: () => number = Date.now;

  async read<T>(key: string, config: CacheKeyConfig<T>): Promise<CachedEnvelope<T>> {
    const existing = this.entries.get(key) as InternalEntry<T> | undefined;
    const nowMs = this.now();

    if (existing) {
      // Fully fresh — serve and skip everything else.
      if (nowMs < existing.envelope.freshUntilMs) {
        return { ...existing.envelope, state: 'fresh' };
      }
      // Within the SWR window — return stale immediately and kick the refresh
      // (single-flight: a refresh already running is reused).
      if (nowMs < existing.envelope.staleUntilMs) {
        if (!existing.inFlight) {
          existing.inFlight = this.refresh(key, config, existing);
          // The refresh runs in the background; failures must not propagate
          // here (the caller already has stale bytes to return).
          existing.inFlight.catch((err) => {
            console.warn(`[network-stats] background refresh failed for ${key}:`, err);
          });
        }
        return { ...existing.envelope, state: 'stale' };
      }
      // Past staleMs — too old to serve. Fall through to a blocking recompute,
      // but coalesce with any already-running refresh. Concurrent readers that
      // arrive during a cold compute also land here: they see the placeholder
      // entry (freshUntilMs/staleUntilMs both 0) with `inFlight` set, and
      // share the in-flight promise instead of starting a second compute.
      if (existing.inFlight) {
        const refreshed = await existing.inFlight;
        return { ...refreshed, state: 'fresh' };
      }
    }

    // Cold path: no entry, or entry is past staleMs. Block on compute and
    // share the in-flight promise with any concurrent reads via the Map.
    const entry: InternalEntry<T> = existing ?? {
      // The placeholder envelope is only ever read via `inFlight` above — its
      // fields don't reach the wire because callers always await the promise.
      envelope: {
        payload: undefined as unknown as T,
        generatedAt: 0,
        sourceUpdatedAt: null,
        freshUntilMs: 0,
        staleUntilMs: 0,
        etag: '',
        state: 'cold',
      },
      inFlight: null,
    };
    if (!existing) this.entries.set(key, entry as InternalEntry<unknown>);
    entry.inFlight = this.refresh(key, config, entry);
    const fresh = await entry.inFlight;
    // `existing` was a real previously-cached entry only when generatedAt > 0;
    // a placeholder we just installed counts as cold.
    return { ...fresh, state: existing ? 'fresh' : 'cold' };
  }

  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    // Force the next read into the SWR branch without dropping the cached
    // bytes — we still want to serve them as `stale` while the refresh runs.
    entry.envelope = { ...entry.envelope, freshUntilMs: 0 };
  }

  /**
   * Single recompute. Updates the entry in place so concurrent readers see
   * the fresh envelope as soon as it lands. Always clears `inFlight` — even
   * on failure, so a transient SQL error doesn't wedge the slot.
   */
  private async refresh<T>(
    key: string,
    config: CacheKeyConfig<T>,
    entry: InternalEntry<T>,
  ): Promise<CachedEnvelope<T>> {
    try {
      const { payload, sourceUpdatedAt, cacheable } = await config.compute();
      const generatedAt = this.now();
      const envelope: CachedEnvelope<T> = {
        payload,
        generatedAt,
        sourceUpdatedAt: sourceUpdatedAt ?? null,
        freshUntilMs: generatedAt + config.freshMs,
        staleUntilMs: generatedAt + config.staleMs,
        etag: hashPayload(payload),
        state: 'fresh',
      };
      if (cacheable !== false) {
        entry.envelope = envelope;
        this.entries.set(key, entry as InternalEntry<unknown>);
      } else if (entry.envelope.generatedAt === 0) {
        // Cold-start refresh that explicitly opted out of caching. Drop the
        // placeholder slot so the next read goes through cold-path compute
        // instead of serving the synthesized envelope as if it were stored.
        this.entries.delete(key);
      }
      // else: slot had a previously-cached successful payload — keep it as
      // the SWR fallback and let the next read decide whether to retry.
      return envelope;
    } finally {
      entry.inFlight = null;
    }
  }
}

/** Stable, content-addressed ETag. Hashing the JSON guarantees identical
 * payloads across recomputes share an ETag, so browsers/proxies can 304
 * even when the cache slot was repopulated with byte-identical bytes. */
export function hashPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  return createHash('sha1').update(json).digest('hex').slice(0, 16);
}

/**
 * One-line response writer for cache-backed routes. Sets ETag,
 * Cache-Control (max-age + stale-while-revalidate computed from the live
 * envelope), X-Cache-State, X-Data-Updated-At, and short-circuits to 304
 * when the client's If-None-Match matches.
 */
export function sendCachedJson<T>(req: Request, res: Response, envelope: CachedEnvelope<T>): void {
  const etag = `"${envelope.etag}"`;
  res.setHeader('ETag', etag);
  res.setHeader('X-Cache-State', envelope.state);
  if (envelope.sourceUpdatedAt !== null) {
    res.setHeader('X-Data-Updated-At', new Date(envelope.sourceUpdatedAt).toISOString());
  }

  const nowMs = Date.now();
  // max-age = remaining freshness budget. Clamp to 0 for stale/cold so clients
  // and proxies revalidate promptly. SWR window = remaining stale budget,
  // which gives downstream caches room to serve stale during their own SWR.
  const maxAgeSec = Math.max(0, Math.floor((envelope.freshUntilMs - nowMs) / 1000));
  const swrSec = Math.max(0, Math.floor((envelope.staleUntilMs - nowMs) / 1000));
  res.setHeader(
    'Cache-Control',
    `public, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`,
  );

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.json(envelope.payload);
}

/**
 * Send a sub-payload projected from a cached union envelope. The freshness /
 * state / sourceUpdatedAt budget tracks the underlying slot; the ETag is
 * rehashed against the projected bytes so each sub-route gets a distinct
 * ETag (the bytes differ from the union and from each other).
 */
export function sendProjectedJson<T, U>(
  req: Request,
  res: Response,
  envelope: CachedEnvelope<T>,
  project: (payload: T) => U,
): void {
  const projected = project(envelope.payload);
  sendCachedJson(req, res, { ...envelope, payload: projected, etag: hashPayload(projected) });
}

/**
 * Merge two envelopes for a legacy union route. Freshness is bounded by the
 * stricter sub-slot (older freshUntilMs / staleUntilMs); sourceUpdatedAt
 * takes the newer non-null timestamp; state falls back to the worst across
 * the two slots (cold > stale > fresh). The merged ETag is a fresh hash of
 * the merged payload — distinct from either source slot.
 */
export function mergeEnvelopes<A, B, C>(
  a: CachedEnvelope<A>,
  b: CachedEnvelope<B>,
  merge: (a: A, b: B) => C,
): CachedEnvelope<C> {
  const payload = merge(a.payload, b.payload);
  const worstState: CacheState =
    a.state === 'cold' || b.state === 'cold'
      ? 'cold'
      : a.state === 'stale' || b.state === 'stale'
        ? 'stale'
        : 'fresh';
  return {
    payload,
    generatedAt: Math.max(a.generatedAt, b.generatedAt),
    sourceUpdatedAt:
      a.sourceUpdatedAt !== null && b.sourceUpdatedAt !== null
        ? Math.max(a.sourceUpdatedAt, b.sourceUpdatedAt)
        : a.sourceUpdatedAt ?? b.sourceUpdatedAt,
    freshUntilMs: Math.min(a.freshUntilMs, b.freshUntilMs),
    staleUntilMs: Math.min(a.staleUntilMs, b.staleUntilMs),
    etag: hashPayload(payload),
    state: worstState,
  };
}

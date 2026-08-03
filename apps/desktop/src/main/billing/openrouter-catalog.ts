/**
 * OpenRouter reference-price catalog.
 *
 * Fetches the public OpenRouter model list and derives per-model retail pricing
 * (USD per million tokens) that the renderer strikes through on the VPR Home
 * "Popular" list as a savings baseline. Cached in-memory with a TTL so we don't
 * hammer the endpoint on every discover refresh. All failures degrade to an
 * empty map — the UI simply omits the struck-through baseline.
 */

import { normalizeModelKey } from '../../shared/model-key.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FAILURE_BACKOFF_MS = 60 * 1000; // retry soon after a failed/empty fetch
const FETCH_TIMEOUT_MS = 8000;

/** USD per million tokens. `null` when OpenRouter doesn't price that dimension. */
export type OpenRouterReferencePrice = {
  input: number | null;
  output: number | null;
  /** Cache-read price; null when the model has no cache discount listed. */
  cachedInput: number | null;
};

export type OpenRouterReferenceMap = Record<string, OpenRouterReferencePrice>;

type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown } | null;
};

let cache: { at: number; map: OpenRouterReferenceMap } | null = null;
let inflight: Promise<OpenRouterReferenceMap> | null = null;
let lastFailedAt = 0;

function perMillion(pricePerToken: unknown): number | null {
  const numeric = typeof pricePerToken === 'string' ? Number(pricePerToken) : Number(pricePerToken);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric * 1_000_000;
}

function buildMap(models: OpenRouterModel[]): OpenRouterReferenceMap {
  const map: OpenRouterReferenceMap = {};
  for (const model of models) {
    const price: OpenRouterReferencePrice = {
      input: perMillion(model.pricing?.prompt),
      output: perMillion(model.pricing?.completion),
      cachedInput: perMillion(model.pricing?.input_cache_read),
    };
    if (price.input === null && price.output === null) continue;
    for (const raw of [model.id, model.name]) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue;
      const key = normalizeModelKey(raw);
      // First match wins; ids are listed before names so canonical ids win ties.
      if (key && !map[key]) map[key] = price;
    }
  }
  return map;
}

async function fetchReferenceMap(): Promise<OpenRouterReferenceMap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return {};
    const body = (await response.json()) as { data?: unknown };
    const models = Array.isArray(body?.data) ? (body.data as OpenRouterModel[]) : [];
    return buildMap(models);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the cached reference-price map, refreshing it in the background when
 * stale. Concurrent callers share a single in-flight request.
 */
export async function getOpenRouterReferencePrices(): Promise<OpenRouterReferenceMap> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;
  if (inflight) return inflight;
  // After a failed/empty fetch, back off briefly instead of hammering the
  // endpoint on every call; serve stale data (or nothing) in the meantime.
  if (lastFailedAt && now - lastFailedAt < FAILURE_BACKOFF_MS) return cache?.map ?? {};
  inflight = fetchReferenceMap()
    .then((map) => {
      if (Object.keys(map).length > 0) {
        // Only a non-empty result counts as success; never seed the 6h TTL
        // cache with an empty map (e.g. a cold-start fetch failure), and never
        // overwrite good data with a transient failure.
        cache = { at: Date.now(), map };
        lastFailedAt = 0;
      } else {
        lastFailedAt = Date.now();
      }
      return cache?.map ?? map;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

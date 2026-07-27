import type { VprModelCatalogEntry } from '../../core/state';
import { normalizeModelKey } from '../../../shared/model-key.js';

/**
 * Renderer-side cache + application of OpenRouter reference prices.
 *
 * The main process fetches the OpenRouter model catalog (see
 * `main/billing/openrouter-catalog.ts`); this module caches the resulting map in the
 * renderer and stamps matching `baseline*` prices onto VPR catalog entries so
 * the Home "Popular" list can strike through a retail baseline. Everything
 * degrades gracefully: no match / no cache → entries pass through unchanged.
 */

type ReferencePrice = { input: number | null; output: number | null };
type ReferenceMap = Record<string, ReferencePrice>;

let cachedMap: ReferenceMap | null = null;
let inflight: Promise<ReferenceMap | null> | null = null;

export function getCachedOpenRouterPrices(): ReferenceMap | null {
  return cachedMap;
}

/**
 * Warm the reference-price cache from the main process. Concurrent callers
 * share one request; resolves to the map (or `null` if unavailable).
 */
export async function ensureOpenRouterPrices(): Promise<ReferenceMap | null> {
  if (cachedMap) return cachedMap;
  if (inflight) return inflight;
  const bridge = window.antseedDesktop;
  if (!bridge?.getOpenRouterReferencePrices) return null;
  inflight = bridge
    .getOpenRouterReferencePrices()
    .then((map) => {
      const result: ReferenceMap = map ?? {};
      // Only cache a non-empty map — an empty result means the main process
      // couldn't fetch prices, and caching it would make the failure terminal.
      // Leaving cachedMap unset lets later calls re-request.
      if (Object.keys(result).length > 0) cachedMap = result;
      return cachedMap ?? result;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Return a copy of `catalog` with `baselineInput/OutputUsdPerMillion` populated
 * from the reference map where the model label matches. Only stamps a baseline
 * when it is strictly higher than the live min price (so we never show a
 * "discount" that isn't one).
 */
export function applyOpenRouterBaselines(
  catalog: VprModelCatalogEntry[],
  map: ReferenceMap | null,
): VprModelCatalogEntry[] {
  if (!map || Object.keys(map).length === 0) return catalog;
  return catalog.map((entry) => {
    const ref = map[normalizeModelKey(entry.label)] ?? map[normalizeModelKey(entry.serviceId)];
    if (!ref) return entry;

    const baselineInput =
      ref.input !== null && (entry.minInputUsdPerMillion === null || ref.input > entry.minInputUsdPerMillion)
        ? ref.input
        : null;
    const baselineOutput =
      ref.output !== null && (entry.minOutputUsdPerMillion === null || ref.output > entry.minOutputUsdPerMillion)
        ? ref.output
        : null;

    if (baselineInput === null && baselineOutput === null) return entry;
    return {
      ...entry,
      baselineInputUsdPerMillion: baselineInput,
      baselineOutputUsdPerMillion: baselineOutput,
    };
  });
}

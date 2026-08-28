export type NetworkStatsMap = Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>;

/**
 * Fetches per-seller on-chain stats from the chain explorer (Antscan).
 * GET {explorerApiUrl}/api/sellers returns every settled seller with
 * agentId/requestCount/inputTokens/outputTokens — ~20KB vs the ~400KB
 * aggregator snapshot. Same failure contract as fetchNetworkStats: any
 * problem returns an empty map.
 */
export async function fetchNetworkStatsFromExplorer(
  explorerApiUrl: string | undefined,
): Promise<NetworkStatsMap> {
  const empty: NetworkStatsMap = new Map();
  if (!explorerApiUrl) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(`${explorerApiUrl.replace(/\/+$/, '')}/api/sellers`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[pi-chat] explorer sellers ${res.status} ${res.statusText}`);
      return empty;
    }
    const body = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(body)) {
      console.warn('[pi-chat] explorer sellers: unexpected payload shape');
      return empty;
    }

    const out: NetworkStatsMap = new Map();
    for (const seller of body) {
      const agentId = Number(seller['agentId']);
      if (!Number.isFinite(agentId) || agentId <= 0) continue;
      try {
        out.set(agentId, {
          requests: BigInt(String(seller['requestCount'])),
          inputTokens: BigInt(String(seller['inputTokens'])),
          outputTokens: BigInt(String(seller['outputTokens'])),
        });
      } catch {
        // malformed numeric string — skip this seller, don't poison the whole map
      }
    }
    return out;
  } catch (err) {
    console.warn('[pi-chat] explorer sellers fetch failed:', err);
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

const NETWORK_STATS_TTL_MS = 60_000;
const NETWORK_STATS_FAILURE_COOLDOWN_MS = 30_000;
// All state is keyed by the URL pair so a chain-config switch mid-fetch can't
// serve the previous chain's stats or inherit its failure cooldown.
const networkStatsCache = new Map<string, { fetchedAtMs: number; map: NetworkStatsMap }>();
const networkStatsInFlight = new Map<string, Promise<NetworkStatsMap>>();
const networkStatsLastFailureAt = new Map<string, number>();

/** Test-only: drop the module-level cache so runs don't leak into each other. */
export function resetNetworkStatsCache(): void {
  networkStatsCache.clear();
  networkStatsInFlight.clear();
  networkStatsLastFailureAt.clear();
}

/**
 * Cached network stats: explorer (Antscan /api/sellers) first, the
 * network-stats aggregator as fallback. Lifetime counters move slowly, so a
 * fresh result is reused for 60s and concurrent callers share one fetch —
 * the service-discovery refresh cycle no longer pays for this on every pass.
 * When both sources fail, the last good map is served stale rather than
 * blanking the stats, and no refresh is retried for 30s so an unreachable
 * network doesn't tax every cycle.
 *
 * opts.budgetMs puts a hard cap on how long the caller waits: past it the
 * best available map (stale or empty) is returned while the refresh keeps
 * running in the background for the next call. The cap holds even when a
 * fetch ignores its abort signal.
 */
export async function getNetworkStats(urls: {
  explorerApiUrl?: string;
  networkStatsUrl?: string;
}, opts: { budgetMs?: number } = {}): Promise<NetworkStatsMap> {
  const key = `${urls.explorerApiUrl ?? ''}|${urls.networkStatsUrl ?? ''}`;
  const stale = (): NetworkStatsMap => networkStatsCache.get(key)?.map ?? new Map();
  const cached = networkStatsCache.get(key);
  if (cached && Date.now() - cached.fetchedAtMs < NETWORK_STATS_TTL_MS) {
    return cached.map;
  }

  let inFlight = networkStatsInFlight.get(key);
  if (!inFlight) {
    if (Date.now() - (networkStatsLastFailureAt.get(key) ?? 0) < NETWORK_STATS_FAILURE_COOLDOWN_MS) {
      return stale();
    }
    inFlight = (async () => {
      let map = await fetchNetworkStatsFromExplorer(urls.explorerApiUrl);
      if (map.size === 0) map = await fetchNetworkStats(urls.networkStatsUrl);
      if (map.size > 0) {
        networkStatsCache.set(key, { fetchedAtMs: Date.now(), map });
        return map;
      }
      networkStatsLastFailureAt.set(key, Date.now());
      return stale();
    })().finally(() => { networkStatsInFlight.delete(key); });
    networkStatsInFlight.set(key, inFlight);
  }

  if (opts.budgetMs === undefined) return inFlight;
  return new Promise<NetworkStatsMap>((resolve) => {
    const timer = setTimeout(() => { resolve(stale()); }, opts.budgetMs);
    inFlight.then(
      (map) => { clearTimeout(timer); resolve(map); },
      () => { clearTimeout(timer); resolve(stale()); },
    );
  });
}

/**
 * Fetches network-wide per-agent stats from the @antseed/network-stats aggregator.
 * On any failure (unset URL, timeout, non-2xx, JSON parse error, unexpected shape),
 * returns an empty map so callers fall back field-by-field to local stats.
 */
export async function fetchNetworkStats(
  networkStatsUrl: string | undefined,
): Promise<Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>> {
  const empty = new Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>();
  if (!networkStatsUrl) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(`${networkStatsUrl.replace(/\/+$/, '')}/stats`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[pi-chat] network-stats ${res.status} ${res.statusText}`);
      return empty;
    }
    const body = (await res.json()) as { peers?: Array<Record<string, unknown>> };
    if (!Array.isArray(body?.peers)) {
      console.warn('[pi-chat] network-stats: unexpected payload shape');
      return empty;
    }

    const out = new Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>();
    for (const peer of body.peers) {
      const stats = peer['onChainStats'] as Record<string, unknown> | null | undefined;
      if (!stats) continue;
      const agentId = Number(stats['agentId']);
      if (!Number.isFinite(agentId) || agentId <= 0) continue;
      try {
        out.set(agentId, {
          requests: BigInt(String(stats['totalRequests'])),
          inputTokens: BigInt(String(stats['totalInputTokens'])),
          outputTokens: BigInt(String(stats['totalOutputTokens'])),
        });
      } catch {
        // malformed numeric string — skip this peer, don't poison the whole map
      }
    }
    return out;
  } catch (err) {
    console.warn('[pi-chat] network-stats fetch failed:', err);
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

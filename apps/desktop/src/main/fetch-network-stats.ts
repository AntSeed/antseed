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

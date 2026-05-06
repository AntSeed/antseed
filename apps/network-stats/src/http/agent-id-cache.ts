import type { StakingClient } from '@antseed/node';

import { mapWithConcurrency, normalizeAddress } from '../utils.js';

const UNSTAKED_TTL_MS = 5 * 60 * 1000;
const AGENT_ID_LOOKUP_CONCURRENCY = 8;

interface CacheEntry {
  agentId: number;
  // null = never expires (staked entries — agentId assignments don't change).
  // a number = unix ms after which the entry must be re-fetched.
  expiresAt: number | null;
}

function isFresh(entry: CacheEntry, nowMs: number): boolean {
  return entry.expiresAt === null || entry.expiresAt > nowMs;
}

/**
 * Resolves and caches `address → agentId` lookups against the staking
 * contract. Per-instance by design: keeps tests and colocated servers isolated;
 * the address universe is bounded by recently observed peers.
 *
 * Caching rules:
 *   - Staked peers (agentId != 0) → cached indefinitely (assignments are stable).
 *   - Unstaked peers (agentId == 0) → short TTL so newly-staked peers appear soon.
 *   - RPC failures → not cached so the next poll retries cleanly.
 */
export class AgentIdCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly client: StakingClient) {}

  async resolve(address: string | null | undefined): Promise<number | null> {
    const key = normalizeAddress(address);
    if (!key) return null;
    const cached = this.entries.get(key);
    if (cached !== undefined && isFresh(cached, Date.now())) return cached.agentId;
    try {
      const agentId = await this.client.getAgentId(key);
      this.entries.set(key, {
        agentId,
        expiresAt: agentId === 0 ? Date.now() + UNSTAKED_TTL_MS : null,
      });
      return agentId;
    } catch (err) {
      console.warn(`[network-stats] getAgentId failed for ${key}:`, err);
      return null;
    }
  }

  /**
   * Resolve a batch of addresses, deduped, with bounded concurrency. Returns a
   * Map keyed by the *normalized* address (lowercase, 0x-prefixed) plus a
   * `hadFailure` flag — true if any RPC lookup failed (yielded null). Callers
   * use the flag to mark cache slots non-storable (`cacheable: false`) so a
   * partial result doesn't poison the slot until the next refresh.
   */
  async resolveMany(
    addresses: readonly (string | null)[],
  ): Promise<{ map: Map<string, number | null>; hadFailure: boolean }> {
    const unique = [...new Set(addresses.filter((a): a is string => a !== null))];
    const entries = await mapWithConcurrency(
      unique,
      AGENT_ID_LOOKUP_CONCURRENCY,
      async (address) => [address, await this.resolve(address)] as const,
    );
    const map = new Map(entries);
    const hadFailure = entries.some(([, agentId]) => agentId === null);
    return { map, hadFailure };
  }
}

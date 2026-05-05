/**
 * Single-slot TTL memoization. The /insights endpoint re-runs SQL across all
 * sellers + sorts on every hit; with a 30s web poll a short TTL is pure win
 * (the freshness budget for the derivations is well above 15s — they're
 * driven by the indexer's per-tick state which advances at minute cadence).
 */
export class TtlCache<T> {
  private slot: { computedAt: number; payload: T } | null = null;

  constructor(private readonly ttlMs: number) {}

  get(): T | null {
    if (!this.slot) return null;
    if (Date.now() - this.slot.computedAt >= this.ttlMs) return null;
    return this.slot.payload;
  }

  set(payload: T): void {
    this.slot = { computedAt: Date.now(), payload };
  }
}

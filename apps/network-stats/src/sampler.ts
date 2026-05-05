/**
 * HistorySampler
 *
 * Encapsulates the live "ts=now" sampling that runs alongside the indexer:
 *
 *   - on every successful poll: record one network_history sample (peer count
 *     refreshed) and one peer_pricing_history sample per (peer, provider, svc)
 *   - on a fixed timer (1 min): record one network_history sample so the chart
 *     fills in between polls, plus per-seller activity snapshots when totals
 *     have actually changed
 *
 * Three coordination concerns the standalone functions in index.ts had to
 * juggle, all collapsed into one place here:
 *
 *   1. The DHT hasn't been observed before the first poll completes — until
 *      then, peers.length is structurally 0, so we write a sentinel instead
 *      of a misleading zero.
 *   2. Backfill writes rows with backdated timestamps; "ts=now" rows must
 *      wait until backfill resolves so the table stays monotonic-by-ts (the
 *      /insights velocity windows blow up on non-monotonic input).
 *   3. Per-seller dedup — avoid issuing a SELECT+INSERT against
 *      seller_activity_history every minute for sellers whose totals haven't
 *      changed.
 */

import type { NetworkSnapshot } from './poller.js';
import { ACTIVE_PEERS_UNKNOWN, type SqliteStore } from './store.js';

const SELLER_ACTIVITY_WINDOW_SECONDS = 8 * 86400;

export class HistorySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollHasCompleted = false;
  private backfillResolved = false;
  // Bounded by the active seller set (we filter dormant sellers before this
  // map), so unbounded growth is not a concern.
  private readonly lastActivitySigByAgent = new Map<number, string>();

  constructor(
    private readonly store: SqliteStore,
    private readonly getPeerCount: () => number,
    private readonly intervalMs: number,
  ) {}

  /** Begin periodic sampling. The first tick won't write until backfillResolved. */
  start(): void {
    // Deliberately no immediate sample on startup: on a fresh DB,
    // getNetworkTotals() is 0 before backfill applies any events, so an
    // immediate sample would land a (ts=now, cum=0) row that gets sandwiched
    // after the backdated backfill rows once they're written. The first
    // interval fire (60s in by default) is enough lead time for the backfill
    // to have touched at least one chunk.
    this.timer = setInterval(() => this.recordNow(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Hooked to the poller's onPollComplete. Marks the first-poll boundary
   * (peer count is now real, not structurally-0), records a network sample,
   * and persists the per-peer pricing samples.
   */
  onPollComplete(snapshot: NetworkSnapshot): void {
    this.pollHasCompleted = true;
    this.recordNow();
    this.recordPriceSamples(snapshot);
  }

  /**
   * Called by the bootstrap code once the chain backfill promise settles
   * (success, failure, or skipped). Until this fires, recordNow() is a no-op
   * — backfill writes backdated rows that must land before any "ts=now" row
   * to keep the table monotonic-by-ts.
   */
  markBackfillResolved(): void {
    this.backfillResolved = true;
  }

  private recordNow(): void {
    if (!this.backfillResolved) return;
    const tsSec = Math.floor(Date.now() / 1000);

    try {
      const totals = this.store.getNetworkTotals();
      // Sentinel until the first poll completes — the chart renders null
      // instead of a misleading zero.
      const activePeers = this.pollHasCompleted ? this.getPeerCount() : ACTIVE_PEERS_UNKNOWN;
      this.store.recordHistorySample({
        ts: tsSec,
        activePeers,
        sellerCount: totals.sellerCount,
        totalRequests: totals.totalRequests,
        totalInputTokens: totals.totalInputTokens,
        totalOutputTokens: totals.totalOutputTokens,
        settlementCount: totals.settlementCount,
      });
    } catch (err) {
      // Don't let a transient sqlite error (lock contention with the indexer,
      // disk pressure) tear down the timer or, worse, the process.
      console.error('[network-stats] recordHistorySample failed:', err);
    }

    this.recordSellerActivitySamples(tsSec);
  }

  /**
   * Per-seller activity samples. Two filters before the SQL fires:
   *   1. Skip sellers dormant past the trending window — trending only ever
   *      diffs the last 8 days, so a no-op row past that is wasted work.
   *   2. Skip sellers whose totals match the last signature we recorded —
   *      avoids a SELECT+(no-op-INSERT) per idle seller per minute.
   */
  private recordSellerActivitySamples(tsSec: number): void {
    const activeCutoff = tsSec - SELLER_ACTIVITY_WINDOW_SECONDS;
    try {
      for (const seller of this.store.getAllSellerTotalsWithIds()) {
        if (seller.lastSeenAt === null || seller.lastSeenAt < activeCutoff) continue;
        const sig = `${seller.totalRequests}|${seller.totalInputTokens}|${seller.totalOutputTokens}|${seller.settlementCount}`;
        if (this.lastActivitySigByAgent.get(seller.agentId) === sig) continue;
        this.store.recordSellerActivitySample({
          agentId: seller.agentId,
          ts: tsSec,
          totalRequests: seller.totalRequests,
          totalInputTokens: seller.totalInputTokens,
          totalOutputTokens: seller.totalOutputTokens,
          settlementCount: seller.settlementCount,
        });
        this.lastActivitySigByAgent.set(seller.agentId, sig);
      }
    } catch (err) {
      console.error('[network-stats] recordSellerActivitySample failed:', err);
    }
  }

  /**
   * After every successful poll, walk the snapshot and record one price
   * sample per (peer, provider, service) the seller announced. The store
   * dedups on equal prices, so this is cheap when nothing changes — only
   * actual price movements end up as new rows.
   */
  private recordPriceSamples(snapshot: NetworkSnapshot): void {
    const tsSec = Math.floor(Date.now() / 1000);
    try {
      for (const peer of snapshot.peers) {
        // peerId is already 40 hex lowercased without 0x — the canonical form.
        const peerId = typeof peer.peerId === 'string' ? peer.peerId : null;
        if (!peerId) continue;
        for (const provider of peer.providers) {
          for (const service of provider.services) {
            const pricing = provider.servicePricing?.[service] ?? provider.defaultPricing;
            if (!pricing) continue;
            if (typeof pricing.inputUsdPerMillion !== 'number') continue;
            if (typeof pricing.outputUsdPerMillion !== 'number') continue;
            this.store.recordPriceSample({
              peerId,
              provider: provider.provider,
              service,
              ts: tsSec,
              inputUsdPerMillion: pricing.inputUsdPerMillion,
              outputUsdPerMillion: pricing.outputUsdPerMillion,
              cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion ?? null,
            });
          }
        }
      }
    } catch (err) {
      console.error('[network-stats] recordPriceSample failed:', err);
    }
  }
}

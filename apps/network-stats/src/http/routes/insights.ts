import type { Express } from 'express';

import type { NetworkPoller } from '../../poller.js';
import type { SqliteStore } from '../../store.js';
import { computeInsights, type NetworkInsights } from '../../insights.js';
import { getPeerLookupAddress } from '../../utils.js';
import type { AgentIdCache } from '../agentIdCache.js';
import { asyncHandler } from '../middleware.js';
import { TtlCache } from '../ttlCache.js';

// Velocity needs at least 2× the longest window so growth-pct denominators
// have somewhere to land — we expose a 7d window, so request 14d of history.
const INSIGHTS_HISTORY_WINDOW_SECONDS = 14 * 86400;
// Stability/movers compare prices across this window; matches the constant
// in insights.ts (PRICE_STABILITY_WINDOW_SECONDS) so the SQL filter and the
// computed-window-seconds field stay in sync.
const INSIGHTS_PRICE_WINDOW_SECONDS = 30 * 86400;
// Trending compares last 24h vs prior 7d, so we need 8d of seller activity.
const INSIGHTS_ACTIVITY_WINDOW_SECONDS = 8 * 86400;
const INSIGHTS_CACHE_TTL_MS = 15_000;

export interface InsightsRouteDeps {
  poller: NetworkPoller;
  store?: SqliteStore;
  agentIds?: AgentIdCache;
}

export function registerInsightsRoutes(app: Express, deps: InsightsRouteDeps): void {
  const { poller, store, agentIds } = deps;
  const cache = new TtlCache<NetworkInsights>(INSIGHTS_CACHE_TTL_MS);

  // All five routes share this loader. The TtlCache memoizes the union
  // payload, so a dashboard that fans out to three sub-routes on first paint
  // pays the SQL cost once. The DHT-only fallback (no store/agentIds) still
  // produces a usable union — sub-routes just project from it.
  async function loadInsights(): Promise<NetworkInsights> {
    const cached = cache.get();
    if (cached) return cached;
    const snapshot = poller.getSnapshot();

    if (!store || !agentIds) {
      const payload = computeInsights({
        peers: snapshot.peers,
        sellerTotals: [],
        agentIdByPeerAddress: new Map(),
        history: [],
        priceVolatility: [],
        sellerActivity: [],
      });
      cache.set(payload);
      return payload;
    }

    const peerLookupAddresses = snapshot.peers.map(getPeerLookupAddress);
    const agentIdByPeerAddress = await agentIds.resolveMany(peerLookupAddresses);

    const sellerTotals = store.getAllSellerTotalsWithIds();
    const history = store.getHistorySince(INSIGHTS_HISTORY_WINDOW_SECONDS);
    const nowSec = Math.floor(Date.now() / 1000);
    const priceVolatility = store.getPriceVolatility(nowSec - INSIGHTS_PRICE_WINDOW_SECONDS);
    const sellerActivity = store.getSellerActivityForTrending(nowSec - INSIGHTS_ACTIVITY_WINDOW_SECONDS);

    const payload = computeInsights({
      peers: snapshot.peers,
      sellerTotals,
      agentIdByPeerAddress,
      history,
      priceVolatility,
      sellerActivity,
    });
    cache.set(payload);
    return payload;
  }

  // Legacy union — kept for back-compat. New clients should fetch only the
  // sub-route(s) they render.
  app.get('/insights', asyncHandler(async (_req, res) => {
    res.json(await loadInsights());
  }));

  app.get('/insights/leaderboards', asyncHandler(async (_req, res) => {
    const { generatedAt, leaderboards } = await loadInsights();
    res.json({ generatedAt, leaderboards });
  }));

  // Pricing groups everything price-shaped — the per-service market summary
  // and the stability/movers tables all answer "what's happening to prices".
  app.get('/insights/pricing', asyncHandler(async (_req, res) => {
    const { generatedAt, pricing, priceStability, priceMovers } = await loadInsights();
    res.json({ generatedAt, pricing, priceStability, priceMovers });
  }));

  // Network composition — what's running where, plus how unevenly the load
  // is distributed across sellers.
  app.get('/insights/services', asyncHandler(async (_req, res) => {
    const { generatedAt, services, regions, concentration } = await loadInsights();
    res.json({ generatedAt, services, regions, concentration });
  }));

  // "What's happening right now" — live presence + period deltas.
  app.get('/insights/activity', asyncHandler(async (_req, res) => {
    const { generatedAt, velocity, activity } = await loadInsights();
    res.json({ generatedAt, velocity, activity });
  }));
}

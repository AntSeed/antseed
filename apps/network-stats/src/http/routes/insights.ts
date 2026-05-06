import type { Express } from 'express';

import type { NetworkPoller } from '../../poller.js';
import type { SqliteStore } from '../../store.js';
import { computeInsights, type NetworkInsights } from '../../insights.js';
import { getPeerLookupAddress, snapshotUpdatedAtMs } from '../../utils.js';
import type { AgentIdCache } from '../agent-id-cache.js';
import { INSIGHTS_CACHE_KEY } from '../cache-keys.js';
import { asyncHandler } from '../middleware.js';
import {
  sendCachedJson,
  sendProjectedJson,
  type CachedEnvelope,
  type ResponseCache,
} from '../response-cache.js';

// Velocity needs at least 2× the longest window so growth-pct denominators
// have somewhere to land — we expose a 7d window, so request 14d of history.
const INSIGHTS_HISTORY_WINDOW_SECONDS = 14 * 86400;
// Stability/movers compare prices across this window; matches the constant
// in insights.ts (PRICE_STABILITY_WINDOW_SECONDS) so the SQL filter and the
// computed-window-seconds field stay in sync.
const INSIGHTS_PRICE_WINDOW_SECONDS = 30 * 86400;
// Trending compares last 24h vs prior 7d, so we need 8d of seller activity.
const INSIGHTS_ACTIVITY_WINDOW_SECONDS = 8 * 86400;
// Freshness budget: route returns cached bytes without revalidating during
// this window. Matches the dashboard's polling cadence — most clients hit a
// fresh slot.
const INSIGHTS_FRESH_MS = 15_000;
// SWR window: past freshness, the route still serves cached bytes immediately
// and triggers a single background refresh. Past staleMs, the route blocks on
// recompute. Generous because insights tolerate minutes of lag — the data is
// driven by the indexer's per-tick state which advances at minute cadence.
const INSIGHTS_STALE_MS = 10 * 60_000;

export interface InsightsRouteDeps {
  poller: NetworkPoller;
  store?: SqliteStore;
  agentIds?: AgentIdCache;
  cache: ResponseCache;
}

export function registerInsightsRoutes(app: Express, deps: InsightsRouteDeps): void {
  const { poller, store, agentIds, cache } = deps;

  // Shared compute for all five routes. The cache memoizes the union payload,
  // so a dashboard that fans out to three sub-routes on first paint pays the
  // SQL cost once. The DHT-only fallback (no store/agentIds) still produces a
  // usable union — sub-routes just project from it.
  //
  // Returns `cacheable: false` when any agentId lookup returned null — same
  // partial-failure logic as /stats/peers; insights with broken peer→agent
  // mappings would surface incomplete leaderboards.
  async function computeInsightsPayload(): Promise<{
    payload: NetworkInsights;
    sourceUpdatedAt: number;
    cacheable: boolean;
  }> {
    const snapshot = poller.getSnapshot();
    const sourceUpdatedAt = snapshotUpdatedAtMs(snapshot);

    if (!store || !agentIds) {
      return {
        payload: computeInsights({
          peers: snapshot.peers,
          sellerTotals: [],
          agentIdByPeerAddress: new Map(),
          history: [],
          priceVolatility: [],
          sellerActivity: [],
        }),
        sourceUpdatedAt,
        cacheable: true,
      };
    }

    const peerLookupAddresses = snapshot.peers.map(getPeerLookupAddress);
    const { map: agentIdByPeerAddress, hadFailure } = await agentIds.resolveMany(peerLookupAddresses);

    const sellerTotals = store.getAllSellerTotalsWithIds();
    const history = store.getHistorySince(INSIGHTS_HISTORY_WINDOW_SECONDS);
    const nowSec = Math.floor(Date.now() / 1000);
    const priceVolatility = store.getPriceVolatility(nowSec - INSIGHTS_PRICE_WINDOW_SECONDS);
    const sellerActivity = store.getSellerActivityForTrending(
      nowSec - INSIGHTS_ACTIVITY_WINDOW_SECONDS,
    );

    return {
      payload: computeInsights({
        peers: snapshot.peers,
        sellerTotals,
        agentIdByPeerAddress,
        history,
        priceVolatility,
        sellerActivity,
      }),
      sourceUpdatedAt,
      cacheable: !hadFailure,
    };
  }

  function loadInsightsEnvelope(): Promise<CachedEnvelope<NetworkInsights>> {
    return cache.read<NetworkInsights>(INSIGHTS_CACHE_KEY, {
      compute: computeInsightsPayload,
      freshMs: INSIGHTS_FRESH_MS,
      staleMs: INSIGHTS_STALE_MS,
    });
  }

  // Legacy union — kept for back-compat. New clients should fetch only the
  // sub-route(s) they render.
  app.get('/insights', asyncHandler(async (req, res) => {
    sendCachedJson(req, res, await loadInsightsEnvelope());
  }));

  app.get('/insights/leaderboards', asyncHandler(async (req, res) => {
    const env = await loadInsightsEnvelope();
    sendProjectedJson(req, res, env, ({ generatedAt, leaderboards }) => ({
      generatedAt,
      leaderboards,
    }));
  }));

  // Pricing groups everything price-shaped — the per-service market summary
  // and the stability/movers tables all answer "what's happening to prices".
  app.get('/insights/pricing', asyncHandler(async (req, res) => {
    const env = await loadInsightsEnvelope();
    sendProjectedJson(req, res, env, ({ generatedAt, pricing, priceStability, priceMovers }) => ({
      generatedAt,
      pricing,
      priceStability,
      priceMovers,
    }));
  }));

  // Network composition — what's running where, plus how unevenly the load
  // is distributed across sellers.
  app.get('/insights/services', asyncHandler(async (req, res) => {
    const env = await loadInsightsEnvelope();
    sendProjectedJson(req, res, env, ({ generatedAt, services, regions, concentration }) => ({
      generatedAt,
      services,
      regions,
      concentration,
    }));
  }));

  // "What's happening right now" — live presence + period deltas.
  app.get('/insights/activity', asyncHandler(async (req, res) => {
    const env = await loadInsightsEnvelope();
    sendProjectedJson(req, res, env, ({ generatedAt, velocity, activity }) => ({
      generatedAt,
      velocity,
      activity,
    }));
  }));
}

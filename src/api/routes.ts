import { FastifyInstance } from 'fastify';
import type { DashboardConfig, NodeStatus } from '../types.js';
import { getNodeStatus } from '../status.js';
import { saveConfig } from '../config-io.js';
import { MeteringStorage } from 'antseed-node';
import { UsageAggregator } from 'antseed-node/metering';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { DHTQueryService, NetworkPeer, NetworkStats } from '../dht-query-service.js';

/** Internal readiness model for data sources */
export interface DataSourceReadiness {
  meteringDbAvailable: boolean;
  daemonStateAvailable: boolean;
  degradedReasons: string[];
}

/** Compute readiness state based on data source availability */
function computeReadiness(
  storage: MeteringStorage | null,
  daemonStateAvailable: boolean,
  meteringDbError: string | null = null,
): DataSourceReadiness {
  const degradedReasons: string[] = [];
  const meteringDbAvailable = storage !== null;

  if (!meteringDbAvailable) {
    if (meteringDbError && meteringDbError.trim().length > 0) {
      degradedReasons.push(`Metering database is unavailable: ${meteringDbError}`);
    } else {
      degradedReasons.push('Metering database is unavailable');
    }
  }
  if (!daemonStateAvailable) {
    degradedReasons.push('Daemon state file is unavailable');
  }

  return {
    meteringDbAvailable,
    daemonStateAvailable,
    degradedReasons,
  };
}

/** PeerInfo type for API responses */
export interface PeerInfo {
  peerId: string;
  providers: string[];
  capacityMsgPerHour: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  reputation: number;
  location: string | null;
  source?: 'daemon' | 'dht';
}

/** SessionMetrics type for API responses */
export interface SessionMetrics {
  sessionId: string;
  provider: string;
  startedAt: number;
  totalTokens: number;
  totalRequests: number;
  durationMs: number;
  avgLatencyMs: number;
  peerSwitches: number;
}

/** Response type for GET /api/status */
export interface StatusResponse extends NodeStatus {}

/** Response type for GET /api/peers */
export interface PeersResponse {
  peers: PeerInfo[];
  total: number;
  degraded: boolean;
}

/** Response type for GET /api/sessions */
export interface SessionsResponse {
  sessions: SessionMetrics[];
  total: number;
  degraded: boolean;
}

/** Response type for GET /api/earnings */
export interface EarningsResponse {
  today: string;
  thisWeek: string;
  thisMonth: string;
  /** Daily earnings for chart data: { date: "2026-02-16", amount: "1.23" }[] */
  daily: Array<{ date: string; amount: string }>;
  /** Per-provider breakdown: { provider: "anthropic", amount: "5.00" }[] */
  byProvider: Array<{ provider: string; amount: string }>;
  degraded: boolean;
}

/** Response type for GET /api/config */
export interface ConfigResponse {
  config: DashboardConfig;
}

/** Response type for GET /api/data-sources */
export interface DataSourcesResponse {
  meteringDbAvailable: boolean;
  daemonStateAvailable: boolean;
  degradedReasons: string[];
  timestamp: string;
}

/** Response type for GET /api/network */
export interface NetworkResponse {
  peers: NetworkPeer[];
  stats: NetworkStats;
}

/**
 * Register all dashboard API routes on the Fastify instance.
 */
export async function registerApiRoutes(
  app: FastifyInstance,
  config: DashboardConfig,
  dhtQueryService?: DHTQueryService,
  configPath?: string
): Promise<void> {
  const dbPath = join(homedir(), '.antseed', 'metering.db');
  let storage: MeteringStorage | null = null;
  let meteringDbError: string | null = null;
  try {
    storage = new MeteringStorage(dbPath);
  } catch (err) {
    meteringDbError = err instanceof Error ? err.message : String(err);
    // Metering DB not available — degraded mode will be used
  }
  const aggregator = new UsageAggregator();

  // Check daemon state availability at startup
  const stateFile = join(homedir(), '.antseed', 'daemon.state.json');
  let daemonStateAvailable = false;
  try {
    await readFile(stateFile, 'utf-8');
    daemonStateAvailable = true;
  } catch {
    // Daemon state file not available
  }

  // Compute initial readiness
  let readiness = computeReadiness(storage, daemonStateAvailable, meteringDbError);

  // GET /api/status - Current node status
  app.get<{ Reply: StatusResponse }>('/api/status', async (_req, reply) => {
    try {
      const status = await getNodeStatus(config);
      return reply.send(status);
    } catch (err) {
      return reply.code(500).send({ error: `Failed to get status: ${(err as Error).message}` } as any);
    }
  });

  // GET /api/data-sources - Data source health
  app.get<{ Reply: DataSourcesResponse }>('/api/data-sources', async (_req, reply) => {
    // Refresh daemon state availability on each request
    let currentDaemonStateAvailable = false;
    try {
      await readFile(stateFile, 'utf-8');
      currentDaemonStateAvailable = true;
    } catch {
      // Daemon state file not available
    }
    daemonStateAvailable = currentDaemonStateAvailable;
    readiness = computeReadiness(storage, daemonStateAvailable, meteringDbError);

    return reply.send({
      meteringDbAvailable: readiness.meteringDbAvailable,
      daemonStateAvailable: readiness.daemonStateAvailable,
      degradedReasons: readiness.degradedReasons,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/peers - Connected peers list (merged daemon + DHT)
  app.get<{ Reply: PeersResponse }>('/api/peers', async (_req, reply) => {
    try {
      const result = await getPeerList();

      // Merge DHT peers if available
      if (dhtQueryService) {
        const dhtPeers = dhtQueryService.getNetworkPeers();
        const merged = mergePeers(result.peers, dhtPeers);
        return reply.send({ peers: merged, total: merged.length, degraded: result.degraded });
      }

      return reply.send({ peers: result.peers, total: result.peers.length, degraded: result.degraded });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to get peers: ${(err as Error).message}` } as any);
    }
  });

  // GET /api/network - DHT network peers and stats
  app.get<{ Reply: NetworkResponse }>('/api/network', async (_req, reply) => {
    try {
      if (!dhtQueryService) {
        return reply.send({
          peers: [],
          stats: {
            totalPeers: 0,
            dhtNodeCount: 0,
            dhtHealthy: false,
            lastScanAt: null,
            totalLookups: 0,
            successfulLookups: 0,
            lookupSuccessRate: 0,
            averageLookupLatencyMs: 0,
            healthReason: 'dht query service unavailable',
          },
        });
      }

      // Also include daemon peers in the merged view
      const daemonResult = await getPeerList();
      const dhtPeers = dhtQueryService.getNetworkPeers();
      const stats = dhtQueryService.getNetworkStats();

      // Convert daemon peers to NetworkPeer format for merging
      const allPeers: NetworkPeer[] = daemonResult.peers.map((p) => ({
        peerId: p.peerId,
        host: '',
        port: 0,
        providers: p.providers,
        inputUsdPerMillion: p.inputUsdPerMillion,
        outputUsdPerMillion: p.outputUsdPerMillion,
        capacityMsgPerHour: p.capacityMsgPerHour,
        reputation: p.reputation,
        lastSeen: Date.now(),
        source: 'daemon' as const,
      }));

      // Add DHT peers, deduplicating by peerId
      const seen = new Set(allPeers.map((p) => p.peerId));
      for (const dp of dhtPeers) {
        if (!seen.has(dp.peerId)) {
          allPeers.push(dp);
          seen.add(dp.peerId);
        }
      }

      return reply.send({
        peers: allPeers,
        stats: { ...stats, totalPeers: allPeers.length },
      });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to get network: ${(err as Error).message}` } as any);
    }
  });

  // POST /api/network/scan - Trigger an immediate DHT scan
  app.post('/api/network/scan', async (_req, reply) => {
    if (!dhtQueryService) {
      return reply.code(503).send({ error: 'DHT query service not available' });
    }
    await dhtQueryService.scanNow();
    return reply.send({ success: true, stats: dhtQueryService.getNetworkStats() });
  });

  // GET /api/sessions - Session history
  app.get<{
    Querystring: { limit?: number; offset?: number; status?: string };
    Reply: SessionsResponse;
  }>('/api/sessions', async (req, reply) => {
    try {
      const { limit = 50, offset = 0, status } = req.query;
      const sessions = await getSessionList(storage, limit, offset, status);
      return reply.send({ sessions: sessions.items, total: sessions.total, degraded: !readiness.meteringDbAvailable });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to get sessions: ${(err as Error).message}` } as any);
    }
  });

  // GET /api/earnings - Earnings data for charts
  app.get<{
    Querystring: { period?: 'day' | 'week' | 'month' };
    Reply: EarningsResponse;
  }>('/api/earnings', async (req, reply) => {
    try {
      const earnings = await getEarningsData(storage, aggregator, req.query.period ?? 'month');
      return reply.send({ ...earnings, degraded: !readiness.meteringDbAvailable });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to get earnings: ${(err as Error).message}` } as any);
    }
  });

  // GET /api/config - Current config (redacted)
  app.get<{ Reply: ConfigResponse }>('/api/config', async (_req, reply) => {
    try {
      const redacted = JSON.parse(JSON.stringify(config));
      if (Array.isArray(redacted.providers)) {
        for (const p of redacted.providers) {
          if (p && typeof p === 'object' && 'authValue' in p) {
            p.authValue = '***';
          }
        }
      }
      if (redacted.payments?.crypto && 'privateKey' in redacted.payments.crypto) {
        redacted.payments.crypto.privateKey = '***';
      }
      return reply.send({ config: redacted });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to get config: ${(err as Error).message}` } as any);
    }
  });

  // PUT /api/config - Update config
  app.put<{ Body: Partial<DashboardConfig> }>('/api/config', async (req, reply) => {
    const updates = req.body;
    const SAFE_CONFIG_KEYS = ['seller', 'buyer', 'network', 'payments'] as const;
    for (const key of SAFE_CONFIG_KEYS) {
      if (key in updates) {
        (config as any)[key] = updates[key];
      }
    }
    try {
      await saveConfig(configPath ?? '~/.antseed/config.json', config);
    } catch {
      return reply.code(500).send({ error: 'Failed to save config' });
    }
    return reply.send({ success: true, config });
  });
}

/** Merge daemon peers with DHT peers, deduplicating by peerId */
function mergePeers(daemonPeers: PeerInfo[], dhtPeers: NetworkPeer[]): PeerInfo[] {
  const merged = new Map<string, PeerInfo>();

  // Daemon peers first
  for (const p of daemonPeers) {
    merged.set(p.peerId, { ...p, source: 'daemon' });
  }

  // DHT peers, skip duplicates
  for (const dp of dhtPeers) {
    if (!merged.has(dp.peerId)) {
      merged.set(dp.peerId, {
        peerId: dp.peerId,
        providers: dp.providers,
        capacityMsgPerHour: dp.capacityMsgPerHour,
        inputUsdPerMillion: dp.inputUsdPerMillion,
        outputUsdPerMillion: dp.outputUsdPerMillion,
        reputation: dp.reputation,
        location: null,
        source: 'dht',
      });
    }
  }

  return Array.from(merged.values());
}

async function getPeerList(): Promise<{ peers: PeerInfo[]; degraded: boolean }> {
  try {
    const stateFile = join(homedir(), '.antseed', 'daemon.state.json');
    const raw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(raw) as Record<string, unknown>;
    const rawPeers = Array.isArray(state.peers) ? state.peers : [];
    const peers: PeerInfo[] = rawPeers.map((p) => {
      const peer = p as Partial<PeerInfo>;
      return {
        peerId: peer.peerId ?? '',
        providers: Array.isArray(peer.providers) ? peer.providers : [],
        capacityMsgPerHour: typeof peer.capacityMsgPerHour === 'number' ? peer.capacityMsgPerHour : 0,
        inputUsdPerMillion: typeof peer.inputUsdPerMillion === 'number' ? peer.inputUsdPerMillion : 0,
        outputUsdPerMillion: typeof peer.outputUsdPerMillion === 'number' ? peer.outputUsdPerMillion : 0,
        reputation: typeof peer.reputation === 'number' ? peer.reputation : 0,
        location: typeof peer.location === 'string' ? peer.location : null,
        source: 'daemon' as const,
      };
    }).filter((peer) => peer.peerId.length > 0);
    return { peers, degraded: false };
  } catch {
    return { peers: [], degraded: true };
  }
}

async function getSessionList(
  storage: MeteringStorage | null,
  limit: number,
  offset: number,
  filterStatus?: string
): Promise<{ items: SessionMetrics[]; total: number }> {
  const merged = new Map<string, SessionListEntry>();

  // Query persisted sessions from the last 30 days.
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  if (storage) {
    const allSessions = storage.getSessionsByTimeRange(thirtyDaysAgo, now);
    for (const s of allSessions) {
      merged.set(s.sessionId, {
        metrics: {
          sessionId: s.sessionId,
          provider: s.provider,
          startedAt: s.startedAt,
          totalTokens: s.totalTokens,
          totalRequests: s.totalRequests,
          durationMs: (s.endedAt ?? now) - s.startedAt,
          avgLatencyMs: s.avgLatencyMs,
          peerSwitches: s.peerSwitches,
        },
        startedAt: s.startedAt,
        active: s.endedAt == null,
      });
    }
  }

  // Merge live in-memory sessions exposed by the seeding daemon state.
  // This closes the gap where status says "activeSessions > 0" but metering DB rows
  // are delayed or unavailable for the current active stream.
  const daemonActiveSessions = await getDaemonActiveSessions();
  for (const active of daemonActiveSessions) {
    const existing = merged.get(active.metrics.sessionId);
    if (!existing) {
      merged.set(active.metrics.sessionId, active);
      continue;
    }

    const activeHasMoreData =
      active.metrics.totalRequests > existing.metrics.totalRequests ||
      active.metrics.totalTokens > existing.metrics.totalTokens ||
      active.startedAt > existing.startedAt;

    if (activeHasMoreData || (!existing.active && active.active)) {
      merged.set(active.metrics.sessionId, {
        metrics: {
          ...existing.metrics,
          ...active.metrics,
          peerSwitches: Math.max(existing.metrics.peerSwitches, active.metrics.peerSwitches),
        },
        startedAt: Math.max(existing.startedAt, active.startedAt),
        active: existing.active || active.active,
      });
      continue;
    }

    merged.set(active.metrics.sessionId, {
      metrics: existing.metrics,
      startedAt: Math.max(existing.startedAt, active.startedAt),
      active: existing.active || active.active,
    });
  }

  const normalizedStatus = (filterStatus ?? '').trim().toLowerCase();
  const filtered = [...merged.values()].filter((entry) => {
    if (normalizedStatus === 'active') return entry.active;
    if (normalizedStatus === 'closed' || normalizedStatus === 'ended') return !entry.active;
    return true;
  });

  filtered.sort((a, b) => b.startedAt - a.startedAt);

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit).map((entry) => entry.metrics);

  return { items, total };
}

interface SessionListEntry {
  metrics: SessionMetrics;
  startedAt: number;
  active: boolean;
}

type DaemonActiveSession = {
  sessionId?: unknown;
  buyerPeerId?: unknown;
  provider?: unknown;
  startedAt?: unknown;
  lastActivityAt?: unknown;
  totalRequests?: unknown;
  totalTokens?: unknown;
  avgLatencyMs?: unknown;
};

function asFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

async function getDaemonActiveSessions(): Promise<SessionListEntry[]> {
  const stateFile = join(homedir(), '.antseed', 'daemon.state.json');
  let raw: string;
  try {
    raw = await readFile(stateFile, 'utf-8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  if (!root) {
    return [];
  }

  const details = Array.isArray(root['activeSessionDetails']) ? root['activeSessionDetails'] as DaemonActiveSession[] : [];
  const activeSessionsCount = Math.max(0, Math.round(asFiniteNumber(root['activeSessions'], 0)));
  if (details.length === 0 && activeSessionsCount === 0) {
    return [];
  }

  const now = Date.now();
  const entries: SessionListEntry[] = [];
  for (const detail of details) {
    const sessionId = asText(detail?.sessionId, '').trim();
    if (sessionId.length === 0) {
      continue;
    }

    const startedAt = asFiniteNumber(detail?.startedAt, now);
    const durationMs = Math.max(0, now - startedAt);
    entries.push({
      metrics: {
        sessionId,
        provider: asText(detail?.provider, 'unknown'),
        startedAt,
        totalTokens: Math.max(0, Math.round(asFiniteNumber(detail?.totalTokens, 0))),
        totalRequests: Math.max(0, Math.round(asFiniteNumber(detail?.totalRequests, 0))),
        durationMs,
        avgLatencyMs: Math.max(0, asFiniteNumber(detail?.avgLatencyMs, 0)),
        peerSwitches: 0,
      },
      startedAt,
      active: true,
    });
  }

  // Fallback: if daemon reports active sessions but does not expose detailed rows yet,
  // synthesize placeholders so Sessions UI still reflects live load.
  if (entries.length === 0 && activeSessionsCount > 0) {
    for (let i = 0; i < activeSessionsCount; i += 1) {
      entries.push({
        metrics: {
          sessionId: `live-${i + 1}`,
          provider: 'live',
          startedAt: now,
          totalTokens: 0,
          totalRequests: 0,
          durationMs: 0,
          avgLatencyMs: 0,
          peerSwitches: 0,
        },
        startedAt: now,
        active: true,
      });
    }
  }

  return entries;
}

async function getEarningsData(
  storage: MeteringStorage | null,
  aggregator: UsageAggregator,
  period: 'day' | 'week' | 'month'
): Promise<Omit<EarningsResponse, 'degraded'>> {
  if (!storage) {
    return { today: '0.00', thisWeek: '0.00', thisMonth: '0.00', daily: [], byProvider: [] };
  }

  const now = Date.now();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(todayStart);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
  const monthStart = new Date(todayStart.getUTCFullYear(), todayStart.getUTCMonth(), 1);

  const todayCostCents = storage.getTotalCost(todayStart.getTime(), now);
  const weekCostCents = storage.getTotalCost(weekStart.getTime(), now);
  const monthCostCents = storage.getTotalCost(monthStart.getTime(), now);

  // Get sessions for the selected period for charts
  const periodMap = { day: 1, week: 7, month: 30 };
  const days = periodMap[period];
  const periodStart = now - days * 24 * 60 * 60 * 1000;
  const sessions = storage.getSessionsByTimeRange(periodStart, now);

  const dailyAggregates = aggregator.aggregate(sessions, 'daily');
  const daily = dailyAggregates.map((agg) => ({
    date: new Date(agg.periodStart).toISOString().slice(0, 10),
    amount: (agg.totalCostCents / 100).toFixed(2),
  }));

  // Provider breakdown from all sessions in the period
  const allTimeAgg = aggregator.aggregateAll(sessions);
  const byProvider = Object.entries(allTimeAgg.byProvider).map(([provider, data]) => ({
    provider,
    amount: (data.costCents / 100).toFixed(2),
  }));

  return {
    today: (todayCostCents / 100).toFixed(2),
    thisWeek: (weekCostCents / 100).toFixed(2),
    thisMonth: (monthCostCents / 100).toFixed(2),
    daily,
    byProvider,
  };
}

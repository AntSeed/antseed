import type { FastifyInstance } from 'fastify';
import type { CryptoContext } from './crypto-context.js';
import type { SeederConfig, NodeStatus } from './types.js';
import {
  DepositsClient,
  StakingClient,
  StatsClient,
  IdentityClient,
  formatUsdc,
  parseUsdc,
  MeteringStorage,
  type ChainConfig,
} from '@antseed/node';
import { EmissionsClient } from '@antseed/node/payments';
import { UsageAggregator } from '@antseed/node/metering';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

interface RouteContext {
  cryptoCtx: CryptoContext | null;
  chainConfig: ChainConfig;
  seederConfig: SeederConfig | null;
  configPath?: string;
  dataDir?: string;
}

const STALE_THRESHOLD_MS = 30_000;

function asFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullablePort(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function registerRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const dataDir = ctx.dataDir || join(homedir(), '.antseed');
  const stateFile = join(dataDir, 'daemon.state.json');
  const dbPath = join(dataDir, 'metering.db');

  // Metering storage for session/earnings data
  let storage: MeteringStorage | null = null;
  try { storage = new MeteringStorage(dbPath); } catch { /* degraded mode */ }
  const aggregator = new UsageAggregator();

  // Contract clients (lazy, stateless)
  function stakingClient(): StakingClient | null {
    if (!ctx.chainConfig.stakingContractAddress) return null;
    return new StakingClient({
      rpcUrl: ctx.chainConfig.rpcUrl,
      contractAddress: ctx.chainConfig.stakingContractAddress,
      usdcAddress: ctx.chainConfig.usdcContractAddress,
    });
  }

  function depositsClient(): DepositsClient {
    return new DepositsClient({
      rpcUrl: ctx.chainConfig.rpcUrl,
      contractAddress: ctx.chainConfig.depositsContractAddress,
      usdcAddress: ctx.chainConfig.usdcContractAddress,
    });
  }

  function statsClient(): StatsClient | null {
    if (!ctx.chainConfig.statsContractAddress) return null;
    return new StatsClient({
      rpcUrl: ctx.chainConfig.rpcUrl,
      contractAddress: ctx.chainConfig.statsContractAddress,
    });
  }

  function emissionsClient(): EmissionsClient | null {
    if (!ctx.chainConfig.emissionsContractAddress) return null;
    return new EmissionsClient({
      rpcUrl: ctx.chainConfig.rpcUrl,
      contractAddress: ctx.chainConfig.emissionsContractAddress,
    });
  }

  function identityClient(): IdentityClient | null {
    if (!ctx.chainConfig.identityRegistryAddress) return null;
    return new IdentityClient({
      rpcUrl: ctx.chainConfig.rpcUrl,
      contractAddress: ctx.chainConfig.identityRegistryAddress,
    });
  }

  // ── Chain config ──
  fastify.get('/api/config', async () => ({
    chainId: ctx.chainConfig.chainId,
    evmChainId: ctx.chainConfig.evmChainId,
    rpcUrl: ctx.chainConfig.rpcUrl,
    depositsContractAddress: ctx.chainConfig.depositsContractAddress,
    sessionsContractAddress: ctx.chainConfig.sessionsContractAddress,
    stakingContractAddress: ctx.chainConfig.stakingContractAddress ?? null,
    usdcContractAddress: ctx.chainConfig.usdcContractAddress,
    identityRegistryAddress: ctx.chainConfig.identityRegistryAddress ?? null,
    statsContractAddress: ctx.chainConfig.statsContractAddress ?? null,
    emissionsContractAddress: ctx.chainConfig.emissionsContractAddress ?? null,
    evmAddress: ctx.cryptoCtx?.evmAddress ?? null,
  }));

  // ── Node status (from daemon state) ──
  fastify.get('/api/status', async () => {
    try {
      const raw = await readFile(stateFile, 'utf-8');
      const state = JSON.parse(raw) as Record<string, unknown>;
      const pid = typeof state['pid'] === 'number' ? state['pid'] : null;
      const alive = pid !== null && isProcessAlive(pid);

      if (pid !== null && !alive) {
        return idleStatus(ctx.seederConfig, pid);
      }
      if (pid === null) {
        const fileStat = await stat(stateFile);
        if (Date.now() - fileStat.mtimeMs > STALE_THRESHOLD_MS) {
          return idleStatus(ctx.seederConfig, null);
        }
      }

      const validStates = ['seeding', 'connected', 'idle'] as const;
      const rawState = typeof state['state'] === 'string' && validStates.includes(state['state'] as NodeStatus['state'])
        ? (state['state'] as NodeStatus['state']) : 'idle';

      return {
        state: rawState,
        peerCount: asFiniteNumber(state['peerCount'], 0),
        earningsToday: typeof state['earningsToday'] === 'string' ? state['earningsToday'] : '0',
        tokensToday: asFiniteNumber(state['tokensToday'], 0),
        activeSessions: asFiniteNumber(state['activeSessions'], 0),
        uptime: typeof state['uptime'] === 'string' ? state['uptime'] : '0s',
        walletAddress: typeof state['walletAddress'] === 'string' ? state['walletAddress'] : (ctx.seederConfig?.identity.walletAddress ?? null),
        proxyPort: asNullablePort(state['proxyPort']),
        capacityUsedPercent: asFiniteNumber(state['capacityUsedPercent'], 0),
        daemonPid: pid,
        daemonAlive: alive,
      };
    } catch {
      return idleStatus(ctx.seederConfig, null);
    }
  });

  // ── Stake info (on-chain read) ──
  fastify.get('/api/stake', async (_req, reply) => {
    if (!ctx.cryptoCtx) return reply.status(503).send({ error: 'Identity not configured' });
    const client = stakingClient();
    if (!client) return reply.status(503).send({ error: 'Staking contract not configured' });

    try {
      const [account, aboveMin, agentId] = await Promise.all([
        client.getSellerAccount(ctx.cryptoCtx.evmAddress),
        client.isStakedAboveMin(ctx.cryptoCtx.evmAddress),
        client.getAgentId(ctx.cryptoCtx.evmAddress),
      ]);
      return {
        stake: formatUsdc(account.stake),
        stakedAt: Number(account.stakedAt),
        isAboveMin: aboveMin,
        agentId: agentId.toString(),
        activeSessions: 0,
      };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Identity info (on-chain read) ──
  fastify.get('/api/identity', async (_req, reply) => {
    if (!ctx.cryptoCtx) return reply.status(503).send({ error: 'Identity not configured' });

    try {
      const result: Record<string, unknown> = { evmAddress: ctx.cryptoCtx.evmAddress };

      const idClient = identityClient();
      if (idClient) {
        const registered = await idClient.isRegistered(ctx.cryptoCtx.evmAddress);
        result.isRegistered = registered;
      }

      // Get stats if we know the agentId
      const stClient = stakingClient();
      if (stClient) {
        const agentId = await stClient.getAgentId(ctx.cryptoCtx.evmAddress);
        result.agentId = agentId.toString();

        const statsC = statsClient();
        if (statsC && agentId > 0n) {
          const stats = await statsC.getStats(agentId);
          result.stats = {
            sessionCount: Number(stats.sessionCount),
            ghostCount: Number(stats.ghostCount),
            totalVolumeUsdc: formatUsdc(stats.totalVolumeUsdc),
            totalInputTokens: Number(stats.totalInputTokens),
            totalOutputTokens: Number(stats.totalOutputTokens),
            totalLatencyMs: Number(stats.totalLatencyMs),
            totalRequestCount: Number(stats.totalRequestCount),
            lastSettledAt: Number(stats.lastSettledAt),
          };
        }
      }

      return result;
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Earnings (on-chain + metering DB) ──
  fastify.get<{ Querystring: { period?: string } }>('/api/earnings', async (req, reply) => {
    const result: Record<string, unknown> = {};

    // On-chain earnings
    if (ctx.cryptoCtx) {
      try {
        const depClient = depositsClient();
        const earnings = await depClient.getSellerEarnings(ctx.cryptoCtx.evmAddress);
        result.pendingUsdc = formatUsdc(earnings);
      } catch { result.pendingUsdc = '0.00'; }

      try {
        const emClient = emissionsClient();
        if (emClient) {
          const pending = await emClient.pendingEmissions(ctx.cryptoCtx.evmAddress);
          result.pendingAnts = { seller: pending.seller.toString(), buyer: pending.buyer.toString() };
        }
      } catch { result.pendingAnts = null; }
    }

    // Metering DB earnings
    if (storage) {
      const now = Date.now();
      const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
      const weekStart = new Date(todayStart); weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      const monthStart = new Date(todayStart.getUTCFullYear(), todayStart.getUTCMonth(), 1);

      result.today = (storage.getTotalCost(todayStart.getTime(), now) / 100).toFixed(2);
      result.thisWeek = (storage.getTotalCost(weekStart.getTime(), now) / 100).toFixed(2);
      result.thisMonth = (storage.getTotalCost(monthStart.getTime(), now) / 100).toFixed(2);

      const period = (req.query.period || 'month') as 'day' | 'week' | 'month';
      const periodMap = { day: 1, week: 7, month: 30 };
      const days = periodMap[period] ?? 30;
      const periodStart = now - days * 24 * 60 * 60 * 1000;
      const sessions = storage.getSessionsByTimeRange(periodStart, now);

      const dailyAgg = aggregator.aggregate(sessions, 'daily');
      result.daily = dailyAgg.map(a => ({
        date: new Date(a.periodStart).toISOString().slice(0, 10),
        amount: (a.totalCostCents / 100).toFixed(2),
      }));

      const allAgg = aggregator.aggregateAll(sessions);
      result.byProvider = Object.entries(allAgg.byProvider).map(([provider, data]) => ({
        provider,
        amount: (data.costCents / 100).toFixed(2),
      }));
    } else {
      result.today = '0.00';
      result.thisWeek = '0.00';
      result.thisMonth = '0.00';
      result.daily = [];
      result.byProvider = [];
    }

    return result;
  });

  // ── Sessions (from metering DB + daemon state) ──
  fastify.get<{ Querystring: { limit?: number; offset?: number; status?: string } }>('/api/sessions', async (req) => {
    const { limit = 50, offset = 0, status: filterStatus } = req.query;
    const merged = new Map<string, { metrics: SessionMetrics; startedAt: number; active: boolean }>();
    const now = Date.now();

    // From metering DB
    if (storage) {
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
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
          },
          startedAt: s.startedAt,
          active: s.endedAt == null,
        });
      }
    }

    // From daemon state (active sessions)
    try {
      const raw = await readFile(stateFile, 'utf-8');
      const state = JSON.parse(raw) as Record<string, unknown>;
      const details = Array.isArray(state['activeSessionDetails']) ? state['activeSessionDetails'] : [];
      for (const detail of details) {
        const d = detail as Record<string, unknown>;
        const sessionId = typeof d.sessionId === 'string' ? d.sessionId.trim() : '';
        if (!sessionId) continue;
        const startedAt = asFiniteNumber(d.startedAt, now);
        const existing = merged.get(sessionId);
        if (!existing || asFiniteNumber(d.totalRequests, 0) > existing.metrics.totalRequests) {
          merged.set(sessionId, {
            metrics: {
              sessionId,
              provider: typeof d.provider === 'string' ? d.provider : 'unknown',
              startedAt,
              totalTokens: Math.max(0, Math.round(asFiniteNumber(d.totalTokens, 0))),
              totalRequests: Math.max(0, Math.round(asFiniteNumber(d.totalRequests, 0))),
              durationMs: Math.max(0, now - startedAt),
              avgLatencyMs: Math.max(0, asFiniteNumber(d.avgLatencyMs, 0)),
            },
            startedAt,
            active: true,
          });
        }
      }
    } catch { /* daemon not running */ }

    const normalizedStatus = (filterStatus ?? '').trim().toLowerCase();
    const filtered = [...merged.values()].filter(e => {
      if (normalizedStatus === 'active') return e.active;
      if (normalizedStatus === 'closed' || normalizedStatus === 'ended') return !e.active;
      return true;
    });
    filtered.sort((a, b) => b.startedAt - a.startedAt);

    return {
      sessions: filtered.slice(offset, offset + limit).map(e => ({ ...e.metrics, active: e.active })),
      total: filtered.length,
    };
  });

  // ── Peers (from daemon state) ──
  fastify.get('/api/peers', async () => {
    try {
      const raw = await readFile(stateFile, 'utf-8');
      const state = JSON.parse(raw) as Record<string, unknown>;
      const rawPeers = Array.isArray(state.peers) ? state.peers : [];
      const peers = rawPeers.map((p) => {
        const peer = p as Record<string, unknown>;
        return {
          peerId: typeof peer.peerId === 'string' ? peer.peerId : '',
          displayName: typeof peer.displayName === 'string' ? peer.displayName : null,
          services: Array.isArray(peer.services) ? peer.services.filter((s: unknown) => typeof s === 'string') : [],
          capacityMsgPerHour: asFiniteNumber(peer.capacityMsgPerHour, 0),
          inputUsdPerMillion: asFiniteNumber(peer.inputUsdPerMillion, 0),
          outputUsdPerMillion: asFiniteNumber(peer.outputUsdPerMillion, 0),
          reputation: asFiniteNumber(peer.reputation, 0),
        };
      }).filter(p => p.peerId.length > 0);
      return { peers, total: peers.length };
    } catch {
      return { peers: [], total: 0 };
    }
  });

  // ── Seeder config (read) ──
  fastify.get('/api/node-config', async () => {
    if (!ctx.seederConfig) return { config: null };
    const redacted = JSON.parse(JSON.stringify(ctx.seederConfig));
    if (Array.isArray(redacted.providers)) {
      for (const p of redacted.providers) {
        if (p && typeof p === 'object' && 'authValue' in p) p.authValue = '***';
      }
    }
    if (redacted.payments?.crypto && 'privateKey' in redacted.payments.crypto) {
      redacted.payments.crypto.privateKey = '***';
    }
    return { config: redacted };
  });

  // ── Seeder config (update) ──
  fastify.put<{ Body: Partial<SeederConfig> }>('/api/node-config', async (req, reply) => {
    if (!ctx.seederConfig) return reply.status(503).send({ error: 'No config loaded' });
    const updates = req.body;
    const SAFE_KEYS = ['seller', 'buyer', 'network', 'payments'] as const;
    for (const key of SAFE_KEYS) {
      if (key in updates) (ctx.seederConfig as unknown as Record<string, unknown>)[key] = updates[key];
    }
    try {
      const cfgPath = ctx.configPath
        || (ctx.dataDir ? join(ctx.dataDir, 'config.json') : join(homedir(), '.antseed', 'config.json'));
      const resolved = cfgPath.startsWith('~') ? resolve(homedir(), cfgPath.slice(2)) : resolve(cfgPath);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, JSON.stringify(ctx.seederConfig, null, 2), 'utf-8');
    } catch {
      return reply.status(500).send({ error: 'Failed to save config' });
    }
    return { success: true };
  });

  // ── Stake (write) ──
  fastify.post<{ Body: { amount: string; agentId: string } }>('/api/stake', async (req, reply) => {
    if (!ctx.cryptoCtx) return reply.status(503).send({ error: 'Identity not configured' });
    const client = stakingClient();
    if (!client) return reply.status(503).send({ error: 'Staking contract not configured' });

    const { amount, agentId } = req.body;
    if (!amount || !agentId) return reply.status(400).send({ error: 'amount and agentId required' });

    try {
      const baseUnits = parseUsdc(amount);
      const txHash = await client.stake(ctx.cryptoCtx.wallet, Number(agentId), baseUnits);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Unstake (write) ──
  fastify.post('/api/unstake', async (_req, reply) => {
    if (!ctx.cryptoCtx) return reply.status(503).send({ error: 'Identity not configured' });
    const client = stakingClient();
    if (!client) return reply.status(503).send({ error: 'Staking contract not configured' });

    try {
      const txHash = await client.unstake(ctx.cryptoCtx.wallet);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Claim earnings (write) ──
  fastify.post('/api/claim-earnings', async (_req, reply) => {
    if (!ctx.cryptoCtx) return reply.status(503).send({ error: 'Identity not configured' });

    try {
      const client = depositsClient();
      const txHash = await client.claimEarnings(ctx.cryptoCtx.wallet);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Claim emissions (write) ──
  fastify.post('/api/claim-emissions', async (_req, reply) => {
    if (!ctx.cryptoCtx) return reply.status(503).send({ error: 'Identity not configured' });
    const client = emissionsClient();
    if (!client) return reply.status(503).send({ error: 'Emissions contract not configured' });

    try {
      const txHash = await client.claimEmissions(ctx.cryptoCtx.wallet);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

interface SessionMetrics {
  sessionId: string;
  provider: string;
  startedAt: number;
  totalTokens: number;
  totalRequests: number;
  durationMs: number;
  avgLatencyMs: number;
}

function idleStatus(config: SeederConfig | null, pid: number | null): NodeStatus {
  return {
    state: 'idle',
    peerCount: 0,
    earningsToday: '0',
    tokensToday: 0,
    activeSessions: 0,
    uptime: '0s',
    walletAddress: config?.identity.walletAddress ?? null,
    proxyPort: null,
    capacityUsedPercent: 0,
    daemonPid: pid,
    daemonAlive: false,
  };
}

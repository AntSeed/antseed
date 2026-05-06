/**
 * ERC-8004 ReputationRegistry routes.
 *
 *   GET /reputation/agents/:agentId  → totals + recent feedback for an agent
 *   GET /reputation/recent           → newest feedback across all agents
 *   GET /reputation/leaderboard      → top agents by net feedback (count − revoked)
 *
 * `value` is normalized to a `score` field by dividing by 10^valueDecimals.
 * The raw int128 string + decimals are also returned so callers that care
 * about precision (e.g. summing many feedbacks) can recompute themselves.
 */

import type { Express } from 'express';

import type { ReputationFeedbackRow, SqliteStore } from '../../store.js';
import {
  REPUTATION_LEADERBOARD_CACHE_KEY,
  REPUTATION_RECENT_CACHE_KEY,
  reputationAgentCacheKey,
} from '../cache-keys.js';
import { asyncHandler } from '../middleware.js';
import { sendCachedJson, type ResponseCache } from '../response-cache.js';
import { BadRequestError } from '../validators.js';

const AGENT_FRESH_MS = 30_000;
const AGENT_STALE_MS = 5 * 60_000;
const RECENT_FRESH_MS = 30_000;
const RECENT_STALE_MS = 5 * 60_000;
const LEADERBOARD_FRESH_MS = 60_000;
const LEADERBOARD_STALE_MS = 10 * 60_000;

const DEFAULT_FEEDBACK_LIMIT = 25;
const MAX_FEEDBACK_LIMIT = 200;

export interface ReputationRouteDeps {
  store?: SqliteStore;
  cache: ResponseCache;
}

interface FeedbackEntry {
  agentId: number;
  clientAddress: string;
  feedbackIndex: number;
  value: string;            // raw int128, stringified (may be negative)
  valueDecimals: number;
  score: number;            // value / 10^decimals — convenience for the UI
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
  blockNumber: number;
  blockTimestamp: number | null;
  txHash: string;
  revoked: boolean;
  revokedAtBlock: number | null;
  response: {
    uri: string;
    hash: string;
    responder: string;
    atBlock: number;
  } | null;
}

interface AgentPayload {
  agentId: number;
  totals: {
    feedbackCount: number;
    revokedCount: number;
    responseCount: number;
    uniqueClients: number;
    netFeedback: number;
    /**
     * Average score across the *currently-returned* `feedback` window
     * (default 25 most recent, non-revoked). NOT a true overall average —
     * computing that requires a SQL aggregate we don't have yet. Renamed
     * from `averageScore` so callers don't read it as agent-wide.
     */
    recentAverageScore: number | null;
    firstFeedbackBlock: number | null;
    lastFeedbackBlock: number | null;
  } | null;
  feedback: FeedbackEntry[];
}

interface LeaderboardEntry {
  agentId: number;
  feedbackCount: number;
  revokedCount: number;
  responseCount: number;
  uniqueClients: number;
  netFeedback: number;
  firstFeedbackBlock: number | null;
  lastFeedbackBlock: number | null;
}

function toFeedbackEntry(row: ReputationFeedbackRow): FeedbackEntry {
  // score = signed value / 10^decimals. valueDecimals is uint8 → ≤255, so
  // 10^decimals comfortably exceeds Number range only at decimals ≥ 309.
  // ERC-8004 in practice uses small decimals (0–6); we just clamp the divisor
  // to MAX_VALUE rather than throw, on the (extreme) chance someone publishes
  // a pathological feedback.
  const divisor = Math.min(Math.pow(10, row.valueDecimals), Number.MAX_SAFE_INTEGER);
  const score = Number(row.value) / divisor;
  return {
    agentId: row.agentId,
    clientAddress: row.clientAddress,
    feedbackIndex: row.feedbackIndex,
    value: row.value.toString(),
    valueDecimals: row.valueDecimals,
    score,
    tag1: row.tag1,
    tag2: row.tag2,
    endpoint: row.endpoint,
    feedbackURI: row.feedbackURI,
    feedbackHash: row.feedbackHash,
    blockNumber: row.blockNumber,
    blockTimestamp: row.blockTimestamp,
    txHash: row.txHash,
    revoked: row.revoked,
    revokedAtBlock: row.revokedAtBlock,
    response:
      row.responseURI !== null
        ? {
            uri: row.responseURI,
            hash: row.responseHash ?? '',
            responder: row.responseResponder ?? '',
            atBlock: row.responseAtBlock ?? 0,
          }
        : null,
  };
}

function buildAgentPayload(store: SqliteStore, agentId: number, limit: number): AgentPayload {
  const totals = store.getReputationTotals(agentId);
  const feedback = store.getReputationFeedbackForAgent(agentId, limit).map(toFeedbackEntry);

  // Mean of the non-revoked entries in *this page's* feedback window. Not a
  // true agent-wide average — that would need a SQL aggregate we don't have
  // yet (TODO: roll a `value_sum_x10pow` counter into reputation_agent_totals
  // so this can be served O(1) and across the full history).
  let recentAverageScore: number | null = null;
  if (totals && totals.feedbackCount - totals.revokedCount > 0) {
    let sum = 0;
    let nonRevoked = 0;
    for (const entry of feedback) {
      if (entry.revoked) continue;
      sum += entry.score;
      nonRevoked++;
    }
    recentAverageScore = nonRevoked > 0 ? sum / nonRevoked : null;
  }

  return {
    agentId,
    totals: totals
      ? {
          feedbackCount: totals.feedbackCount,
          revokedCount: totals.revokedCount,
          responseCount: totals.responseCount,
          uniqueClients: totals.uniqueClients,
          netFeedback: totals.feedbackCount - totals.revokedCount,
          recentAverageScore,
          firstFeedbackBlock: totals.firstFeedbackBlock,
          lastFeedbackBlock: totals.lastFeedbackBlock,
        }
      : null,
    feedback,
  };
}

function parseAgentId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestError('agentId must be a non-negative integer');
  }
  return n;
}

function parseLimit(raw: unknown, defaultValue: number, max: number): number {
  if (typeof raw !== 'string') return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestError('limit must be a positive integer');
  }
  return Math.min(n, max);
}

export function registerReputationRoutes(app: Express, deps: ReputationRouteDeps): void {
  const { store, cache } = deps;

  app.get('/reputation/agents/:agentId', asyncHandler(async (req, res) => {
    const agentId = parseAgentId(req.params['agentId']!);
    const limit = parseLimit(req.query['limit'], DEFAULT_FEEDBACK_LIMIT, MAX_FEEDBACK_LIMIT);

    if (!store) {
      res.json({ agentId, totals: null, feedback: [] } satisfies AgentPayload);
      return;
    }

    // Cache only the default-limit case — slot-per-(agent, limit) would
    // multiply the cache footprint by the number of distinct limits. The
    // long tail goes through SQLite directly, which is already cheap.
    if (limit === DEFAULT_FEEDBACK_LIMIT) {
      const env = await cache.read<AgentPayload>(reputationAgentCacheKey(agentId), {
        compute: async () => ({
          payload: buildAgentPayload(store, agentId, limit),
          sourceUpdatedAt: null,
        }),
        freshMs: AGENT_FRESH_MS,
        staleMs: AGENT_STALE_MS,
      });
      sendCachedJson(req, res, env);
      return;
    }
    res.json(buildAgentPayload(store, agentId, limit));
  }));

  app.get('/reputation/recent', asyncHandler(async (req, res) => {
    if (!store) {
      res.json({ feedback: [] });
      return;
    }
    const limit = parseLimit(req.query['limit'], DEFAULT_FEEDBACK_LIMIT, MAX_FEEDBACK_LIMIT);
    if (limit === DEFAULT_FEEDBACK_LIMIT) {
      const env = await cache.read<{ feedback: FeedbackEntry[] }>(REPUTATION_RECENT_CACHE_KEY, {
        compute: async () => {
          const rows = store.getRecentReputationFeedback(limit);
          return {
            payload: { feedback: rows.map(toFeedbackEntry) },
            sourceUpdatedAt: rows[0]?.blockTimestamp ? rows[0].blockTimestamp * 1000 : null,
          };
        },
        freshMs: RECENT_FRESH_MS,
        staleMs: RECENT_STALE_MS,
      });
      sendCachedJson(req, res, env);
      return;
    }
    res.json({
      feedback: store.getRecentReputationFeedback(limit).map(toFeedbackEntry),
    });
  }));

  app.get('/reputation/leaderboard', asyncHandler(async (req, res) => {
    if (!store) {
      res.json({ leaderboard: [] });
      return;
    }
    const limit = parseLimit(req.query['limit'], DEFAULT_FEEDBACK_LIMIT, MAX_FEEDBACK_LIMIT);
    if (limit === DEFAULT_FEEDBACK_LIMIT) {
      const env = await cache.read<{ leaderboard: LeaderboardEntry[] }>(REPUTATION_LEADERBOARD_CACHE_KEY, {
        compute: async () => ({
          payload: { leaderboard: store.getReputationLeaderboard(limit).map(toLeaderboardEntry) },
          sourceUpdatedAt: null,
        }),
        freshMs: LEADERBOARD_FRESH_MS,
        staleMs: LEADERBOARD_STALE_MS,
      });
      sendCachedJson(req, res, env);
      return;
    }
    res.json({
      leaderboard: store.getReputationLeaderboard(limit).map(toLeaderboardEntry),
    });
  }));
}

function toLeaderboardEntry(t: {
  agentId: number;
  feedbackCount: number;
  revokedCount: number;
  responseCount: number;
  uniqueClients: number;
  firstFeedbackBlock: number | null;
  lastFeedbackBlock: number | null;
}): LeaderboardEntry {
  return {
    agentId: t.agentId,
    feedbackCount: t.feedbackCount,
    revokedCount: t.revokedCount,
    responseCount: t.responseCount,
    uniqueClients: t.uniqueClients,
    netFeedback: t.feedbackCount - t.revokedCount,
    firstFeedbackBlock: t.firstFeedbackBlock,
    lastFeedbackBlock: t.lastFeedbackBlock,
  };
}

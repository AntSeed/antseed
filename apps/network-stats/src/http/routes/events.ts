/**
 * Raw chain-event endpoints. The explorer's "latest activity" homepage feed
 * + per-tx + per-contract drill-downs all read from `chain_events`.
 *
 * Routes:
 *   GET /events                — newest 25 across all contracts (cached slot)
 *   GET /events?tx=0x…         — single-tx view, all logs in that tx
 *   GET /events?contract=…     — per-contract feed, paginated by keyset
 *   GET /events?event=Transfer — per-event-name feed (e.g. just ANTS Transfer)
 *
 * Filtered reads bypass the cache — the cardinality of `(contract, event,
 * range, tx, cursor)` makes a slot-per-query model wasteful. The query is
 * already keyset-paginated and indexed, so even uncached reads stay cheap.
 */

import type { Express } from 'express';

import type { ChainEventQuery, ChainEventRow, SqliteStore } from '../../store.js';
import { EVENTS_RECENT_CACHE_KEY } from '../cache-keys.js';
import { asyncHandler } from '../middleware.js';
import { sendCachedJson, type ResponseCache } from '../response-cache.js';
import { BadRequestError } from '../validators.js';

const RECENT_FRESH_MS = 5_000;
const RECENT_STALE_MS = 60_000;
const RECENT_LIMIT = 25;

export interface EventsRouteDeps {
  store?: SqliteStore;
  cache: ResponseCache;
}

interface EventsPayload {
  events: ChainEventRow[];
  /** Keyset cursor for the next page; null when this page is the tail. */
  nextCursor: { blockNumber: number; logIndex: number } | null;
}

function payloadFromRows(rows: ChainEventRow[], requestedLimit: number): EventsPayload {
  // We requested `limit + 1` so we can detect "is there more". Drop the
  // overflow row from the response body and use it to mint the cursor.
  if (rows.length <= requestedLimit) return { events: rows, nextCursor: null };
  const head = rows.slice(0, requestedLimit);
  const next = head[head.length - 1]!;
  return {
    events: head,
    nextCursor: { blockNumber: next.blockNumber, logIndex: next.logIndex },
  };
}

function parseIntParam(value: string | undefined, name: string, max?: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestError(`${name} must be a non-negative integer`);
  }
  if (max !== undefined && n > max) {
    throw new BadRequestError(`${name} must be ≤ ${max}`);
  }
  return n;
}

function strParam(q: Record<string, unknown>, name: string): string | undefined {
  return typeof q[name] === 'string' ? (q[name] as string) : undefined;
}

function parseQuery(q: Record<string, unknown>): ChainEventQuery {
  const limit = parseIntParam(strParam(q, 'limit'), 'limit', 500);
  const fromBlock = parseIntParam(strParam(q, 'fromBlock'), 'fromBlock');
  const toBlock = parseIntParam(strParam(q, 'toBlock'), 'toBlock');
  const beforeBlockNumber = parseIntParam(strParam(q, 'beforeBlock'), 'beforeBlock');
  const beforeLogIndex = parseIntParam(strParam(q, 'beforeLogIndex'), 'beforeLogIndex');

  const contract = strParam(q, 'contract');
  const event = strParam(q, 'event');
  const tx = strParam(q, 'tx');

  // Keyset cursor must arrive as a tuple. A half-supplied cursor would
  // silently degrade to "no cursor" and the caller would unknowingly receive
  // the newest page again — surface it as a 400 instead.
  if ((beforeBlockNumber === undefined) !== (beforeLogIndex === undefined)) {
    throw new BadRequestError('beforeBlock and beforeLogIndex must both be supplied together');
  }

  return {
    ...(contract !== undefined ? { contractAddress: contract } : {}),
    ...(event !== undefined ? { eventName: event } : {}),
    ...(tx !== undefined ? { txHash: tx } : {}),
    ...(fromBlock !== undefined ? { fromBlock } : {}),
    ...(toBlock !== undefined ? { toBlock } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(beforeBlockNumber !== undefined && beforeLogIndex !== undefined
      ? { beforeBlockNumber, beforeLogIndex }
      : {}),
  };
}

export function registerEventsRoutes(app: Express, deps: EventsRouteDeps): void {
  const { store, cache } = deps;

  app.get('/events', asyncHandler(async (req, res) => {
    if (!store) {
      res.json({ events: [], nextCursor: null });
      return;
    }

    const query = parseQuery(req.query as Record<string, unknown>);
    const isUnfilteredHomepage =
      query.contractAddress === undefined
      && query.eventName === undefined
      && query.txHash === undefined
      && query.fromBlock === undefined
      && query.toBlock === undefined
      && query.beforeBlockNumber === undefined
      && (query.limit === undefined || query.limit === RECENT_LIMIT);

    // Cached homepage feed — the slot is invalidated by every indexer's
    // onTickComplete (wired in index.ts) so a settled tick shows up on the
    // next read. Filtered reads always go through SQLite directly.
    if (isUnfilteredHomepage) {
      const env = await cache.read<EventsPayload>(EVENTS_RECENT_CACHE_KEY, {
        compute: async () => {
          const rows = store.getChainEvents({ limit: RECENT_LIMIT + 1 });
          const payload = payloadFromRows(rows, RECENT_LIMIT);
          // Source timestamp = newest event's block_timestamp (when known) so
          // X-Data-Updated-At reflects on-chain wall clock, not cache mint time.
          const newest = payload.events[0];
          return {
            payload,
            sourceUpdatedAt: newest?.blockTimestamp ? newest.blockTimestamp * 1000 : null,
          };
        },
        freshMs: RECENT_FRESH_MS,
        staleMs: RECENT_STALE_MS,
      });
      sendCachedJson(req, res, env);
      return;
    }

    const limit = query.limit ?? 50;
    const rows = store.getChainEvents({ ...query, limit: limit + 1 });
    res.json(payloadFromRows(rows, limit));
  }));
}

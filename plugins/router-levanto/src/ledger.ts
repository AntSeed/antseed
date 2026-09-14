import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * routing_decisions local ledger. Feeds the savings dashboard (VPR UI, task
 * #10) -- not a billing record; the real settlement is governed entirely by
 * the signed SpendingAuth.
 *
 * `RoutingDecisionRow` itself now lives in packages/node (`Router.getRoutingDecisions`'s
 * return type) rather than being defined here twice -- the host reads a
 * router's ledger through that generic optional method, so the row shape has
 * to be something packages/node can name without depending on this plugin.
 * baselinePrices covers every distinct model actually present in a
 * decision's ranked response, not just a curated subset (see
 * computeBaselinePrices in router.ts) -- ahead of a future comparison
 * dropdown UI, since the response data needed to fill it already arrives on
 * every /_antseed/route call regardless of whether that UI exists yet.
 *
 * Persistence: SQLite via `@antseed/node`'s `RoutingDecisionsStore`, not the
 * hand-rolled append-only `routing-decisions.jsonl` this used before -- that
 * file grew forever with no rotation/compaction, and required a full
 * synchronous read+parse of the ENTIRE file on every process start (startup
 * cost and peak memory scaled with total lifetime writes, not the intended
 * 5000-row retention window). A pre-existing JSONL file from an older
 * version is imported into the new SQLite store exactly once (see
 * `_migrateLegacyJsonlIfPresent`) and renamed to `.migrated` so it's never
 * re-read, but stays around as a backup.
 */
import { RoutingDecisionsStore, type RoutingDecisionRow } from '@antseed/node';
export type { RoutingDecisionRow } from '@antseed/node';

type BaselinePrices = RoutingDecisionRow['baselinePrices'];
type ConsideredCandidates = RoutingDecisionRow['consideredCandidates'];

/** The predicted half of a row, captured at selectRoute time -- consumed by the matching onResult. */
export interface PendingDecision {
  model: string;
  predictedCostUsd: number | null;
  predictedInputTokens: number | null;
  predictedCachedInputTokens: number | null;
  predictedOutputTokens: number | null;
  cqt: number;
  routingLatencyMs: number | null;
  atMs: number;
  baselinePrices: BaselinePrices;
  conversationKey: string | null;
  consideredCandidates: ConsideredCandidates;
  inputMessagePreview: string | null;
}

/** Legacy JSON-lines file name, from before the move to SQLite -- still read once, for migration. */
export const ROUTING_DECISIONS_FILE = 'routing-decisions.jsonl';

/**
 * Flat cap on in-flight pending decisions retained at once -- oldest is
 * evicted first. A pending entry is normally removed by its matching
 * recordResult, but a request that never resolves (every peer attempt
 * fails, or an older caller's result omits requestId) would otherwise sit
 * in the map forever; this bounds that growth the same way
 * BuyerProxy._trackRequestConversation bounds _requestConversations.
 */
const MAX_PENDING_DECISIONS = 500;

/**
 * Flat cap on the in-memory `rows` list backing `getRoutingDecisions()` --
 * 5000 rows is generous for the per-conversation drill-down/savings
 * dashboard this caps for -- at 100 routed messages/day that's ~50 days of
 * in-memory history, far more than either UI surface needs at once.
 */
const MAX_LEDGER_ROWS = 5000;

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sanitizeBaselinePrices(value: unknown): BaselinePrices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: BaselinePrices = {};
  for (const [model, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.inUsdPerM !== 'number' || typeof e.outUsdPerM !== 'number') continue;
    out[model] = { inUsdPerM: e.inUsdPerM, outUsdPerM: e.outUsdPerM, cachedInUsdPerM: numOrNull(e.cachedInUsdPerM) };
  }
  return out;
}

/** Reload-time validation for consideredCandidates -- absent/malformed (rows persisted before this field existed) sanitizes to []. */
function sanitizeConsideredCandidates(value: unknown): ConsideredCandidates {
  if (!Array.isArray(value)) return [];
  const out: ConsideredCandidates = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.model !== 'string' || typeof e.peer !== 'string') continue;
    if (typeof e.inUsdPerM !== 'number' || typeof e.outUsdPerM !== 'number') continue;
    out.push({ model: e.model, peer: e.peer, inUsdPerM: e.inUsdPerM, outUsdPerM: e.outUsdPerM, cachedInUsdPerM: numOrNull(e.cachedInUsdPerM) });
  }
  return out;
}

/** Reload-time validation, same spirit as ConversationStore's sanitizeRecord (apps/cli/src/proxy/conversation-store.ts) -- a corrupt or partially-written line is skipped, not fatal. */
function sanitizeRow(value: unknown): RoutingDecisionRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.actualModel !== 'string' || typeof r.actualPeer !== 'string') return null;
  return {
    atMs: num(r.atMs, Date.now()),
    actualModel: r.actualModel,
    actualPeer: r.actualPeer,
    actualPromptTokens: num(r.actualPromptTokens),
    actualCachedTokens: num(r.actualCachedTokens),
    actualCompletionTokens: num(r.actualCompletionTokens),
    actualUsdcPaid: numOrNull(r.actualUsdcPaid),
    predictedCostUsd: numOrNull(r.predictedCostUsd),
    predictedInputTokens: numOrNull(r.predictedInputTokens),
    predictedCachedInputTokens: numOrNull(r.predictedCachedInputTokens),
    predictedOutputTokens: numOrNull(r.predictedOutputTokens),
    cqt: numOrNull(r.cqt),
    routingLatencyMs: numOrNull(r.routingLatencyMs),
    baselinePrices: sanitizeBaselinePrices(r.baselinePrices),
    conversationKey: strOrNull(r.conversationKey),
    consideredCandidates: sanitizeConsideredCandidates(r.consideredCandidates),
    inputMessagePreview: strOrNull(r.inputMessagePreview),
  };
}

/**
 * Parses whatever a prior (pre-SQLite) process left in the legacy JSONL
 * file, for one-time import. Missing file (no legacy data) or corrupt lines
 * are tolerated, not fatal, since a mid-append crash could leave a
 * trailing partial line.
 */
function parseLegacyJsonl(filePath: string): RoutingDecisionRow[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return []; // no legacy file -- nothing to migrate
  }
  const rows: RoutingDecisionRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = sanitizeRow(JSON.parse(trimmed));
      if (row) rows.push(row);
    } catch {
      // Corrupt/partially-written line (e.g. a crash mid-append) -- skip it,
      // don't lose every row that came before or after it.
    }
  }
  return rows;
}

/**
 * routing_decisions ledger. Persists to a SQLite database in the router's
 * data directory when `dataDir` is provided (`RoutingDecisionsStore`,
 * packages/node) -- falls back to in-memory-only when `dataDir` is omitted.
 */
export class RoutingLedger {
  private readonly rows: RoutingDecisionRow[];
  // Keyed by the originating client request's requestId -- Router.onResult
  // carries the same requestId selectRoute originally saw, so two
  // concurrent requests routed to the same peer never mis-pair.
  private readonly pendingByRequestId = new Map<string, PendingDecision>();
  private readonly store: RoutingDecisionsStore | null;

  constructor(dataDir?: string) {
    if (dataDir) {
      this.store = new RoutingDecisionsStore(dataDir);
      this._migrateLegacyJsonlIfPresent(dataDir, this.store);
      this.rows = this.store.recent(MAX_LEDGER_ROWS);
    } else {
      this.store = null;
      this.rows = [];
    }
  }

  /**
   * One-time import from a pre-existing `routing-decisions.jsonl` (an older
   * version of this plugin) into the new SQLite store, so upgrading loses no
   * history. Only runs when the store is still empty -- a non-empty store
   * means either this has already run, or the store already has real rows
   * from a source other than that legacy file, and re-importing on top would
   * duplicate them (there's no natural unique key to de-dupe against).
   */
  private _migrateLegacyJsonlIfPresent(dataDir: string, store: RoutingDecisionsStore): void {
    if (store.count() > 0) return;
    const legacyPath = join(dataDir, ROUTING_DECISIONS_FILE);
    const legacyRows = parseLegacyJsonl(legacyPath);
    if (legacyRows.length === 0) return;
    store.insertMany(legacyRows);
    try {
      // Renamed rather than deleted -- kept as a backup/audit trail, and the
      // rename itself is what stops this from re-importing on every future
      // restart once the store already has rows.
      renameSync(legacyPath, `${legacyPath}.migrated`);
    } catch {
      // Rename failing (e.g. permissions) doesn't undo the import; the
      // store.count() > 0 check above already prevents a re-import next time.
    }
  }

  recordPending(requestId: string, pending: PendingDecision): void {
    this.pendingByRequestId.set(requestId, pending);
    while (this.pendingByRequestId.size > MAX_PENDING_DECISIONS) {
      const oldestKey = this.pendingByRequestId.keys().next().value;
      if (oldestKey === undefined) break;
      this.pendingByRequestId.delete(oldestKey);
    }
  }

  recordResult(
    requestId: string,
    peerId: string,
    actual: { promptTokens: number; cachedTokens: number; completionTokens: number; usdcPaid: number | null },
    now = Date.now(),
  ): RoutingDecisionRow | null {
    const pending = this.pendingByRequestId.get(requestId);
    if (!pending) return null;
    this.pendingByRequestId.delete(requestId);

    const row: RoutingDecisionRow = {
      atMs: now,
      actualModel: pending.model,
      actualPeer: peerId,
      actualPromptTokens: actual.promptTokens,
      actualCachedTokens: actual.cachedTokens,
      actualCompletionTokens: actual.completionTokens,
      actualUsdcPaid: actual.usdcPaid,
      predictedCostUsd: pending.predictedCostUsd,
      predictedInputTokens: pending.predictedInputTokens,
      predictedCachedInputTokens: pending.predictedCachedInputTokens,
      predictedOutputTokens: pending.predictedOutputTokens,
      cqt: pending.cqt,
      routingLatencyMs: pending.routingLatencyMs,
      baselinePrices: pending.baselinePrices,
      conversationKey: pending.conversationKey,
      consideredCandidates: pending.consideredCandidates,
      inputMessagePreview: pending.inputMessagePreview,
    };
    this.rows.push(row);
    if (this.rows.length > MAX_LEDGER_ROWS) this.rows.shift();
    this.store?.insert(row);
    return row;
  }

  all(): readonly RoutingDecisionRow[] {
    return this.rows;
  }

  /**
   * SQLite writes are synchronous, so there is nothing to wait for -- kept
   * as an async no-op so callers (tests, graceful-shutdown code) don't need
   * to change.
   */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  /** Test/debug helper -- reads the persisted store directly, bypassing in-memory state. */
  static async readPersistedForTest(dataDir: string): Promise<RoutingDecisionRow[]> {
    const store = new RoutingDecisionsStore(dataDir);
    try {
      return store.recent(MAX_LEDGER_ROWS);
    } finally {
      store.close();
    }
  }
}

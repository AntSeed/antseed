import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutingDecisionsStore, ROUTING_DECISIONS_DB_FILE } from '../src/routing/routing-decisions-store.js';
import { runMigrations } from '../src/storage/migrate.js';
import { migration as firstMigration } from '../src/storage/migrations/routing/001_create_tables.js';
import type { RoutingDecisionRow } from '../src/interfaces/buyer-router.js';

const row: RoutingDecisionRow = {
  atMs: 123, actualModel: 'model', actualPeer: 'peer', actualPromptTokens: 100,
  actualCachedTokens: 20, actualCompletionTokens: 10, actualUsdcPaid: null,
  baselinePrices: {}, consideredCandidates: [], conversationKey: null, routingLatencyMs: null,
};

describe('vendor-neutral routing decision persistence', () => {
  let directory: string;
  let store: RoutingDecisionsStore | undefined;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'router-telemetry-')); });
  afterEach(() => { store?.close(); store = undefined; rmSync(directory, { recursive: true, force: true }); });

  it('persists a forecast-free decision without inventing cost or CQT', () => {
    store = new RoutingDecisionsStore(directory);
    store.insert(row);
    expect(store.recent(1)[0]).toMatchObject({ actualUsdcPaid: null, cqt: null, predictedCostUsd: null,
      predictedInputTokens: null, predictedCachedInputTokens: null, predictedOutputTokens: null });
  });

  it('round-trips partial forecasts and plugin metadata independently', () => {
    store = new RoutingDecisionsStore(directory);
    store.insert({ ...row, predictedInputTokens: 12, actualUsdcPaid: 0, costSource: 'settled',
      routerMetadata: { category: 'coding', confidence: 0.8 } });
    store.close();
    store = new RoutingDecisionsStore(directory);
    expect(store.recent(1)[0]).toMatchObject({ predictedInputTokens: 12, predictedCostUsd: null,
      actualUsdcPaid: 0, costSource: 'settled', routerMetadata: { category: 'coding', confidence: 0.8 } });
  });

  it('upgrades existing v1 rows and indexes, and can reopen without rerunning migration', () => {
    const db = new Database(join(directory, ROUTING_DECISIONS_DB_FILE));
    runMigrations(db, [firstMigration]);
    db.prepare(`INSERT INTO routing_decisions (
      at_ms, actual_model, actual_peer, actual_prompt_tokens, actual_cached_tokens, actual_completion_tokens,
      actual_usdc_paid, cqt, baseline_prices, considered_candidates
    ) VALUES (123, 'old-model', 'old-peer', 100, 20, 10, 0.01, 7, '{}', '[]')`).run();
    db.close();
    store = new RoutingDecisionsStore(directory);
    expect(store.recent(1)[0]).toMatchObject({ actualModel: 'old-model', actualUsdcPaid: 0.01, cqt: 7, costSource: 'estimate' });
    store.insert(row);
    store.close();
    store = new RoutingDecisionsStore(directory);
    expect(store.count()).toBe(2);
    const check = new Database(join(directory, ROUTING_DECISIONS_DB_FILE));
    expect(check.prepare('SELECT COUNT(*) AS count FROM schema_version').get()).toEqual({ count: 2 });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_routing_decisions_%'").all()).toHaveLength(2);
    check.close();
  });

  it('does not serialize invalid forecasts as known zero', () => {
    store = new RoutingDecisionsStore(directory);
    store.insert({ ...row, predictedCostUsd: NaN, predictedInputTokens: -1 });
    expect(store.recent(1)[0]).toMatchObject({ predictedCostUsd: null, predictedInputTokens: null });
  });

  it('bounds persisted history and rejects unbounded query limits', () => {
    store = new RoutingDecisionsStore(directory, 2);
    store.insertMany([1, 2, 3, 4].map((atMs) => ({ ...row, atMs })));
    expect(store.count()).toBe(2);
    expect(store.recent(100).map((entry) => entry.atMs)).toEqual([3, 4]);
    expect(() => store!.recent(-1)).toThrow();
  });
});

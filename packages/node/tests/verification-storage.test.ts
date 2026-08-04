import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/storage/migrate.js';
import { migration as m001 } from '../src/storage/migrations/verification/001_create_tables.js';
import { migration as m002 } from '../src/storage/migrations/verification/002_create_audit_relay_tables.js';
import { migration as m003 } from '../src/storage/migrations/verification/003_create_reference_rotation_tables.js';
import { migration as m004 } from '../src/storage/migrations/verification/004_create_dynamic_reference_catalog.js';
import { migration as m005 } from '../src/storage/migrations/verification/005_replace_audit_relay_tables_with_direct_audits.js';
import { migration as m006 } from '../src/storage/migrations/verification/006_create_benchmark_runs.js';
import { migration as m007 } from '../src/storage/migrations/verification/007_add_benchmark_sizing_policy.js';
import { migration as m008 } from '../src/storage/migrations/verification/008_create_traffic_share_snapshots.js';
import {
  VerificationStorage,
  type StoredBenchmarkRun,
  type StoredBenchmarkTarget,
  type StoredCertifiedKbfProbe,
  type StoredDirectAudit,
  type StoredDirectAuditProbe,
} from '../src/verification/storage.js';

const AUDIT_ID = '0x' + '11'.repeat(32);
const SERVICE = 'gpt-5.6-sol';
const SERVICE_HASH = '0x' + '22'.repeat(32);

function audit(): StoredDirectAudit {
  return {
    auditId: AUDIT_ID,
    state: 'pending',
    source: 'manual',
    epoch: '7',
    verifierAddress: '0x' + '33'.repeat(20),
    agentId: '9',
    sellerAddress: '0x' + '44'.repeat(20),
    targetPeerId: '44'.repeat(20),
    targetService: SERVICE,
    targetServiceHash: SERVICE_HASH,
    referenceId: 'sha256:reference',
    queryProfileHash: 'sha256:profile',
    probeCount: 2,
    authenticatedProbeCount: 0,
    statisticalPower: null,
    verdict: null,
    modelShareBps: null,
    metrics: null,
    evidencePath: null,
    evidenceHash: null,
    evidenceUri: null,
    attestationTxHash: null,
    credited: null,
    startedAt: null,
    completedAt: null,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    failureReason: null,
  };
}

function probe(ordinal: number): StoredDirectAuditProbe {
  return {
    auditId: AUDIT_ID,
    ordinal,
    probeId: `probe-${ordinal}`,
    status: 'selected',
    requestId: null,
    requestHash: null,
    responseHash: null,
    responseAuth: null,
    payment: null,
    timing: null,
    matched: null,
    exposureCountedAt: null,
    failureReason: null,
  };
}

describe('VerificationStorage direct audits', () => {
  let directory: string;
  let storage: VerificationStorage;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'antseed-verification-storage-'));
    storage = new VerificationStorage(join(directory, 'verification.db'));
  });

  afterEach(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stores direct audit state, probe evidence, and exposure reservations', () => {
    storage.saveDirectAudit(audit(), [probe(0), probe(1)]);
    expect(storage.getDirectAudit(AUDIT_ID)?.state).toBe('pending');
    expect(storage.listActiveDirectProbeIds('9', SERVICE)).toEqual(['probe-0', 'probe-1']);

    storage.markDirectAuditProbeExposure(AUDIT_ID, 0, 1_800_000_000_100);
    storage.saveDirectAuditProbe({
      ...probe(0),
      status: 'succeeded',
      requestId: 'request-0',
      requestHash: '0x' + '55'.repeat(32),
      responseHash: '0x' + '66'.repeat(32),
      responseAuth: { verified: true },
      payment: { chargedUsdc: '1200' },
      timing: { ttftMs: 80, outputTokensPerSecondMilli: 20_000 },
      matched: true,
      exposureCountedAt: 1_800_000_000_100,
    });
    const updated = storage.updateDirectAudit(AUDIT_ID, 'attested', {
      authenticatedProbeCount: 1,
      statisticalPower: 0.95,
      verdict: 1,
      modelShareBps: 0,
      metrics: { p50TtftMs: 80 },
      evidencePath: '/tmp/evidence.json',
      evidenceHash: '0x' + '77'.repeat(32),
      attestationTxHash: '0x' + '88'.repeat(32),
      credited: true,
      completedAt: 1_800_000_001_000,
    });

    expect(updated.state).toBe('attested');
    expect(storage.listDirectAuditProbes(AUDIT_ID)[0]).toMatchObject({
      status: 'succeeded',
      matched: true,
      responseAuth: { verified: true },
    });
    expect(storage.getProbeExposureCounts('9', SERVICE).get('probe-0')).toBe(1);
  });

  it('stores a traffic-share snapshot for a direct audit', () => {
    storage.saveDirectAudit(audit());
    storage.saveTrafficShareSnapshot({
      auditId: AUDIT_ID,
      source: 'antscan-ponder-settlement-services-v1',
      epoch: '7',
      windowStartedAt: 1_800_000_000,
      windowEndedAt: 1_800_604_800,
      indexedBlock: 12_345,
      sellerAddress: '0x' + '44'.repeat(20),
      serviceHash: SERVICE_HASH,
      serviceVolumeUsdc: '25',
      sellerVolumeUsdc: '100',
      modelShareBps: 2_500,
      createdAt: 1_800_000_100_000,
    });

    expect(storage.getTrafficShareSnapshot(AUDIT_ID)).toMatchObject({
      epoch: '7',
      indexedBlock: 12_345,
      serviceVolumeUsdc: '25',
      sellerVolumeUsdc: '100',
      modelShareBps: 2_500,
    });
  });

  it('preserves response auth storage', () => {
    storage.insertResponseAuth({
      version: 1,
      requestId: 'request-1',
      channelId: '0x' + '99'.repeat(32),
      buyerPeerId: 'aa'.repeat(20),
      sellerPeerId: 'bb'.repeat(20),
      advertisedService: SERVICE,
      provider: 'openai-responses',
      statusCode: 200,
      requestHash: '0x' + 'cc'.repeat(32),
      responseHash: '0x' + 'dd'.repeat(32),
      responseStartedAt: 100,
      responseCompletedAt: 200,
      signature: '0x1234',
      receivedAt: 210,
      verified: true,
      verificationError: null,
    });

    expect(storage.getResponseAuth('request-1')).toMatchObject({ verified: true, advertisedService: SERVICE });
  });

  it('preserves reference builds and certified probe catalogs', () => {
    storage.upsertReferenceBuild({
      service: SERVICE,
      endpointHash: 'endpoint',
      state: 'ready',
      attempts: 1,
      nextRetryAt: null,
      requestCount: 12,
      referenceId: 'sha256:reference',
      failureReason: null,
      createdAt: 10,
      updatedAt: 20,
    });
    const certified: StoredCertifiedKbfProbe = {
      service: SERVICE,
      certificationHash: 'certification',
      probeId: 'probe-1',
      probe: { id: 'probe-1' },
      certification: { version: 1 },
      queryProfile: { maxTokens: 16 },
      sourceId: 'trusted',
      trust: 'trusted',
      certifiedAt: 10,
      expiresAt: Date.now() + 60_000,
      healthy: true,
      failureReason: null,
      createdAt: 10,
      updatedAt: 10,
    };
    expect(storage.upsertCertifiedKbfProbes([certified])).toEqual({ inserted: 1, known: 0 });
    expect(storage.getReferenceBuild(SERVICE, 'endpoint')?.referenceId).toBe('sha256:reference');
    expect(storage.listCertifiedKbfProbes(SERVICE, 'certification')).toHaveLength(1);
  });

  it('stores benchmark runs, targets, and resumable direct exchanges', () => {
    const run: StoredBenchmarkRun = {
      runId: 'benchmark-1',
      state: 'planned',
      mode: 'observe',
      service: SERVICE,
      epoch: '7',
      referenceId: null,
      certificationHash: null,
      queryProfileHash: null,
      probeSizingMode: 'auto',
      probeCount: 100,
      minimumProbeCount: 100,
      maximumProbeCount: 750,
      probeStep: 10,
      familyWideAlpha: 0.05,
      perPeerAlpha: 0.00625,
      minimumMismatchDelta: 0.1,
      referenceConfidence: 0.99,
      minimumStatisticalPower: 0.9,
      achievedStatisticalPower: null,
      referenceErrorUpperBound: null,
      criticalMismatchCount: null,
      minimumTargetCoverage: 1,
      maxTotalUsdc: '5000000',
      spentUsdc: '0',
      discoveredCount: 1,
      eligibleCount: 1,
      completedCount: 0,
      failedCount: 0,
      referencePath: null,
      failureReason: null,
      createdAt: 100,
      updatedAt: 100,
      completedAt: null,
    };
    const target: StoredBenchmarkTarget = {
      runId: run.runId,
      ordinal: 1,
      peerId: '44'.repeat(20),
      agentId: '9',
      displayName: 'seller',
      publicAddress: 'seller.example:6882',
      advertisedService: SERVICE,
      eligibility: 'eligible',
      state: 'pending',
      eligibilityReason: null,
      auditId: null,
      sellerChargeUsdc: '0',
      failureReason: null,
      createdAt: 100,
      updatedAt: 100,
    };

    storage.saveBenchmarkRun(run);
    storage.saveBenchmarkTargets([target]);
    storage.updateBenchmarkRun(run.runId, { state: 'running', spentUsdc: '25' });
    storage.updateBenchmarkTarget(run.runId, target.peerId, { state: 'running', auditId: AUDIT_ID });
    storage.saveDirectAudit(audit(), [probe(0)]);
    storage.saveDirectAuditExchange({
      auditId: AUDIT_ID,
      batchIndex: 0,
      state: 'succeeded',
      requestId: 'request-0',
      exchange: { requestId: 'request-0', probeIds: ['probe-0'] },
      sellerChargeUsdc: '25',
      startedAt: 100,
      completedAt: 200,
      failureReason: null,
    });

    expect(storage.getBenchmarkRun(run.runId)).toMatchObject({ state: 'running', spentUsdc: '25' });
    expect(storage.listBenchmarkTargets(run.runId)[0]).toMatchObject({ state: 'running', auditId: AUDIT_ID });
    expect(storage.listDirectAuditExchanges(AUDIT_ID)[0]).toMatchObject({
      state: 'succeeded',
      exchange: { requestId: 'request-0', probeIds: ['probe-0'] },
    });

    const finalAuditId = '0x' + '99'.repeat(32);
    storage.finalizeDirectAuditId(AUDIT_ID, finalAuditId);
    expect(storage.listDirectAuditExchanges(finalAuditId)).toHaveLength(1);
    expect(storage.listBenchmarkTargets(run.runId)[0]?.auditId).toBe(finalAuditId);
  });
});

describe('verification migration 005', () => {
  it('copies reusable selections, preserves catalogs, and drops relay tables', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, [m001, m002, m003, m004]);
    db.prepare(`
      INSERT INTO audit_plans (
        audit_id, state, source, duration_ms, verifier_address, agent_id,
        target_peer_id, target_service, target_service_hash, reference_id,
        query_profile_hash, probe_count, job_timeout_ms, evidence_state,
        created_at, updated_at
      ) VALUES (?, 'planned', 'manual', 86400000, ?, ?, ?, ?, ?, ?, ?, 10, 120000, 'none', ?, ?)
    `).run(
      AUDIT_ID,
      '0x' + '33'.repeat(20),
      '9',
      '44'.repeat(20),
      SERVICE,
      SERVICE_HASH,
      'sha256:reference',
      'sha256:profile',
      100,
      100,
    );
    db.prepare(`
      INSERT INTO audit_probe_selections (audit_id, ordinal, job_index, probe_id)
      VALUES (?, 0, 0, 'probe-0')
    `).run(AUDIT_ID);

    runMigrations(db, [m005]);

    expect(db.prepare('SELECT state, reference_id FROM direct_audits WHERE audit_id = ?').get(AUDIT_ID)).toEqual({
      state: 'pending',
      reference_id: 'sha256:reference',
    });
    expect(db.prepare('SELECT probe_id FROM direct_audit_probes WHERE audit_id = ?').get(AUDIT_ID)).toEqual({
      probe_id: 'probe-0',
    });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(tables.has('direct_audits')).toBe(true);
    expect(tables.has('direct_audit_probes')).toBe(true);
    expect(tables.has('response_auths')).toBe(true);
    expect(tables.has('reference_builds')).toBe(true);
    expect(tables.has('certified_kbf_probes')).toBe(true);
    expect(tables.has('certified_kbf_imports')).toBe(true);
    expect(tables.has('probe_exposures')).toBe(true);
    expect(tables.has('audit_plans')).toBe(false);
    expect(tables.has('audit_jobs')).toBe(false);
    expect(tables.has('relay_entitlements')).toBe(false);
    expect(tables.has('audit_rounds')).toBe(false);
    db.close();
  });
});

describe('verification migration 006', () => {
  it('adds benchmark tables without changing existing direct audits or catalogs', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, [m001, m002, m003, m004, m005]);
    db.prepare(`
      INSERT INTO direct_audits (
        audit_id, state, source, target_peer_id, target_service,
        probe_count, authenticated_probe_count, created_at, updated_at
      ) VALUES (?, 'pending', 'manual', ?, ?, 10, 0, 100, 100)
    `).run(AUDIT_ID, '44'.repeat(20), SERVICE);
    db.prepare(`
      INSERT INTO certified_kbf_probes (
        service, certification_hash, probe_id, probe_json, certification_json,
        query_profile_json, source_id, trust, certified_at, expires_at,
        healthy, created_at, updated_at
      ) VALUES (?, 'cert', 'probe-1', '{}', '{}', '{}', 'source', 'smoke', 1, 999999, 1, 1, 1)
    `).run(SERVICE);

    runMigrations(db, [m006]);

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(tables.has('benchmark_runs')).toBe(true);
    expect(tables.has('benchmark_targets')).toBe(true);
    expect(tables.has('direct_audit_exchanges')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM direct_audits').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM certified_kbf_probes').get()).toEqual({ count: 1 });
    db.close();
  });
});

describe('verification migration 007', () => {
  it('adds benchmark sizing columns without changing existing runs', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, [m001, m002, m003, m004, m005, m006]);
    db.prepare(`
      INSERT INTO benchmark_runs (
        run_id, state, mode, service, probe_count, max_total_usdc,
        created_at, updated_at
      ) VALUES ('run-1', 'planned', 'observe', ?, 100, '1000', 1, 1)
    `).run(SERVICE);

    runMigrations(db, [m007]);

    const row = db.prepare(`
      SELECT probe_sizing_mode, minimum_probe_count, family_wide_alpha
      FROM benchmark_runs WHERE run_id = 'run-1'
    `).get();
    expect(row).toEqual({
      probe_sizing_mode: 'fixed',
      minimum_probe_count: null,
      family_wide_alpha: null,
    });
    db.close();
  });
});

describe('verification migration 008', () => {
  it('adds seller attribution and traffic-share snapshots without changing audits', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, [m001, m002, m003, m004, m005, m006, m007]);
    db.prepare(`
      INSERT INTO direct_audits (
        audit_id, state, source, target_peer_id, target_service,
        probe_count, authenticated_probe_count, created_at, updated_at
      ) VALUES (?, 'pending', 'manual', ?, ?, 10, 0, 100, 100)
    `).run(AUDIT_ID, '44'.repeat(20), SERVICE);

    runMigrations(db, [m008]);

    const columns = new Set(
      (db.pragma('table_info(direct_audits)') as Array<{ name: string }>).map((column) => column.name),
    );
    expect(columns.has('seller_address')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM direct_audits').get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'traffic_share_snapshots'
    `).get()).toEqual({ name: 'traffic_share_snapshots' });
    db.close();
  });
});

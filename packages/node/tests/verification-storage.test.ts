import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServiceMetadataId } from '../src/payments/evm/signatures.js';
import { runMigrations } from '../src/storage/migrate.js';
import { migration as verificationMigration001 } from '../src/storage/migrations/verification/001_create_tables.js';
import { migration as verificationMigration002 } from '../src/storage/migrations/verification/002_create_audit_relay_tables.js';
import { migration as verificationMigration003 } from '../src/storage/migrations/verification/003_create_reference_rotation_tables.js';
import {
  VerificationStorage,
  type StoredAuditJob,
  type StoredAuditPlan,
  type StoredCertifiedKbfProbe,
  type StoredRelayEntitlement,
} from '../src/verification/storage.js';

const AUDIT_ID = '0x' + '11'.repeat(32);
const CHANNEL_ID = '0x' + '22'.repeat(32);
const SERVICE = 'gpt-5.6-sol';
const SERVICE_HASH = getServiceMetadataId(SERVICE);

function plan(jobCount = 1): StoredAuditPlan {
  return {
    auditId: AUDIT_ID,
    state: 'planned',
    source: 'manual',
    epoch: '1',
    durationMs: 86_400_000,
    chainId: 'base-local',
    registryAddress: '0x' + '33'.repeat(20),
    treasuryAddress: '0x' + '44'.repeat(20),
    verifierAddress: '0x' + '55'.repeat(20),
    agentId: '7',
    targetPeerId: '66'.repeat(20),
    targetService: SERVICE,
    targetServiceHash: SERVICE_HASH,
    targetSalt: '0x' + '77'.repeat(32),
    targetCommitment: '0x' + '88'.repeat(32),
    probeRoot: '0x' + '99'.repeat(32),
    auditJobRoot: '0x' + 'aa'.repeat(32),
    referenceId: '0x' + 'bb'.repeat(32),
    queryProfileHash: '0x' + 'cc'.repeat(32),
    verifierConfigHash: '0x' + 'dd'.repeat(32),
    probeCount: jobCount * 10,
    jobCount,
    requiredRelayCount: 1,
    jobTimeoutMs: 45_000,
    payoutPerJobUsdc: 2500n,
    reservedBudgetUsdc: 2500n * BigInt(jobCount),
    commitTxHash: null,
    attestationTxHash: null,
    evidenceHash: null,
    evidenceUri: null,
    evidenceState: 'none',
    executeAfter: 1_800_000_000,
    executeBefore: 1_800_000_600,
    forceClaimAvailableAt: 1_800_022_200,
    forceClaimDeadline: 1_802_614_200,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    failureReason: null,
  };
}

function job(jobIndex = 0): StoredAuditJob {
  return {
    auditId: AUDIT_ID,
    jobIndex,
    state: 'assigned',
    scheduledAt: 1_800_000_000_000,
    relayPeerId: 'ee'.repeat(20),
    relayBuyerAddress: '0x' + 'ee'.repeat(20),
    assignmentAttempt: 0,
    assignmentSignature: '0x' + 'ab'.repeat(65),
    assignmentState: 'assigned',
    assignedAt: 1_800_000_000_000,
    lastDispatchAt: null,
    sellerPeerId: '66'.repeat(20),
    service: SERVICE,
    serviceHash: SERVICE_HASH,
    requestHash: `0x${(jobIndex + 1).toString(16).padStart(64, '0')}`,
    jobSalt: `0x${(jobIndex + 100).toString(16).padStart(64, '0')}`,
    executeAfter: 1_800_000_000,
    executeBefore: 1_800_000_600,
    requestBytes: new TextEncoder().encode(`request-${jobIndex}`),
    positionalProof: ['0x' + 'ff'.repeat(32)],
    responseBytes: null,
    responseAuthPayload: null,
    sellerChargeUsdc: null,
    paymentMetadata: null,
    dispatchedAt: null,
    completedAt: null,
    failureKind: null,
    failureMessage: null,
    entitlementPersistedAt: null,
  };
}

function paymentMetadata(cumulativeAmount = '2500'): Record<string, unknown> {
  return {
    spendingAuth: {
      channelId: CHANNEL_ID,
      cumulativeAmount,
      metadataHash: '0x' + '12'.repeat(32),
    },
  };
}

function entitlement(): StoredRelayEntitlement {
  return {
    auditId: AUDIT_ID,
    jobIndex: 0,
    relayPeerId: 'ee'.repeat(20),
    relayBuyerAddress: '0x' + 'ee'.repeat(20),
    registryAddress: '0x' + '33'.repeat(20),
    treasuryAddress: '0x' + '44'.repeat(20),
    job: {
      auditId: AUDIT_ID,
      jobIndex: 0,
      sellerPeerId: '0x' + '66'.repeat(20),
      serviceHash: SERVICE_HASH,
      requestHash: job().requestHash,
      jobSalt: job().jobSalt,
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
    },
    positionalProof: ['0x' + 'ff'.repeat(32)],
    assignment: {
      auditId: AUDIT_ID,
      jobIndex: 0,
      attempt: 0,
      relayBuyer: '0x' + 'ee'.repeat(20),
      payoutPerJobUsdc: '2500',
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
    },
    verifierSignature: '0x' + 'ab'.repeat(65),
    responseBytes: new Uint8Array([4, 5, 6]),
    responseAuthPayload: new Uint8Array([1, 2, 3]),
    payoutUsdc: 2500n,
    sellerChargeUsdc: 2000n,
    paymentMetadata: paymentMetadata(),
    forceClaimAvailableAt: 1_800_022_200,
    forceClaimDeadline: 1_802_614_200,
    state: 'awaiting-attestation',
    claimTxHash: null,
    createdAt: 1_800_000_100_000,
    updatedAt: 1_800_000_100_000,
  };
}

describe('VerificationStorage audit and relay durability', () => {
  let tempDir: string;
  let dbPath: string;
  let storage: VerificationStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'verification-storage-'));
    dbPath = join(tempDir, 'verification.db');
    storage = new VerificationStorage(dbPath);
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies consolidated migration 002 and persists the audit runtime timeout', () => {
    storage.saveAuditPlan(plan(), [job()]);
    expect(storage.getAuditPlan(AUDIT_ID)?.jobTimeoutMs).toBe(45_000);
    const db = (storage as unknown as { _db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } })._db;
    const columns = db.prepare('PRAGMA table_info(audit_plans)').all().map((column) => column.name);
    expect(columns).toContain('job_timeout_ms');
    const chargeTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_job_charges'").all();
    expect(chargeTable).toHaveLength(1);
    const versions = (storage as unknown as {
      _db: { prepare: (sql: string) => { all: () => Array<{ version: number }> } };
    })._db.prepare('SELECT version FROM schema_version ORDER BY version').all();
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    for (const table of [
      'reference_builds', 'audit_probe_selections', 'probe_exposures',
      'certified_kbf_probes', 'certified_kbf_imports', 'audit_rounds', 'audit_round_members',
    ]) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).all()).toEqual([
        { name: table },
      ]);
    }
  });

  it('upgrades a version-1 verification database through consolidated migration 002', () => {
    storage.close();
    const legacyPath = join(tempDir, 'legacy-verification.db');
    const legacyDb = new Database(legacyPath);
    runMigrations(legacyDb, [verificationMigration001]);
    legacyDb.close();

    storage = new VerificationStorage(legacyPath);
    const db = (storage as unknown as {
      _db: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } };
    })._db;
    expect(db.prepare('SELECT version FROM schema_version ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_plans'").all()).toEqual([
      { name: 'audit_plans' },
    ]);
  });

  it('persists reference build state and normalizes service identity', () => {
    storage.upsertReferenceBuild({
      service: ' GPT-5.6-SOL ',
      endpointHash: '0x' + '12'.repeat(32),
      state: 'backoff',
      attempts: 2,
      nextRetryAt: 1_800_000_060_000,
      requestCount: 73,
      referenceId: null,
      failureReason: 'temporary upstream failure',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_001_000,
    });
    expect(storage.getReferenceBuild(SERVICE, '0x' + '12'.repeat(32))).toMatchObject({
      service: SERVICE,
      state: 'backoff',
      attempts: 2,
      requestCount: 73,
    });
  });

  it('reserves probes and counts each dispatched job exposure idempotently', () => {
    const probes = Array.from({ length: 20 }, (_, index) => `probe-${String(index).padStart(2, '0')}`);
    storage.saveAuditPlan(plan(2), [job(0), job(1)]);
    storage.reserveAuditProbes(AUDIT_ID, probes);

    expect(storage.listActiveReservedProbeIds('7', SERVICE)).toEqual(probes);
    storage.markAuditJobProbeExposure(AUDIT_ID, 0, 1_800_000_100_000);
    storage.markAuditJobProbeExposure(AUDIT_ID, 0, 1_800_000_101_000);

    const counts = storage.getProbeExposureCounts('7', SERVICE);
    expect(Array.from(counts.entries())).toEqual(probes.slice(0, 10).map((probeId) => [probeId, 1]));
    expect(storage.listAuditProbeSelections(AUDIT_ID).filter((selection) => selection.exposureCountedAt !== null))
      .toHaveLength(10);

    storage.releaseUnexposedAuditProbeReservations(AUDIT_ID);
    expect(storage.listAuditProbeSelections(AUDIT_ID).map((selection) => selection.probeId)).toEqual(probes.slice(0, 10));
  });

  it('collapses historical exposure across reference ids and isolates other agents', () => {
    storage.close();
    const legacyPath = join(tempDir, 'rotation-v3.db');
    const legacyDb = new Database(legacyPath);
    runMigrations(legacyDb, [verificationMigration001, verificationMigration002, verificationMigration003]);
    const insert = legacyDb.prepare(`
      INSERT INTO probe_exposures (
        agent_id, service, reference_id, probe_id, exposure_count, last_audit_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('7', SERVICE, 'ref-a', 'shared-probe', 2, 'audit-a', 100);
    insert.run('7', SERVICE, 'ref-b', 'shared-probe', 1, 'audit-b', 200);
    legacyDb.close();

    storage = new VerificationStorage(legacyPath);
    expect(Array.from(storage.getProbeExposureCounts('7', SERVICE))).toEqual([['shared-probe', 1]]);
    expect(storage.getProbeExposureCounts('8', SERVICE).size).toBe(0);
  });

  it('persists certified probes and durable round membership', () => {
    const now = 1_800_000_000_000;
    const probe: StoredCertifiedKbfProbe = {
      service: SERVICE,
      certificationHash: 'sha256:profile',
      probeId: 'probe-1',
      probe: { id: 'probe-1', consensus: 42 },
      certification: { stable: true },
      queryProfile: { version: 1 },
      sourceId: 'venice-smoke',
      trust: 'smoke',
      certifiedAt: now,
      expiresAt: now + 60_000,
      healthy: true,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(storage.upsertCertifiedKbfProbes([probe])).toEqual({ inserted: 1, known: 0 });
    expect(storage.upsertCertifiedKbfProbes([probe])).toEqual({ inserted: 0, known: 1 });
    expect(storage.countCertifiedKbfProbes(SERVICE, probe.certificationHash, now)).toBe(1);

    storage.saveAuditPlan(plan());
    storage.saveAuditRound({
      roundId: 'round-1',
      service: SERVICE,
      endpointHash: 'sha256:endpoint',
      epoch: '1',
      state: 'preparing',
      attempts: 0,
      nextRetryAt: null,
      targetCount: 1,
      generatedProbeCount: 1,
      requestCount: 4,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    }, [{
      roundId: 'round-1',
      auditId: AUDIT_ID,
      state: 'prepared',
      referenceId: 'sha256:reference',
      probeCount: 100,
      cachedProbeCount: 90,
      generatedProbeCount: 10,
      createdAt: now,
      updatedAt: now,
    }]);
    expect(storage.getAuditRound('round-1')).toMatchObject({ state: 'preparing', requestCount: 4 });
    expect(storage.getAuditRoundMemberByAuditId(AUDIT_ID)).toMatchObject({ probeCount: 100, cachedProbeCount: 90 });
  });

  it('replaces stale planned jobs when an uncommitted audit is re-prepared', () => {
    storage.saveAuditPlan(plan(2), [job(0), job(1)]);
    storage.saveAuditPlan(plan(1), [job(0)], { replaceJobs: true });
    expect(storage.listAuditJobs(AUDIT_ID).map((stored) => stored.jobIndex)).toEqual([0]);
  });

  it('rolls back a torn verifier write when normalized payment metadata is invalid', () => {
    storage.saveAuditPlan(plan(), [job()]);
    expect(() => storage.persistAuditJobSuccess({
      auditId: AUDIT_ID,
      jobIndex: 0,
      responseBytes: new Uint8Array([1]),
      responseAuthPayload: new Uint8Array([2]),
      sellerChargeUsdc: 2000n,
      paymentMetadata: {},
    })).toThrow(/no SpendingAuth/);
    expect(storage.listAuditJobs(AUDIT_ID)[0]).toMatchObject({
      state: 'assigned',
      responseBytes: null,
      sellerChargeUsdc: null,
    });
  });

  it('atomically rolls back the job update when entitlement insertion conflicts', () => {
    storage.saveAuditPlan(plan(), [job()]);
    storage.persistRelayEntitlement(entitlement());
    expect(() => storage.persistRelaySuccess({
      auditId: AUDIT_ID,
      jobIndex: 0,
      responseBytes: new Uint8Array([9]),
      entitlement: entitlement(),
    })).toThrow();
    expect(storage.listAuditJobs(AUDIT_ID)[0]).toMatchObject({
      state: 'assigned',
      responseBytes: null,
      entitlementPersistedAt: null,
    });
  });

  it('recovers persisted entitlements and audit charges after restart', () => {
    storage.saveAuditPlan(plan(), [job()]);
    storage.persistAuditJobSuccess({
      auditId: AUDIT_ID,
      jobIndex: 0,
      responseBytes: new Uint8Array([1]),
      responseAuthPayload: new Uint8Array([2]),
      sellerChargeUsdc: 2000n,
      paymentMetadata: paymentMetadata(),
    });
    storage.persistRelayEntitlement(entitlement());
    storage.close();
    storage = new VerificationStorage(dbPath);

    expect(storage.getRelayEntitlement(AUDIT_ID, 0)).toMatchObject({
      payoutUsdc: 2500n,
      sellerChargeUsdc: 2000n,
      state: 'awaiting-attestation',
    });
    expect(storage.auditChargeForSettlement(CHANNEL_ID, SERVICE_HASH, 0n, 2500n)).toBe(2000n);
    expect(() => storage.persistRelayEntitlement(entitlement())).toThrow();
  });

  it('deduplicates finalized logs and computes modelShareBps from organic usage', () => {
    const channelsAddress = '0x' + 'ab'.repeat(20);
    const baseEvent = {
      chainId: '31337',
      channelsAddress,
      txHash: '0x' + 'cd'.repeat(32),
      logIndex: 0,
      blockNumber: 10,
      blockHash: '0x' + 'de'.repeat(32),
      settledAt: 1_800_000_000_000,
      channelId: CHANNEL_ID,
      agentId: '7',
      sellerPeerId: '66'.repeat(20),
      cumulativeServiceUsdc: 60n,
      serviceDeltaUsdc: 60n,
      cumulativeChannelUsdc: 60n,
      channelDeltaUsdc: 60n,
      auditChargeUsdc: 10n,
      organicServiceDeltaUsdc: 50n,
    };
    expect(storage.recordFinalizedSettlement({ ...baseEvent, service: SERVICE_HASH })).toBe(true);
    expect(storage.recordFinalizedSettlement({ ...baseEvent, service: SERVICE_HASH })).toBe(false);
    expect(storage.recordFinalizedSettlement({
      ...baseEvent,
      txHash: '0x' + 'ef'.repeat(32),
      logIndex: 1,
      service: getServiceMetadataId('other-service'),
      cumulativeServiceUsdc: 50n,
      serviceDeltaUsdc: 50n,
      auditChargeUsdc: 0n,
      organicServiceDeltaUsdc: 50n,
    })).toBe(true);
    expect(storage.computeModelShareBps('7', SERVICE, 1_799_999_999_000, 1_800_000_001_000)).toBe(5000);
    expect(storage.computeModelShareBps('8', SERVICE, 1_799_999_999_000, 1_800_000_001_000)).toBe(0);
  });
});

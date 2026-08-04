import Database from 'better-sqlite3';
import { runMigrations } from '../storage/migrate.js';
import { verificationMigrations } from '../storage/migrations/verification/index.js';
import type { ResponseAuthPayload } from '../types/protocol.js';

export interface StoredResponseAuth extends ResponseAuthPayload {
  receivedAt: number;
  verified: boolean;
  verificationError: string | null;
}

export type DirectAuditState = 'pending' | 'running' | 'completed' | 'attested' | 'failed';
export type DirectAuditSource = 'manual' | 'automatic';

export interface StoredDirectAudit {
  auditId: string;
  state: DirectAuditState;
  source: DirectAuditSource;
  epoch: string | null;
  verifierAddress: string | null;
  agentId: string | null;
  sellerAddress: string | null;
  targetPeerId: string;
  targetService: string;
  targetServiceHash: string | null;
  referenceId: string | null;
  queryProfileHash: string | null;
  probeCount: number;
  authenticatedProbeCount: number;
  statisticalPower: number | null;
  verdict: number | null;
  modelShareBps: number | null;
  metrics: Record<string, unknown> | null;
  evidencePath: string | null;
  evidenceHash: string | null;
  evidenceUri: string | null;
  attestationTxHash: string | null;
  credited: boolean | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  failureReason: string | null;
}

export type DirectAuditProbeStatus = 'selected' | 'succeeded' | 'failed';

export interface StoredDirectAuditProbe {
  auditId: string;
  ordinal: number;
  probeId: string;
  status: DirectAuditProbeStatus;
  requestId: string | null;
  requestHash: string | null;
  responseHash: string | null;
  responseAuth: Record<string, unknown> | null;
  payment: Record<string, unknown> | null;
  timing: Record<string, unknown> | null;
  matched: boolean | null;
  exposureCountedAt: number | null;
  failureReason: string | null;
}

export type BenchmarkRunState = 'planned' | 'preparing' | 'running' | 'completed' | 'failed';

export interface StoredBenchmarkRun {
  runId: string;
  state: BenchmarkRunState;
  mode: 'observe';
  service: string;
  epoch: string | null;
  referenceId: string | null;
  certificationHash: string | null;
  queryProfileHash: string | null;
  probeSizingMode: 'fixed' | 'auto';
  probeCount: number;
  minimumProbeCount: number | null;
  maximumProbeCount: number | null;
  probeStep: number | null;
  familyWideAlpha: number | null;
  perPeerAlpha: number | null;
  minimumMismatchDelta: number | null;
  referenceConfidence: number | null;
  minimumStatisticalPower: number | null;
  achievedStatisticalPower: number | null;
  referenceErrorUpperBound: number | null;
  criticalMismatchCount: number | null;
  minimumTargetCoverage: number | null;
  maxTotalUsdc: string;
  spentUsdc: string;
  discoveredCount: number;
  eligibleCount: number;
  completedCount: number;
  failedCount: number;
  referencePath: string | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type BenchmarkTargetState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StoredBenchmarkTarget {
  runId: string;
  ordinal: number;
  peerId: string;
  agentId: string | null;
  displayName: string | null;
  publicAddress: string | null;
  advertisedService: string;
  eligibility: 'eligible' | 'ineligible';
  state: BenchmarkTargetState;
  eligibilityReason: string | null;
  auditId: string | null;
  sellerChargeUsdc: string;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredDirectAuditExchange {
  auditId: string;
  batchIndex: number;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  requestId: string | null;
  exchange: Record<string, unknown> | null;
  sellerChargeUsdc: string;
  startedAt: number | null;
  completedAt: number | null;
  failureReason: string | null;
}

export interface StoredTrafficShareSnapshot {
  auditId: string;
  source: string;
  epoch: string;
  windowStartedAt: number;
  windowEndedAt: number;
  indexedBlock: number;
  sellerAddress: string;
  serviceHash: string;
  serviceVolumeUsdc: string;
  sellerVolumeUsdc: string;
  modelShareBps: number;
  createdAt: number;
}

export type ReferenceBuildState = 'missing' | 'building' | 'ready' | 'backoff' | 'failed';

export interface StoredReferenceBuild {
  service: string;
  endpointHash: string;
  state: ReferenceBuildState;
  attempts: number;
  nextRetryAt: number | null;
  requestCount: number;
  referenceId: string | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredCertifiedKbfProbe {
  service: string;
  certificationHash: string;
  probeId: string;
  probe: Record<string, unknown>;
  certification: Record<string, unknown>;
  queryProfile: Record<string, unknown>;
  sourceId: string;
  trust: 'smoke' | 'trusted';
  certifiedAt: number;
  expiresAt: number;
  healthy: boolean;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export class VerificationStorage {
  private readonly _db: Database.Database;
  private readonly _insertResponseAuth: Database.Statement;
  private readonly _getResponseAuth: Database.Statement;
  private readonly _listResponseAuthsBySeller: Database.Statement;

  constructor(dbPath: string) {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    runMigrations(this._db, verificationMigrations);

    this._insertResponseAuth = this._db.prepare(`
      INSERT INTO response_auths (
        request_id, version, channel_id, buyer_peer_id, seller_peer_id,
        advertised_service, provider, status_code, request_hash, response_hash,
        response_started_at, response_completed_at, signature,
        received_at, verified, verification_error
      ) VALUES (
        @requestId, @version, @channelId, @buyerPeerId, @sellerPeerId,
        @advertisedService, @provider, @statusCode, @requestHash, @responseHash,
        @responseStartedAt, @responseCompletedAt, @signature,
        @receivedAt, @verified, @verificationError
      )
      ON CONFLICT(request_id) DO UPDATE SET
        version = excluded.version,
        channel_id = excluded.channel_id,
        buyer_peer_id = excluded.buyer_peer_id,
        seller_peer_id = excluded.seller_peer_id,
        advertised_service = excluded.advertised_service,
        provider = excluded.provider,
        status_code = excluded.status_code,
        request_hash = excluded.request_hash,
        response_hash = excluded.response_hash,
        response_started_at = excluded.response_started_at,
        response_completed_at = excluded.response_completed_at,
        signature = excluded.signature,
        received_at = excluded.received_at,
        verified = excluded.verified,
        verification_error = excluded.verification_error
    `);
    this._getResponseAuth = this._db.prepare('SELECT * FROM response_auths WHERE request_id = ?');
    this._listResponseAuthsBySeller = this._db.prepare(
      'SELECT * FROM response_auths WHERE seller_peer_id = ? ORDER BY received_at DESC LIMIT ?',
    );
  }

  insertResponseAuth(record: StoredResponseAuth): void {
    this._insertResponseAuth.run({
      requestId: record.requestId,
      version: record.version,
      channelId: record.channelId ?? null,
      buyerPeerId: record.buyerPeerId,
      sellerPeerId: record.sellerPeerId,
      advertisedService: record.advertisedService,
      provider: record.provider,
      statusCode: record.statusCode,
      requestHash: record.requestHash,
      responseHash: record.responseHash,
      responseStartedAt: record.responseStartedAt,
      responseCompletedAt: record.responseCompletedAt,
      signature: record.signature,
      receivedAt: record.receivedAt,
      verified: record.verified ? 1 : 0,
      verificationError: record.verificationError,
    });
  }

  getResponseAuth(requestId: string): StoredResponseAuth | null {
    const row = this._getResponseAuth.get(requestId) as ResponseAuthRow | undefined;
    return row ? rowToResponseAuth(row) : null;
  }

  listResponseAuthsBySeller(sellerPeerId: string, limit = 100): StoredResponseAuth[] {
    const rows = this._listResponseAuthsBySeller.all(sellerPeerId, Math.max(1, limit)) as ResponseAuthRow[];
    return rows.map(rowToResponseAuth);
  }

  saveDirectAudit(audit: StoredDirectAudit, probes: readonly StoredDirectAuditProbe[] = []): void {
    const statement = this._db.prepare(`
      INSERT INTO direct_audits (
        audit_id, state, source, epoch, verifier_address, agent_id,
        seller_address, target_peer_id, target_service, target_service_hash, reference_id,
        query_profile_hash, probe_count, authenticated_probe_count,
        statistical_power, verdict, model_share_bps, metrics_json,
        evidence_path, evidence_hash, evidence_uri, attestation_tx_hash,
        credited, started_at, completed_at, created_at, updated_at, failure_reason
      ) VALUES (
        @auditId, @state, @source, @epoch, @verifierAddress, @agentId,
        @sellerAddress, @targetPeerId, @targetService, @targetServiceHash, @referenceId,
        @queryProfileHash, @probeCount, @authenticatedProbeCount,
        @statisticalPower, @verdict, @modelShareBps, @metricsJson,
        @evidencePath, @evidenceHash, @evidenceUri, @attestationTxHash,
        @credited, @startedAt, @completedAt, @createdAt, @updatedAt, @failureReason
      ) ON CONFLICT(audit_id) DO UPDATE SET
        state = excluded.state,
        source = excluded.source,
        epoch = excluded.epoch,
        verifier_address = excluded.verifier_address,
        agent_id = excluded.agent_id,
        seller_address = excluded.seller_address,
        target_peer_id = excluded.target_peer_id,
        target_service = excluded.target_service,
        target_service_hash = excluded.target_service_hash,
        reference_id = excluded.reference_id,
        query_profile_hash = excluded.query_profile_hash,
        probe_count = excluded.probe_count,
        authenticated_probe_count = excluded.authenticated_probe_count,
        statistical_power = excluded.statistical_power,
        verdict = excluded.verdict,
        model_share_bps = excluded.model_share_bps,
        metrics_json = excluded.metrics_json,
        evidence_path = excluded.evidence_path,
        evidence_hash = excluded.evidence_hash,
        evidence_uri = excluded.evidence_uri,
        attestation_tx_hash = excluded.attestation_tx_hash,
        credited = excluded.credited,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at,
        failure_reason = excluded.failure_reason
    `);
    this._db.transaction(() => {
      statement.run(serializeDirectAudit(audit));
      for (const probe of probes) this.saveDirectAuditProbe(probe);
    })();
  }

  getDirectAudit(auditId: string): StoredDirectAudit | null {
    const row = this._db.prepare('SELECT * FROM direct_audits WHERE audit_id = ?').get(auditId) as DirectAuditRow | undefined;
    return row ? rowToDirectAudit(row) : null;
  }

  listDirectAudits(state?: DirectAuditState): StoredDirectAudit[] {
    const rows = state
      ? this._db.prepare('SELECT * FROM direct_audits WHERE state = ? ORDER BY created_at DESC').all(state)
      : this._db.prepare('SELECT * FROM direct_audits ORDER BY created_at DESC').all();
    return (rows as DirectAuditRow[]).map(rowToDirectAudit);
  }

  latestDirectAudit(agentId: string, serviceHash: string): StoredDirectAudit | null {
    const row = this._db.prepare(`
      SELECT * FROM direct_audits
      WHERE agent_id = ? AND lower(target_service_hash) = lower(?)
      ORDER BY created_at DESC LIMIT 1
    `).get(agentId, serviceHash) as DirectAuditRow | undefined;
    return row ? rowToDirectAudit(row) : null;
  }

  countDirectAuditsForEpoch(epoch: string, verifierAddress?: string): number {
    const row = verifierAddress
      ? this._db.prepare(`
          SELECT COUNT(*) AS count FROM direct_audits
          WHERE epoch = ? AND lower(verifier_address) = lower(?) AND state IN ('completed', 'attested')
        `).get(epoch, verifierAddress)
      : this._db.prepare(`
          SELECT COUNT(*) AS count FROM direct_audits
          WHERE epoch = ? AND state IN ('completed', 'attested')
        `).get(epoch);
    return Number((row as { count: number }).count);
  }

  updateDirectAudit(
    auditId: string,
    state: DirectAuditState,
    fields: Partial<Omit<StoredDirectAudit, 'auditId' | 'state' | 'createdAt'>> = {},
  ): StoredDirectAudit {
    const current = this.getDirectAudit(auditId);
    if (!current) throw new Error(`unknown direct audit ${auditId}`);
    const next: StoredDirectAudit = {
      ...current,
      ...fields,
      auditId,
      state,
      createdAt: current.createdAt,
      updatedAt: fields.updatedAt ?? Date.now(),
    };
    this.saveDirectAudit(next);
    return next;
  }

  finalizeDirectAuditId(currentAuditId: string, finalAuditId: string): StoredDirectAudit {
    if (currentAuditId === finalAuditId) {
      const current = this.getDirectAudit(currentAuditId);
      if (!current) throw new Error(`unknown direct audit ${currentAuditId}`);
      return current;
    }
    this._db.transaction(() => {
      if (this.getDirectAudit(finalAuditId)) throw new Error(`direct audit ${finalAuditId} already exists`);
      const inserted = this._db.prepare(`
        INSERT INTO direct_audits (
          audit_id, state, source, epoch, verifier_address, agent_id,
          seller_address, target_peer_id, target_service, target_service_hash, reference_id,
          query_profile_hash, probe_count, authenticated_probe_count,
          statistical_power, verdict, model_share_bps, metrics_json,
          evidence_path, evidence_hash, evidence_uri, attestation_tx_hash,
          credited, started_at, completed_at, created_at, updated_at, failure_reason
        )
        SELECT ?, state, source, epoch, verifier_address, agent_id,
          seller_address, target_peer_id, target_service, target_service_hash, reference_id,
          query_profile_hash, probe_count, authenticated_probe_count,
          statistical_power, verdict, model_share_bps, metrics_json,
          evidence_path, evidence_hash, evidence_uri, attestation_tx_hash,
          credited, started_at, completed_at, created_at, updated_at, failure_reason
        FROM direct_audits WHERE audit_id = ?
      `).run(finalAuditId, currentAuditId);
      if (inserted.changes !== 1) throw new Error(`unknown direct audit ${currentAuditId}`);
      this._db.prepare(`
        INSERT INTO direct_audit_probes (
          audit_id, ordinal, probe_id, status, request_id, request_hash,
          response_hash, response_auth_json, payment_json, timing_json,
          matched, exposure_counted_at, failure_reason
        )
        SELECT ?, ordinal, probe_id, status, request_id, request_hash,
          response_hash, response_auth_json, payment_json, timing_json,
          matched, exposure_counted_at, failure_reason
        FROM direct_audit_probes WHERE audit_id = ?
      `).run(finalAuditId, currentAuditId);
      this._db.prepare(`
        INSERT INTO direct_audit_exchanges (
          audit_id, batch_index, state, request_id, exchange_json,
          seller_charge_usdc, started_at, completed_at, failure_reason
        )
        SELECT ?, batch_index, state, request_id, exchange_json,
          seller_charge_usdc, started_at, completed_at, failure_reason
        FROM direct_audit_exchanges WHERE audit_id = ?
      `).run(finalAuditId, currentAuditId);
      this._db.prepare(`
        UPDATE probe_exposures SET last_audit_id = ? WHERE last_audit_id = ?
      `).run(finalAuditId, currentAuditId);
      this._db.prepare(`
        UPDATE benchmark_targets SET audit_id = ?, updated_at = ? WHERE audit_id = ?
      `).run(finalAuditId, Date.now(), currentAuditId);
      this._db.prepare('DELETE FROM direct_audits WHERE audit_id = ?').run(currentAuditId);
    })();
    return this.getDirectAudit(finalAuditId)!;
  }

  saveDirectAuditProbe(probe: StoredDirectAuditProbe): void {
    this._db.prepare(`
      INSERT INTO direct_audit_probes (
        audit_id, ordinal, probe_id, status, request_id, request_hash,
        response_hash, response_auth_json, payment_json, timing_json,
        matched, exposure_counted_at, failure_reason
      ) VALUES (
        @auditId, @ordinal, @probeId, @status, @requestId, @requestHash,
        @responseHash, @responseAuthJson, @paymentJson, @timingJson,
        @matched, @exposureCountedAt, @failureReason
      ) ON CONFLICT(audit_id, ordinal) DO UPDATE SET
        probe_id = excluded.probe_id,
        status = excluded.status,
        request_id = excluded.request_id,
        request_hash = excluded.request_hash,
        response_hash = excluded.response_hash,
        response_auth_json = excluded.response_auth_json,
        payment_json = excluded.payment_json,
        timing_json = excluded.timing_json,
        matched = excluded.matched,
        exposure_counted_at = excluded.exposure_counted_at,
        failure_reason = excluded.failure_reason
    `).run(serializeDirectAuditProbe(probe));
  }

  saveDirectAuditProbes(probes: readonly StoredDirectAuditProbe[]): void {
    this._db.transaction(() => {
      for (const probe of probes) this.saveDirectAuditProbe(probe);
    })();
  }

  listDirectAuditProbes(auditId: string): StoredDirectAuditProbe[] {
    const rows = this._db.prepare(`
      SELECT * FROM direct_audit_probes WHERE audit_id = ? ORDER BY ordinal
    `).all(auditId) as DirectAuditProbeRow[];
    return rows.map(rowToDirectAuditProbe);
  }

  saveDirectAuditExchange(exchange: StoredDirectAuditExchange): void {
    this._db.prepare(`
      INSERT INTO direct_audit_exchanges (
        audit_id, batch_index, state, request_id, exchange_json,
        seller_charge_usdc, started_at, completed_at, failure_reason
      ) VALUES (
        @auditId, @batchIndex, @state, @requestId, @exchangeJson,
        @sellerChargeUsdc, @startedAt, @completedAt, @failureReason
      ) ON CONFLICT(audit_id, batch_index) DO UPDATE SET
        state = excluded.state,
        request_id = excluded.request_id,
        exchange_json = excluded.exchange_json,
        seller_charge_usdc = excluded.seller_charge_usdc,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        failure_reason = excluded.failure_reason
    `).run(serializeDirectAuditExchange(exchange));
  }

  listDirectAuditExchanges(auditId: string): StoredDirectAuditExchange[] {
    const rows = this._db.prepare(`
      SELECT * FROM direct_audit_exchanges WHERE audit_id = ? ORDER BY batch_index
    `).all(auditId) as DirectAuditExchangeRow[];
    return rows.map(rowToDirectAuditExchange);
  }

  saveTrafficShareSnapshot(snapshot: StoredTrafficShareSnapshot): void {
    this._db.prepare(`
      INSERT INTO traffic_share_snapshots (
        audit_id, source, epoch, window_started_at, window_ended_at,
        indexed_block, seller_address, service_hash, service_volume_usdc,
        seller_volume_usdc, model_share_bps, created_at
      ) VALUES (
        @auditId, @source, @epoch, @windowStartedAt, @windowEndedAt,
        @indexedBlock, @sellerAddress, @serviceHash, @serviceVolumeUsdc,
        @sellerVolumeUsdc, @modelShareBps, @createdAt
      ) ON CONFLICT(audit_id) DO UPDATE SET
        source = excluded.source,
        epoch = excluded.epoch,
        window_started_at = excluded.window_started_at,
        window_ended_at = excluded.window_ended_at,
        indexed_block = excluded.indexed_block,
        seller_address = excluded.seller_address,
        service_hash = excluded.service_hash,
        service_volume_usdc = excluded.service_volume_usdc,
        seller_volume_usdc = excluded.seller_volume_usdc,
        model_share_bps = excluded.model_share_bps,
        created_at = excluded.created_at
    `).run(snapshot);
  }

  getTrafficShareSnapshot(auditId: string): StoredTrafficShareSnapshot | null {
    const row = this._db.prepare(`
      SELECT * FROM traffic_share_snapshots WHERE audit_id = ?
    `).get(auditId) as TrafficShareSnapshotRow | undefined;
    return row ? rowToTrafficShareSnapshot(row) : null;
  }

  saveBenchmarkRun(run: StoredBenchmarkRun): void {
    this._db.prepare(`
      INSERT INTO benchmark_runs (
        run_id, state, mode, service, epoch, reference_id, certification_hash,
        query_profile_hash, probe_sizing_mode, probe_count, minimum_probe_count,
        maximum_probe_count, probe_step, family_wide_alpha, per_peer_alpha,
        minimum_mismatch_delta, reference_confidence, minimum_statistical_power,
        achieved_statistical_power, reference_error_upper_bound,
        critical_mismatch_count, minimum_target_coverage, max_total_usdc, spent_usdc,
        discovered_count, eligible_count, completed_count, failed_count,
        reference_path, failure_reason, created_at, updated_at, completed_at
      ) VALUES (
        @runId, @state, @mode, @service, @epoch, @referenceId, @certificationHash,
        @queryProfileHash, @probeSizingMode, @probeCount, @minimumProbeCount,
        @maximumProbeCount, @probeStep, @familyWideAlpha, @perPeerAlpha,
        @minimumMismatchDelta, @referenceConfidence, @minimumStatisticalPower,
        @achievedStatisticalPower, @referenceErrorUpperBound,
        @criticalMismatchCount, @minimumTargetCoverage, @maxTotalUsdc, @spentUsdc,
        @discoveredCount, @eligibleCount, @completedCount, @failedCount,
        @referencePath, @failureReason, @createdAt, @updatedAt, @completedAt
      ) ON CONFLICT(run_id) DO UPDATE SET
        state = excluded.state,
        mode = excluded.mode,
        service = excluded.service,
        epoch = excluded.epoch,
        reference_id = excluded.reference_id,
        certification_hash = excluded.certification_hash,
        query_profile_hash = excluded.query_profile_hash,
        probe_sizing_mode = excluded.probe_sizing_mode,
        probe_count = excluded.probe_count,
        minimum_probe_count = excluded.minimum_probe_count,
        maximum_probe_count = excluded.maximum_probe_count,
        probe_step = excluded.probe_step,
        family_wide_alpha = excluded.family_wide_alpha,
        per_peer_alpha = excluded.per_peer_alpha,
        minimum_mismatch_delta = excluded.minimum_mismatch_delta,
        reference_confidence = excluded.reference_confidence,
        minimum_statistical_power = excluded.minimum_statistical_power,
        achieved_statistical_power = excluded.achieved_statistical_power,
        reference_error_upper_bound = excluded.reference_error_upper_bound,
        critical_mismatch_count = excluded.critical_mismatch_count,
        minimum_target_coverage = excluded.minimum_target_coverage,
        max_total_usdc = excluded.max_total_usdc,
        spent_usdc = excluded.spent_usdc,
        discovered_count = excluded.discovered_count,
        eligible_count = excluded.eligible_count,
        completed_count = excluded.completed_count,
        failed_count = excluded.failed_count,
        reference_path = excluded.reference_path,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `).run({ ...run, service: run.service.trim().toLowerCase() });
  }

  getBenchmarkRun(runId: string): StoredBenchmarkRun | null {
    const row = this._db.prepare('SELECT * FROM benchmark_runs WHERE run_id = ?').get(runId) as BenchmarkRunRow | undefined;
    return row ? rowToBenchmarkRun(row) : null;
  }

  updateBenchmarkRun(runId: string, patch: Partial<StoredBenchmarkRun>): StoredBenchmarkRun {
    const existing = this.getBenchmarkRun(runId);
    if (!existing) throw new Error(`unknown benchmark run ${runId}`);
    const updated = { ...existing, ...patch, runId, updatedAt: patch.updatedAt ?? Date.now() };
    this.saveBenchmarkRun(updated);
    return updated;
  }

  saveBenchmarkTarget(target: StoredBenchmarkTarget): void {
    this._db.prepare(`
      INSERT INTO benchmark_targets (
        run_id, ordinal, peer_id, agent_id, display_name, public_address,
        advertised_service, eligibility, state, eligibility_reason, audit_id,
        seller_charge_usdc, failure_reason, created_at, updated_at
      ) VALUES (
        @runId, @ordinal, @peerId, @agentId, @displayName, @publicAddress,
        @advertisedService, @eligibility, @state, @eligibilityReason, @auditId,
        @sellerChargeUsdc, @failureReason, @createdAt, @updatedAt
      ) ON CONFLICT(run_id, peer_id) DO UPDATE SET
        ordinal = excluded.ordinal,
        agent_id = excluded.agent_id,
        display_name = excluded.display_name,
        public_address = excluded.public_address,
        advertised_service = excluded.advertised_service,
        eligibility = excluded.eligibility,
        state = excluded.state,
        eligibility_reason = excluded.eligibility_reason,
        audit_id = excluded.audit_id,
        seller_charge_usdc = excluded.seller_charge_usdc,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `).run(target);
  }

  saveBenchmarkTargets(targets: readonly StoredBenchmarkTarget[]): void {
    this._db.transaction(() => {
      for (const target of targets) this.saveBenchmarkTarget(target);
    })();
  }

  listBenchmarkTargets(runId: string): StoredBenchmarkTarget[] {
    const rows = this._db.prepare(`
      SELECT * FROM benchmark_targets WHERE run_id = ? ORDER BY ordinal
    `).all(runId) as BenchmarkTargetRow[];
    return rows.map(rowToBenchmarkTarget);
  }

  updateBenchmarkTarget(
    runId: string,
    peerId: string,
    patch: Partial<StoredBenchmarkTarget>,
  ): StoredBenchmarkTarget {
    const row = this._db.prepare(`
      SELECT * FROM benchmark_targets WHERE run_id = ? AND peer_id = ?
    `).get(runId, peerId) as BenchmarkTargetRow | undefined;
    if (!row) throw new Error(`unknown benchmark target ${runId}:${peerId}`);
    const existing = rowToBenchmarkTarget(row);
    const updated = { ...existing, ...patch, runId, peerId, updatedAt: patch.updatedAt ?? Date.now() };
    this.saveBenchmarkTarget(updated);
    return updated;
  }

  listActiveDirectProbeIds(agentId: string, service: string, excludeAuditId = ''): string[] {
    const rows = this._db.prepare(`
      SELECT probes.probe_id
      FROM direct_audit_probes probes
      JOIN direct_audits audits ON audits.audit_id = probes.audit_id
      WHERE audits.agent_id = ? AND lower(trim(audits.target_service)) = ?
        AND audits.audit_id <> ? AND audits.state IN ('pending', 'running')
        AND probes.exposure_counted_at IS NULL
    `).all(agentId, service.trim().toLowerCase(), excludeAuditId) as Array<{ probe_id: string }>;
    return rows.map((row) => row.probe_id);
  }

  getProbeExposureCounts(agentId: string, service: string): Map<string, number> {
    const rows = this._db.prepare(`
      SELECT probe_id, exposure_count FROM probe_exposures
      WHERE agent_id = ? AND service = ?
    `).all(agentId, service.trim().toLowerCase()) as Array<{ probe_id: string; exposure_count: number }>;
    return new Map(rows.map((row) => [row.probe_id, row.exposure_count]));
  }

  markDirectAuditProbeExposure(auditId: string, ordinal: number, exposedAt = Date.now()): void {
    this._db.transaction(() => {
      const audit = this._db.prepare(`
        SELECT agent_id, lower(trim(target_service)) AS service
        FROM direct_audits WHERE audit_id = ?
      `).get(auditId) as { agent_id: string | null; service: string } | undefined;
      if (!audit?.agent_id) throw new Error(`direct audit ${auditId} has no target identity`);
      const probe = this._db.prepare(`
        SELECT probe_id FROM direct_audit_probes
        WHERE audit_id = ? AND ordinal = ? AND exposure_counted_at IS NULL
      `).get(auditId, ordinal) as { probe_id: string } | undefined;
      if (!probe) return;
      this._db.prepare(`
        INSERT INTO probe_exposures (
          agent_id, service, probe_id, exposure_count, last_audit_id, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(agent_id, service, probe_id) DO UPDATE SET
          last_audit_id = excluded.last_audit_id,
          updated_at = excluded.updated_at
      `).run(audit.agent_id, audit.service, probe.probe_id, auditId, exposedAt);
      this._db.prepare(`
        UPDATE direct_audit_probes SET exposure_counted_at = ?
        WHERE audit_id = ? AND ordinal = ? AND exposure_counted_at IS NULL
      `).run(exposedAt, auditId, ordinal);
    })();
  }

  releaseUnexposedDirectAuditProbes(auditId: string): void {
    this._db.prepare(`
      DELETE FROM direct_audit_probes WHERE audit_id = ? AND exposure_counted_at IS NULL
    `).run(auditId);
  }

  getReferenceBuild(service: string, endpointHash: string): StoredReferenceBuild | null {
    const row = this._db.prepare(`
      SELECT service, endpoint_hash, state, attempts, next_retry_at, request_count,
        reference_id, failure_reason, created_at, updated_at
      FROM reference_builds WHERE service = ? AND endpoint_hash = ?
    `).get(service.trim().toLowerCase(), endpointHash) as ReferenceBuildRow | undefined;
    return row ? rowToReferenceBuild(row) : null;
  }

  upsertReferenceBuild(build: StoredReferenceBuild): void {
    this._db.prepare(`
      INSERT INTO reference_builds (
        service, endpoint_hash, state, attempts, next_retry_at, request_count,
        reference_id, failure_reason, created_at, updated_at
      ) VALUES (
        @service, @endpointHash, @state, @attempts, @nextRetryAt, @requestCount,
        @referenceId, @failureReason, @createdAt, @updatedAt
      ) ON CONFLICT(service, endpoint_hash) DO UPDATE SET
        state = excluded.state,
        attempts = excluded.attempts,
        next_retry_at = excluded.next_retry_at,
        request_count = excluded.request_count,
        reference_id = excluded.reference_id,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `).run({ ...build, service: build.service.trim().toLowerCase() });
  }

  upsertCertifiedKbfProbes(probes: readonly StoredCertifiedKbfProbe[]): { inserted: number; known: number } {
    const statement = this._db.prepare(`
      INSERT INTO certified_kbf_probes (
        service, certification_hash, probe_id, probe_json, certification_json,
        query_profile_json, source_id, trust, certified_at, expires_at, healthy,
        failure_reason, created_at, updated_at
      ) VALUES (
        @service, @certificationHash, @probeId, @probeJson, @certificationJson,
        @queryProfileJson, @sourceId, @trust, @certifiedAt, @expiresAt, @healthy,
        @failureReason, @createdAt, @updatedAt
      ) ON CONFLICT(service, certification_hash, probe_id) DO UPDATE SET
        probe_json = excluded.probe_json,
        certification_json = excluded.certification_json,
        query_profile_json = excluded.query_profile_json,
        source_id = excluded.source_id,
        trust = excluded.trust,
        certified_at = excluded.certified_at,
        expires_at = excluded.expires_at,
        healthy = excluded.healthy,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `);
    let inserted = 0;
    this._db.transaction(() => {
      for (const probe of probes) {
        const service = probe.service.trim().toLowerCase();
        const existed = this._db.prepare(`
          SELECT 1 FROM certified_kbf_probes
          WHERE service = ? AND certification_hash = ? AND probe_id = ?
        `).get(service, probe.certificationHash, probe.probeId) !== undefined;
        const result = statement.run({
          ...probe,
          service,
          probeJson: JSON.stringify(probe.probe),
          certificationJson: JSON.stringify(probe.certification),
          queryProfileJson: JSON.stringify(probe.queryProfile),
          healthy: probe.healthy ? 1 : 0,
        });
        if (!existed && result.changes > 0) inserted += 1;
      }
    })();
    return { inserted, known: probes.length - inserted };
  }

  listCertifiedKbfProbes(service: string, certificationHash: string, now = Date.now()): StoredCertifiedKbfProbe[] {
    const rows = this._db.prepare(`
      SELECT * FROM certified_kbf_probes
      WHERE service = ? AND certification_hash = ? AND healthy = 1 AND expires_at > ?
      ORDER BY probe_id
    `).all(service.trim().toLowerCase(), certificationHash, now) as CertifiedKbfProbeRow[];
    return rows.map(rowToCertifiedKbfProbe);
  }

  countCertifiedKbfProbes(service: string, certificationHash: string, now = Date.now()): number {
    const row = this._db.prepare(`
      SELECT COUNT(*) AS count FROM certified_kbf_probes
      WHERE service = ? AND certification_hash = ? AND healthy = 1 AND expires_at > ?
    `).get(service.trim().toLowerCase(), certificationHash, now) as { count: number };
    return row.count;
  }

  markCertifiedKbfProbesUnhealthy(
    service: string,
    certificationHash: string,
    probeIds: readonly string[],
    failureReason: string,
    updatedAt = Date.now(),
  ): void {
    const statement = this._db.prepare(`
      UPDATE certified_kbf_probes SET healthy = 0, failure_reason = ?, updated_at = ?
      WHERE service = ? AND certification_hash = ? AND probe_id = ?
    `);
    this._db.transaction(() => {
      for (const probeId of new Set(probeIds)) {
        statement.run(failureReason, updatedAt, service.trim().toLowerCase(), certificationHash, probeId);
      }
    })();
  }

  hasImportedCertifiedKbfReference(referenceId: string): boolean {
    return this._db.prepare('SELECT 1 FROM certified_kbf_imports WHERE reference_id = ?').get(referenceId) !== undefined;
  }

  recordCertifiedKbfReferenceImport(
    referenceId: string,
    certificationHash: string,
    importedProbeCount: number,
    importedAt = Date.now(),
  ): void {
    this._db.prepare(`
      INSERT INTO certified_kbf_imports (reference_id, certification_hash, imported_probe_count, imported_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(reference_id) DO NOTHING
    `).run(referenceId, certificationHash, importedProbeCount, importedAt);
  }

  close(): void {
    this._db.close();
  }
}

interface ResponseAuthRow {
  request_id: string;
  version: number;
  channel_id: string | null;
  buyer_peer_id: string;
  seller_peer_id: string;
  advertised_service: string;
  provider: string;
  status_code: number;
  request_hash: string;
  response_hash: string;
  response_started_at: number;
  response_completed_at: number;
  signature: string;
  received_at: number;
  verified: number;
  verification_error: string | null;
}

interface DirectAuditRow {
  audit_id: string;
  state: DirectAuditState;
  source: DirectAuditSource;
  epoch: string | null;
  verifier_address: string | null;
  agent_id: string | null;
  seller_address: string | null;
  target_peer_id: string;
  target_service: string;
  target_service_hash: string | null;
  reference_id: string | null;
  query_profile_hash: string | null;
  probe_count: number;
  authenticated_probe_count: number;
  statistical_power: number | null;
  verdict: number | null;
  model_share_bps: number | null;
  metrics_json: string | null;
  evidence_path: string | null;
  evidence_hash: string | null;
  evidence_uri: string | null;
  attestation_tx_hash: string | null;
  credited: number | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  failure_reason: string | null;
}

interface DirectAuditProbeRow {
  audit_id: string;
  ordinal: number;
  probe_id: string;
  status: DirectAuditProbeStatus;
  request_id: string | null;
  request_hash: string | null;
  response_hash: string | null;
  response_auth_json: string | null;
  payment_json: string | null;
  timing_json: string | null;
  matched: number | null;
  exposure_counted_at: number | null;
  failure_reason: string | null;
}

interface DirectAuditExchangeRow {
  audit_id: string;
  batch_index: number;
  state: StoredDirectAuditExchange['state'];
  request_id: string | null;
  exchange_json: string | null;
  seller_charge_usdc: string;
  started_at: number | null;
  completed_at: number | null;
  failure_reason: string | null;
}

interface TrafficShareSnapshotRow {
  audit_id: string;
  source: string;
  epoch: string;
  window_started_at: number;
  window_ended_at: number;
  indexed_block: number;
  seller_address: string;
  service_hash: string;
  service_volume_usdc: string;
  seller_volume_usdc: string;
  model_share_bps: number;
  created_at: number;
}

interface BenchmarkRunRow {
  run_id: string;
  state: BenchmarkRunState;
  mode: 'observe';
  service: string;
  epoch: string | null;
  reference_id: string | null;
  certification_hash: string | null;
  query_profile_hash: string | null;
  probe_sizing_mode: 'fixed' | 'auto';
  probe_count: number;
  minimum_probe_count: number | null;
  maximum_probe_count: number | null;
  probe_step: number | null;
  family_wide_alpha: number | null;
  per_peer_alpha: number | null;
  minimum_mismatch_delta: number | null;
  reference_confidence: number | null;
  minimum_statistical_power: number | null;
  achieved_statistical_power: number | null;
  reference_error_upper_bound: number | null;
  critical_mismatch_count: number | null;
  minimum_target_coverage: number | null;
  max_total_usdc: string;
  spent_usdc: string;
  discovered_count: number;
  eligible_count: number;
  completed_count: number;
  failed_count: number;
  reference_path: string | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface BenchmarkTargetRow {
  run_id: string;
  ordinal: number;
  peer_id: string;
  agent_id: string | null;
  display_name: string | null;
  public_address: string | null;
  advertised_service: string;
  eligibility: 'eligible' | 'ineligible';
  state: BenchmarkTargetState;
  eligibility_reason: string | null;
  audit_id: string | null;
  seller_charge_usdc: string;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface ReferenceBuildRow {
  service: string;
  endpoint_hash: string;
  state: ReferenceBuildState;
  attempts: number;
  next_retry_at: number | null;
  request_count: number;
  reference_id: string | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface CertifiedKbfProbeRow {
  service: string;
  certification_hash: string;
  probe_id: string;
  probe_json: string;
  certification_json: string;
  query_profile_json: string;
  source_id: string;
  trust: 'smoke' | 'trusted';
  certified_at: number;
  expires_at: number;
  healthy: number;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

function serializeDirectAudit(audit: StoredDirectAudit): Record<string, unknown> {
  return {
    ...audit,
    targetService: audit.targetService.trim().toLowerCase(),
    metricsJson: audit.metrics ? JSON.stringify(audit.metrics) : null,
    credited: audit.credited === null ? null : audit.credited ? 1 : 0,
  };
}

function rowToDirectAudit(row: DirectAuditRow): StoredDirectAudit {
  return {
    auditId: row.audit_id,
    state: row.state,
    source: row.source,
    epoch: row.epoch,
    verifierAddress: row.verifier_address,
    agentId: row.agent_id,
    sellerAddress: row.seller_address,
    targetPeerId: row.target_peer_id,
    targetService: row.target_service,
    targetServiceHash: row.target_service_hash,
    referenceId: row.reference_id,
    queryProfileHash: row.query_profile_hash,
    probeCount: row.probe_count,
    authenticatedProbeCount: row.authenticated_probe_count,
    statisticalPower: row.statistical_power,
    verdict: row.verdict,
    modelShareBps: row.model_share_bps,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) as Record<string, unknown> : null,
    evidencePath: row.evidence_path,
    evidenceHash: row.evidence_hash,
    evidenceUri: row.evidence_uri,
    attestationTxHash: row.attestation_tx_hash,
    credited: row.credited === null ? null : row.credited === 1,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureReason: row.failure_reason,
  };
}

function serializeDirectAuditProbe(probe: StoredDirectAuditProbe): Record<string, unknown> {
  return {
    ...probe,
    responseAuthJson: probe.responseAuth ? JSON.stringify(probe.responseAuth) : null,
    paymentJson: probe.payment ? JSON.stringify(probe.payment) : null,
    timingJson: probe.timing ? JSON.stringify(probe.timing) : null,
    matched: probe.matched === null ? null : probe.matched ? 1 : 0,
  };
}

function rowToDirectAuditProbe(row: DirectAuditProbeRow): StoredDirectAuditProbe {
  return {
    auditId: row.audit_id,
    ordinal: row.ordinal,
    probeId: row.probe_id,
    status: row.status,
    requestId: row.request_id,
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    responseAuth: row.response_auth_json ? JSON.parse(row.response_auth_json) as Record<string, unknown> : null,
    payment: row.payment_json ? JSON.parse(row.payment_json) as Record<string, unknown> : null,
    timing: row.timing_json ? JSON.parse(row.timing_json) as Record<string, unknown> : null,
    matched: row.matched === null ? null : row.matched === 1,
    exposureCountedAt: row.exposure_counted_at,
    failureReason: row.failure_reason,
  };
}

function serializeDirectAuditExchange(exchange: StoredDirectAuditExchange): Record<string, unknown> {
  return {
    ...exchange,
    exchangeJson: exchange.exchange ? JSON.stringify(exchange.exchange) : null,
  };
}

function rowToDirectAuditExchange(row: DirectAuditExchangeRow): StoredDirectAuditExchange {
  return {
    auditId: row.audit_id,
    batchIndex: row.batch_index,
    state: row.state,
    requestId: row.request_id,
    exchange: row.exchange_json ? JSON.parse(row.exchange_json) as Record<string, unknown> : null,
    sellerChargeUsdc: row.seller_charge_usdc,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
  };
}

function rowToTrafficShareSnapshot(row: TrafficShareSnapshotRow): StoredTrafficShareSnapshot {
  return {
    auditId: row.audit_id,
    source: row.source,
    epoch: row.epoch,
    windowStartedAt: row.window_started_at,
    windowEndedAt: row.window_ended_at,
    indexedBlock: row.indexed_block,
    sellerAddress: row.seller_address,
    serviceHash: row.service_hash,
    serviceVolumeUsdc: row.service_volume_usdc,
    sellerVolumeUsdc: row.seller_volume_usdc,
    modelShareBps: row.model_share_bps,
    createdAt: row.created_at,
  };
}

function rowToBenchmarkRun(row: BenchmarkRunRow): StoredBenchmarkRun {
  return {
    runId: row.run_id,
    state: row.state,
    mode: row.mode,
    service: row.service,
    epoch: row.epoch,
    referenceId: row.reference_id,
    certificationHash: row.certification_hash,
    queryProfileHash: row.query_profile_hash,
    probeSizingMode: row.probe_sizing_mode,
    probeCount: row.probe_count,
    minimumProbeCount: row.minimum_probe_count,
    maximumProbeCount: row.maximum_probe_count,
    probeStep: row.probe_step,
    familyWideAlpha: row.family_wide_alpha,
    perPeerAlpha: row.per_peer_alpha,
    minimumMismatchDelta: row.minimum_mismatch_delta,
    referenceConfidence: row.reference_confidence,
    minimumStatisticalPower: row.minimum_statistical_power,
    achievedStatisticalPower: row.achieved_statistical_power,
    referenceErrorUpperBound: row.reference_error_upper_bound,
    criticalMismatchCount: row.critical_mismatch_count,
    minimumTargetCoverage: row.minimum_target_coverage,
    maxTotalUsdc: row.max_total_usdc,
    spentUsdc: row.spent_usdc,
    discoveredCount: row.discovered_count,
    eligibleCount: row.eligible_count,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    referencePath: row.reference_path,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToBenchmarkTarget(row: BenchmarkTargetRow): StoredBenchmarkTarget {
  return {
    runId: row.run_id,
    ordinal: row.ordinal,
    peerId: row.peer_id,
    agentId: row.agent_id,
    displayName: row.display_name,
    publicAddress: row.public_address,
    advertisedService: row.advertised_service,
    eligibility: row.eligibility,
    state: row.state,
    eligibilityReason: row.eligibility_reason,
    auditId: row.audit_id,
    sellerChargeUsdc: row.seller_charge_usdc,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReferenceBuild(row: ReferenceBuildRow): StoredReferenceBuild {
  return {
    service: row.service,
    endpointHash: row.endpoint_hash,
    state: row.state,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    requestCount: row.request_count,
    referenceId: row.reference_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCertifiedKbfProbe(row: CertifiedKbfProbeRow): StoredCertifiedKbfProbe {
  return {
    service: row.service,
    certificationHash: row.certification_hash,
    probeId: row.probe_id,
    probe: JSON.parse(row.probe_json) as Record<string, unknown>,
    certification: JSON.parse(row.certification_json) as Record<string, unknown>,
    queryProfile: JSON.parse(row.query_profile_json) as Record<string, unknown>,
    sourceId: row.source_id,
    trust: row.trust,
    certifiedAt: row.certified_at,
    expiresAt: row.expires_at,
    healthy: row.healthy === 1,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToResponseAuth(row: ResponseAuthRow): StoredResponseAuth {
  return {
    version: row.version as 1,
    requestId: row.request_id,
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    buyerPeerId: row.buyer_peer_id,
    sellerPeerId: row.seller_peer_id,
    advertisedService: row.advertised_service,
    provider: row.provider,
    statusCode: row.status_code,
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    responseStartedAt: row.response_started_at,
    responseCompletedAt: row.response_completed_at,
    signature: row.signature,
    receivedAt: row.received_at,
    verified: row.verified === 1,
    verificationError: row.verification_error,
  };
}

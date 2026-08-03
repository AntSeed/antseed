import Database from 'better-sqlite3';
import { getServiceMetadataId } from '../payments/evm/signatures.js';
import type { ResponseAuthPayload } from '../types/protocol.js';
import { runMigrations } from '../storage/migrate.js';
import { verificationMigrations } from '../storage/migrations/verification/index.js';

export interface StoredResponseAuth extends ResponseAuthPayload {
  receivedAt: number;
  verified: boolean;
  verificationError: string | null;
}

export type AuditLifecycleState =
  | 'queued'
  | 'preparing-reference'
  | 'planned'
  | 'committing'
  | 'committed'
  | 'executing'
  | 'awaiting-attestation'
  | 'attesting'
  | 'attested'
  | 'failed';

export type AuditJobState = 'planned' | 'due' | 'assigned' | 'dispatched' | 'succeeded' | 'failed';
export type AuditAssignmentState = 'unassigned' | 'assigned' | 'rejected' | 'accepted';
export type RelayEntitlementState = 'awaiting-attestation' | 'paid' | 'challenge-available' | 'expired';

export interface StoredAuditPlan {
  auditId: string;
  state: AuditLifecycleState;
  source: 'manual' | 'automatic';
  epoch: string | null;
  durationMs: number;
  chainId: string | null;
  registryAddress: string | null;
  treasuryAddress: string | null;
  verifierAddress: string | null;
  agentId: string | null;
  targetPeerId: string;
  targetService: string;
  targetServiceHash: string | null;
  targetSalt: string | null;
  targetCommitment: string | null;
  probeRoot: string | null;
  auditJobRoot: string | null;
  referenceId: string | null;
  queryProfileHash: string | null;
  verifierConfigHash: string | null;
  probeCount: number | null;
  jobCount: number | null;
  requiredRelayCount: number | null;
  jobTimeoutMs: number;
  payoutPerJobUsdc: bigint | null;
  reservedBudgetUsdc: bigint | null;
  commitTxHash: string | null;
  attestationTxHash: string | null;
  evidenceHash: string | null;
  evidenceUri: string | null;
  evidenceState: 'none' | 'local' | 'published';
  executeAfter: number | null;
  executeBefore: number | null;
  forceClaimAvailableAt: number | null;
  forceClaimDeadline: number | null;
  createdAt: number;
  updatedAt: number;
  failureReason: string | null;
}

export interface StoredAuditJob {
  auditId: string;
  jobIndex: number;
  state: AuditJobState;
  scheduledAt: number;
  relayPeerId: string | null;
  relayBuyerAddress: string | null;
  assignmentAttempt: number;
  assignmentSignature: string | null;
  assignmentState: AuditAssignmentState;
  assignedAt: number | null;
  lastDispatchAt: number | null;
  sellerPeerId: string;
  service: string;
  serviceHash: string;
  requestHash: string;
  jobSalt: string;
  executeAfter: number;
  executeBefore: number;
  requestBytes: Uint8Array;
  positionalProof: string[];
  responseBytes: Uint8Array | null;
  responseAuthPayload: Uint8Array | null;
  sellerChargeUsdc: bigint | null;
  paymentMetadata: Record<string, unknown> | null;
  dispatchedAt: number | null;
  completedAt: number | null;
  failureKind: string | null;
  failureMessage: string | null;
  entitlementPersistedAt: number | null;
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

export interface StoredAuditProbeSelection {
  auditId: string;
  ordinal: number;
  jobIndex: number;
  probeId: string;
  exposureCountedAt: number | null;
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

export type AuditRoundState =
  | 'queued'
  | 'preparing'
  | 'ready'
  | 'committing'
  | 'committed'
  | 'executing'
  | 'complete'
  | 'backoff'
  | 'failed';

export interface StoredAuditRound {
  roundId: string;
  service: string;
  endpointHash: string;
  epoch: string | null;
  state: AuditRoundState;
  attempts: number;
  nextRetryAt: number | null;
  targetCount: number;
  generatedProbeCount: number;
  requestCount: number;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type AuditRoundMemberState = 'queued' | 'prepared' | 'committed' | 'failed';

export interface StoredAuditRoundMember {
  roundId: string;
  auditId: string;
  state: AuditRoundMemberState;
  referenceId: string | null;
  probeCount: number | null;
  cachedProbeCount: number;
  generatedProbeCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredRelayEntitlement {
  auditId: string;
  jobIndex: number;
  relayPeerId: string;
  relayBuyerAddress: string;
  registryAddress: string;
  treasuryAddress: string;
  job: Record<string, unknown>;
  positionalProof: string[];
  assignment: Record<string, unknown>;
  verifierSignature: string;
  responseBytes: Uint8Array;
  responseAuthPayload: Uint8Array;
  payoutUsdc: bigint;
  sellerChargeUsdc: bigint;
  paymentMetadata: Record<string, unknown>;
  forceClaimAvailableAt: number;
  forceClaimDeadline: number;
  state: RelayEntitlementState;
  claimTxHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SettlementIndexCursor {
  chainId: string;
  channelsAddress: string;
  finalizedBlock: number;
  finalizedBlockHash: string;
  updatedAt: number;
}

export interface SettlementUsageEvent {
  chainId: string;
  channelsAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  settledAt: number;
  channelId: string;
  agentId: string;
  sellerPeerId: string;
  service: string;
  cumulativeServiceUsdc: bigint;
  serviceDeltaUsdc: bigint;
  cumulativeChannelUsdc: bigint;
  channelDeltaUsdc: bigint;
  auditChargeUsdc: bigint;
  organicServiceDeltaUsdc: bigint;
}

export interface VerificationAuditStore {
  saveAuditPlan(plan: StoredAuditPlan, jobs?: StoredAuditJob[], options?: { replaceJobs?: boolean }): void;
  getAuditPlan(auditId: string): StoredAuditPlan | null;
  listAuditPlans(state?: AuditLifecycleState): StoredAuditPlan[];
  listAuditJobs(auditId: string): StoredAuditJob[];
  listDueAuditJobs(now: number): StoredAuditJob[];
  updateAuditState(auditId: string, state: AuditLifecycleState, fields?: Partial<Pick<StoredAuditPlan,
    'commitTxHash' | 'attestationTxHash' | 'evidenceHash' | 'evidenceUri' | 'evidenceState' | 'failureReason'>>): void;
  assignAuditJob(input: {
    auditId: string;
    jobIndex: number;
    relayPeerId: string;
    relayBuyerAddress: string;
    assignmentAttempt: number;
    assignmentSignature: string;
    assignedAt?: number;
  }): void;
  markAuditJobRejected(auditId: string, jobIndex: number, message: string): void;
  markAuditJobDispatchAttempt(auditId: string, jobIndex: number, attemptedAt?: number): void;
  markAuditJobDispatched(auditId: string, jobIndex: number, dispatchedAt?: number): void;
  markAuditJobFailed(auditId: string, jobIndex: number, failureKind: string, failureMessage: string, completedAt?: number): void;
  persistAuditJobSuccess(input: {
    auditId: string;
    jobIndex: number;
    responseBytes: Uint8Array;
    responseAuthPayload: Uint8Array;
    sellerChargeUsdc: bigint;
    paymentMetadata: Record<string, unknown>;
    completedAt?: number;
  }): void;
  computeModelShareBps(agentId: string, failedService: string, fromMs: number, toMs: number): number;
  getReferenceBuild(service: string, endpointHash: string): StoredReferenceBuild | null;
  upsertReferenceBuild(build: StoredReferenceBuild): void;
  upsertCertifiedKbfProbes(probes: readonly StoredCertifiedKbfProbe[]): { inserted: number; known: number };
  listCertifiedKbfProbes(service: string, certificationHash: string, now?: number): StoredCertifiedKbfProbe[];
  countCertifiedKbfProbes(service: string, certificationHash: string, now?: number): number;
  markCertifiedKbfProbesUnhealthy(service: string, certificationHash: string, probeIds: readonly string[], failureReason: string, updatedAt?: number): void;
  hasImportedCertifiedKbfReference(referenceId: string): boolean;
  recordCertifiedKbfReferenceImport(referenceId: string, certificationHash: string, importedProbeCount: number, importedAt?: number): void;
  saveAuditRound(round: StoredAuditRound, members?: readonly StoredAuditRoundMember[]): void;
  getAuditRound(roundId: string): StoredAuditRound | null;
  listAuditRounds(state?: AuditRoundState): StoredAuditRound[];
  updateAuditRound(roundId: string, state: AuditRoundState, fields?: Partial<Pick<StoredAuditRound,
    'attempts' | 'nextRetryAt' | 'targetCount' | 'generatedProbeCount' | 'requestCount' | 'failureReason'>>): void;
  saveAuditRoundMember(member: StoredAuditRoundMember): void;
  getAuditRoundMemberByAuditId(auditId: string): StoredAuditRoundMember | null;
  listAuditRoundMembers(roundId: string): StoredAuditRoundMember[];
  updateAuditRoundMember(roundId: string, auditId: string, state: AuditRoundMemberState, fields?: Partial<Pick<StoredAuditRoundMember,
    'referenceId' | 'probeCount' | 'cachedProbeCount' | 'generatedProbeCount'>>): void;
  reserveAuditProbes(auditId: string, probeIds: readonly string[], probesPerJob?: number): void;
  listAuditProbeSelections(auditId: string): StoredAuditProbeSelection[];
  listActiveReservedProbeIds(agentId: string, service: string, excludeAuditId?: string): string[];
  getProbeExposureCounts(agentId: string, service: string): Map<string, number>;
  markAuditJobProbeExposure(auditId: string, jobIndex: number, exposedAt?: number): void;
  releaseUnexposedAuditProbeReservations(auditId: string): void;
}

export interface VerificationRelayStore {
  getRelayEntitlement(auditId: string, jobIndex: number): StoredRelayEntitlement | null;
  listRelayEntitlements(status?: RelayEntitlementState): StoredRelayEntitlement[];
  persistRelayEntitlement(entitlement: StoredRelayEntitlement): void;
  persistRelaySuccess(input: { auditId: string; jobIndex: number; responseBytes: Uint8Array; entitlement: StoredRelayEntitlement; completedAt?: number }): void;
  updateRelayEntitlementState(auditId: string, jobIndex: number, state: RelayEntitlementState, claimTxHash?: string | null): void;
}

export interface VerificationSettlementStore {
  getSettlementCursor(chainId: string, channelsAddress: string): SettlementIndexCursor | null;
  updateSettlementCursor(cursor: SettlementIndexCursor): void;
  getSettlementServiceTotal(
    chainId: string,
    channelsAddress: string,
    channelId: string,
    service: string,
  ): { cumulativeServiceUsdc: bigint; cumulativeChannelUsdc: bigint } | null;
  auditChargeForSettlement(
    channelId: string,
    serviceHash: string,
    previousCumulativeAmountUsdc: bigint,
    cumulativeAmountUsdc: bigint,
  ): bigint;
  recordFinalizedSettlement(event: SettlementUsageEvent, cursor?: SettlementIndexCursor): boolean;
}

export class VerificationStorage implements VerificationAuditStore, VerificationRelayStore, VerificationSettlementStore {
  private readonly _db: Database.Database;
  private readonly _insertResponseAuth: Database.Statement;
  private readonly _getResponseAuth: Database.Statement;
  private readonly _listResponseAuthsBySeller: Database.Statement;

  constructor(dbPath: string) {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    runMigrations(this._db, verificationMigrations);

    const statements = this._prepareStatements();
    this._insertResponseAuth = statements.insertResponseAuth;
    this._getResponseAuth = statements.getResponseAuth;
    this._listResponseAuthsBySeller = statements.listResponseAuthsBySeller;
  }

  private _prepareStatements(): VerificationStorageStatements {
    return {
      insertResponseAuth: this._prepareInsertResponseAuthStatement(),
      getResponseAuth: this._db.prepare('SELECT * FROM response_auths WHERE request_id = ?'),
      listResponseAuthsBySeller: this._db.prepare(
        'SELECT * FROM response_auths WHERE seller_peer_id = ? ORDER BY received_at DESC LIMIT ?',
      ),
    };
  }

  private _prepareInsertResponseAuthStatement(): Database.Statement {
    return this._db.prepare(`
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

  saveAuditPlan(plan: StoredAuditPlan, jobs: StoredAuditJob[] = [], options: { replaceJobs?: boolean } = {}): void {
    if (plan.jobCount !== null && jobs.length > 0 && jobs.length !== plan.jobCount) {
      throw new Error('audit job count does not match plan');
    }
    const insertPlan = this._db.prepare(`
      INSERT INTO audit_plans (
        audit_id, state, source, epoch, duration_ms,
        chain_id, registry_address, treasury_address, verifier_address,
        agent_id, target_peer_id, target_service, target_service_hash, target_salt,
        target_commitment, probe_root, audit_job_root, reference_id, query_profile_hash,
        verifier_config_hash, probe_count, job_count, required_relay_count, job_timeout_ms,
        payout_per_job_usdc, reserved_budget_usdc, commit_tx_hash, attestation_tx_hash,
        evidence_hash, evidence_uri, evidence_state, execute_after, execute_before,
        force_claim_available_at, force_claim_deadline, created_at, updated_at, failure_reason
      ) VALUES (
        @auditId, @state, @source, @epoch, @durationMs,
        @chainId, @registryAddress, @treasuryAddress, @verifierAddress,
        @agentId, @targetPeerId, @targetService, @targetServiceHash, @targetSalt,
        @targetCommitment, @probeRoot, @auditJobRoot, @referenceId, @queryProfileHash,
        @verifierConfigHash, @probeCount, @jobCount, @requiredRelayCount, @jobTimeoutMs,
        @payoutPerJobUsdc, @reservedBudgetUsdc, @commitTxHash, @attestationTxHash,
        @evidenceHash, @evidenceUri, @evidenceState, @executeAfter, @executeBefore,
        @forceClaimAvailableAt, @forceClaimDeadline, @createdAt, @updatedAt, @failureReason
      ) ON CONFLICT(audit_id) DO UPDATE SET
        state = excluded.state, source = excluded.source, epoch = excluded.epoch,
        duration_ms = excluded.duration_ms, chain_id = excluded.chain_id,
        registry_address = excluded.registry_address, treasury_address = excluded.treasury_address,
        verifier_address = excluded.verifier_address, agent_id = excluded.agent_id,
        target_peer_id = excluded.target_peer_id, target_service = excluded.target_service,
        target_service_hash = excluded.target_service_hash, target_salt = excluded.target_salt,
        target_commitment = excluded.target_commitment, probe_root = excluded.probe_root,
        audit_job_root = excluded.audit_job_root, reference_id = excluded.reference_id,
        query_profile_hash = excluded.query_profile_hash, verifier_config_hash = excluded.verifier_config_hash,
        probe_count = excluded.probe_count, job_count = excluded.job_count,
        required_relay_count = excluded.required_relay_count, job_timeout_ms = excluded.job_timeout_ms,
        payout_per_job_usdc = excluded.payout_per_job_usdc, reserved_budget_usdc = excluded.reserved_budget_usdc,
        commit_tx_hash = excluded.commit_tx_hash, attestation_tx_hash = excluded.attestation_tx_hash,
        evidence_hash = excluded.evidence_hash, evidence_uri = excluded.evidence_uri,
        evidence_state = excluded.evidence_state, execute_after = excluded.execute_after,
        execute_before = excluded.execute_before, force_claim_available_at = excluded.force_claim_available_at,
        force_claim_deadline = excluded.force_claim_deadline, updated_at = excluded.updated_at,
        failure_reason = excluded.failure_reason
    `);
    const insertJob = this._db.prepare(`
      INSERT INTO audit_jobs (
        audit_id, job_index, state, scheduled_at, relay_peer_id, relay_buyer_address,
        assignment_attempt, assignment_signature, assignment_state, assigned_at, last_dispatch_at,
        seller_peer_id, service, service_hash, request_hash, job_salt, execute_after, execute_before,
        request_bytes, positional_proof_json, response_bytes, response_auth_payload,
        seller_charge_usdc, payment_metadata_json, dispatched_at, completed_at,
        failure_kind, failure_message, entitlement_persisted_at
      ) VALUES (
        @auditId, @jobIndex, @state, @scheduledAt, @relayPeerId, @relayBuyerAddress,
        @assignmentAttempt, @assignmentSignature, @assignmentState, @assignedAt, @lastDispatchAt,
        @sellerPeerId, @service, @serviceHash, @requestHash, @jobSalt, @executeAfter, @executeBefore,
        @requestBytes, @positionalProofJson, @responseBytes, @responseAuthPayload,
        @sellerChargeUsdc, @paymentMetadataJson, @dispatchedAt, @completedAt,
        @failureKind, @failureMessage, @entitlementPersistedAt
      ) ON CONFLICT(audit_id, job_index) DO UPDATE SET
        state = excluded.state, scheduled_at = excluded.scheduled_at,
        relay_peer_id = excluded.relay_peer_id, relay_buyer_address = excluded.relay_buyer_address,
        assignment_attempt = excluded.assignment_attempt, assignment_signature = excluded.assignment_signature,
        assignment_state = excluded.assignment_state, assigned_at = excluded.assigned_at,
        last_dispatch_at = excluded.last_dispatch_at, seller_peer_id = excluded.seller_peer_id,
        service = excluded.service, service_hash = excluded.service_hash,
        request_hash = excluded.request_hash, job_salt = excluded.job_salt,
        execute_after = excluded.execute_after, execute_before = excluded.execute_before,
        request_bytes = excluded.request_bytes, positional_proof_json = excluded.positional_proof_json
    `);
    this._db.transaction(() => {
      insertPlan.run(serializeAuditPlan(plan));
      if (options.replaceJobs && jobs.length > 0) {
        this._db.prepare('DELETE FROM audit_jobs WHERE audit_id = ?').run(plan.auditId);
      }
      for (const job of jobs) insertJob.run(serializeAuditJob(job));
    })();
  }

  getAuditPlan(auditId: string): StoredAuditPlan | null {
    const row = this._db.prepare('SELECT * FROM audit_plans WHERE audit_id = ?').get(auditId) as AuditPlanRow | undefined;
    return row ? rowToAuditPlan(row) : null;
  }

  listAuditPlans(state?: AuditLifecycleState): StoredAuditPlan[] {
    const rows = state
      ? this._db.prepare('SELECT * FROM audit_plans WHERE state = ? ORDER BY created_at DESC').all(state)
      : this._db.prepare('SELECT * FROM audit_plans ORDER BY created_at DESC').all();
    return (rows as AuditPlanRow[]).map(rowToAuditPlan);
  }

  getReferenceBuild(service: string, endpointHash: string): StoredReferenceBuild | null {
    const row = this._db.prepare(`
      SELECT service, endpoint_hash, state, attempts, next_retry_at, request_count,
        reference_id, failure_reason, created_at, updated_at
      FROM reference_builds WHERE service = ? AND endpoint_hash = ?
    `).get(service.trim().toLowerCase(), endpointHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      service: String(row.service),
      endpointHash: String(row.endpoint_hash),
      state: String(row.state) as ReferenceBuildState,
      attempts: Number(row.attempts),
      nextRetryAt: row.next_retry_at === null ? null : Number(row.next_retry_at),
      requestCount: Number(row.request_count),
      referenceId: row.reference_id === null ? null : String(row.reference_id),
      failureReason: row.failure_reason === null ? null : String(row.failure_reason),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
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
        state = excluded.state, attempts = excluded.attempts,
        next_retry_at = excluded.next_retry_at, request_count = excluded.request_count,
        reference_id = excluded.reference_id, failure_reason = excluded.failure_reason,
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

  saveAuditRound(round: StoredAuditRound, members: readonly StoredAuditRoundMember[] = []): void {
    const insertRound = this._db.prepare(`
      INSERT INTO audit_rounds (
        round_id, service, endpoint_hash, epoch, state, attempts, next_retry_at,
        target_count, generated_probe_count, request_count, failure_reason, created_at, updated_at
      ) VALUES (
        @roundId, @service, @endpointHash, @epoch, @state, @attempts, @nextRetryAt,
        @targetCount, @generatedProbeCount, @requestCount, @failureReason, @createdAt, @updatedAt
      ) ON CONFLICT(round_id) DO UPDATE SET
        service = excluded.service, endpoint_hash = excluded.endpoint_hash, epoch = excluded.epoch,
        state = excluded.state, attempts = excluded.attempts, next_retry_at = excluded.next_retry_at,
        target_count = excluded.target_count, generated_probe_count = excluded.generated_probe_count,
        request_count = excluded.request_count, failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `);
    this._db.transaction(() => {
      insertRound.run({ ...round, service: round.service.trim().toLowerCase() });
      for (const member of members) this.saveAuditRoundMember(member);
    })();
  }

  getAuditRound(roundId: string): StoredAuditRound | null {
    const row = this._db.prepare('SELECT * FROM audit_rounds WHERE round_id = ?').get(roundId) as AuditRoundRow | undefined;
    return row ? rowToAuditRound(row) : null;
  }

  listAuditRounds(state?: AuditRoundState): StoredAuditRound[] {
    const rows = state
      ? this._db.prepare('SELECT * FROM audit_rounds WHERE state = ? ORDER BY created_at').all(state)
      : this._db.prepare('SELECT * FROM audit_rounds ORDER BY created_at').all();
    return (rows as AuditRoundRow[]).map(rowToAuditRound);
  }

  updateAuditRound(
    roundId: string,
    state: AuditRoundState,
    fields: Partial<Pick<StoredAuditRound,
      'attempts' | 'nextRetryAt' | 'targetCount' | 'generatedProbeCount' | 'requestCount' | 'failureReason'>> = {},
  ): void {
    this._db.prepare(`
      UPDATE audit_rounds SET state = @state,
        attempts = COALESCE(@attempts, attempts), next_retry_at = @nextRetryAt,
        target_count = COALESCE(@targetCount, target_count),
        generated_probe_count = COALESCE(@generatedProbeCount, generated_probe_count),
        request_count = COALESCE(@requestCount, request_count),
        failure_reason = @failureReason, updated_at = @updatedAt
      WHERE round_id = @roundId
    `).run({
      roundId,
      state,
      attempts: fields.attempts ?? null,
      nextRetryAt: fields.nextRetryAt ?? null,
      targetCount: fields.targetCount ?? null,
      generatedProbeCount: fields.generatedProbeCount ?? null,
      requestCount: fields.requestCount ?? null,
      failureReason: fields.failureReason ?? null,
      updatedAt: Date.now(),
    });
  }

  saveAuditRoundMember(member: StoredAuditRoundMember): void {
    this._db.prepare(`
      INSERT INTO audit_round_members (
        round_id, audit_id, state, reference_id, probe_count, cached_probe_count,
        generated_probe_count, created_at, updated_at
      ) VALUES (
        @roundId, @auditId, @state, @referenceId, @probeCount, @cachedProbeCount,
        @generatedProbeCount, @createdAt, @updatedAt
      ) ON CONFLICT(round_id, audit_id) DO UPDATE SET
        state = excluded.state, reference_id = excluded.reference_id,
        probe_count = excluded.probe_count, cached_probe_count = excluded.cached_probe_count,
        generated_probe_count = excluded.generated_probe_count, updated_at = excluded.updated_at
    `).run(member);
  }

  getAuditRoundMemberByAuditId(auditId: string): StoredAuditRoundMember | null {
    const row = this._db.prepare('SELECT * FROM audit_round_members WHERE audit_id = ?').get(auditId) as AuditRoundMemberRow | undefined;
    return row ? rowToAuditRoundMember(row) : null;
  }

  listAuditRoundMembers(roundId: string): StoredAuditRoundMember[] {
    const rows = this._db.prepare(`
      SELECT * FROM audit_round_members WHERE round_id = ? ORDER BY created_at, audit_id
    `).all(roundId) as AuditRoundMemberRow[];
    return rows.map(rowToAuditRoundMember);
  }

  updateAuditRoundMember(
    roundId: string,
    auditId: string,
    state: AuditRoundMemberState,
    fields: Partial<Pick<StoredAuditRoundMember,
      'referenceId' | 'probeCount' | 'cachedProbeCount' | 'generatedProbeCount'>> = {},
  ): void {
    this._db.prepare(`
      UPDATE audit_round_members SET state = @state,
        reference_id = COALESCE(@referenceId, reference_id),
        probe_count = COALESCE(@probeCount, probe_count),
        cached_probe_count = COALESCE(@cachedProbeCount, cached_probe_count),
        generated_probe_count = COALESCE(@generatedProbeCount, generated_probe_count),
        updated_at = @updatedAt
      WHERE round_id = @roundId AND audit_id = @auditId
    `).run({
      roundId,
      auditId,
      state,
      referenceId: fields.referenceId ?? null,
      probeCount: fields.probeCount ?? null,
      cachedProbeCount: fields.cachedProbeCount ?? null,
      generatedProbeCount: fields.generatedProbeCount ?? null,
      updatedAt: Date.now(),
    });
  }

  reserveAuditProbes(auditId: string, probeIds: readonly string[], probesPerJob = 10): void {
    if (!Number.isInteger(probesPerJob) || probesPerJob < 1) throw new Error('probesPerJob must be positive');
    if (new Set(probeIds).size !== probeIds.length) throw new Error('audit probe selection contains duplicates');
    const insert = this._db.prepare(`
      INSERT INTO audit_probe_selections (audit_id, ordinal, job_index, probe_id, exposure_counted_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(audit_id, ordinal) DO UPDATE SET
        job_index = excluded.job_index, probe_id = excluded.probe_id
      WHERE audit_probe_selections.exposure_counted_at IS NULL
    `);
    this._db.transaction(() => {
      const existing = this._db.prepare(`
        SELECT COUNT(*) AS count FROM audit_probe_selections
        WHERE audit_id = ? AND exposure_counted_at IS NOT NULL
      `).get(auditId) as { count: number };
      if (existing.count > 0) throw new Error(`audit ${auditId} already exposed probes`);
      this._db.prepare('DELETE FROM audit_probe_selections WHERE audit_id = ?').run(auditId);
      probeIds.forEach((probeId, ordinal) => insert.run(auditId, ordinal, Math.floor(ordinal / probesPerJob), probeId));
    })();
  }

  listAuditProbeSelections(auditId: string): StoredAuditProbeSelection[] {
    const rows = this._db.prepare(`
      SELECT audit_id, ordinal, job_index, probe_id, exposure_counted_at
      FROM audit_probe_selections WHERE audit_id = ? ORDER BY ordinal
    `).all(auditId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      auditId: String(row.audit_id),
      ordinal: Number(row.ordinal),
      jobIndex: Number(row.job_index),
      probeId: String(row.probe_id),
      exposureCountedAt: row.exposure_counted_at === null ? null : Number(row.exposure_counted_at),
    }));
  }

  listActiveReservedProbeIds(agentId: string, service: string, excludeAuditId = ''): string[] {
    const rows = this._db.prepare(`
      SELECT selections.probe_id
      FROM audit_probe_selections selections
      JOIN audit_plans plans ON plans.audit_id = selections.audit_id
      WHERE plans.agent_id = ? AND lower(trim(plans.target_service)) = ?
        AND plans.audit_id <> ? AND plans.state NOT IN ('attested', 'failed')
        AND selections.exposure_counted_at IS NULL
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

  markAuditJobProbeExposure(auditId: string, jobIndex: number, exposedAt = Date.now()): void {
    this._db.transaction(() => {
      const plan = this._db.prepare(`
        SELECT agent_id, lower(trim(target_service)) AS service
        FROM audit_plans WHERE audit_id = ?
      `).get(auditId) as { agent_id: string | null; service: string } | undefined;
      if (!plan?.agent_id) throw new Error(`audit ${auditId} has no target identity`);
      const selections = this._db.prepare(`
        SELECT ordinal, probe_id FROM audit_probe_selections
        WHERE audit_id = ? AND job_index = ? AND exposure_counted_at IS NULL
      `).all(auditId, jobIndex) as Array<{ ordinal: number; probe_id: string }>;
      const upsert = this._db.prepare(`
        INSERT INTO probe_exposures (
          agent_id, service, probe_id, exposure_count, last_audit_id, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(agent_id, service, probe_id) DO UPDATE SET
          last_audit_id = excluded.last_audit_id,
          updated_at = excluded.updated_at
      `);
      const mark = this._db.prepare(`
        UPDATE audit_probe_selections SET exposure_counted_at = ?
        WHERE audit_id = ? AND ordinal = ? AND exposure_counted_at IS NULL
      `);
      for (const selection of selections) {
        upsert.run(plan.agent_id, plan.service, selection.probe_id, auditId, exposedAt);
        mark.run(exposedAt, auditId, selection.ordinal);
      }
    })();
  }

  releaseUnexposedAuditProbeReservations(auditId: string): void {
    this._db.prepare(`
      DELETE FROM audit_probe_selections WHERE audit_id = ? AND exposure_counted_at IS NULL
    `).run(auditId);
  }

  listAuditJobs(auditId: string): StoredAuditJob[] {
    const rows = this._db.prepare('SELECT * FROM audit_jobs WHERE audit_id = ? ORDER BY job_index').all(auditId) as AuditJobRow[];
    return rows.map(rowToAuditJob);
  }

  listDueAuditJobs(now: number): StoredAuditJob[] {
    const rows = this._db.prepare(`
      SELECT * FROM audit_jobs
      WHERE state IN ('planned', 'due', 'assigned') AND scheduled_at <= ? AND execute_before >= ?
      ORDER BY scheduled_at, audit_id, job_index
    `).all(now, Math.floor(now / 1000)) as AuditJobRow[];
    return rows.map(rowToAuditJob);
  }

  updateAuditState(
    auditId: string,
    state: AuditLifecycleState,
    fields: Partial<Pick<StoredAuditPlan,
      'commitTxHash' | 'attestationTxHash' | 'evidenceHash' | 'evidenceUri' | 'evidenceState' | 'failureReason'>> = {},
  ): void {
    const result = this._db.prepare(`
      UPDATE audit_plans SET
        state = @state,
        commit_tx_hash = COALESCE(@commitTxHash, commit_tx_hash),
        attestation_tx_hash = COALESCE(@attestationTxHash, attestation_tx_hash),
        evidence_hash = COALESCE(@evidenceHash, evidence_hash),
        evidence_uri = COALESCE(@evidenceUri, evidence_uri),
        evidence_state = COALESCE(@evidenceState, evidence_state),
        failure_reason = @failureReason,
        updated_at = @updatedAt
      WHERE audit_id = @auditId
    `).run({
      auditId,
      state,
      commitTxHash: fields.commitTxHash ?? null,
      attestationTxHash: fields.attestationTxHash ?? null,
      evidenceHash: fields.evidenceHash ?? null,
      evidenceUri: fields.evidenceUri ?? null,
      evidenceState: fields.evidenceState ?? null,
      failureReason: fields.failureReason ?? null,
      updatedAt: Date.now(),
    });
    if (result.changes !== 1) throw new Error(`unknown audit ${auditId}`);
  }

  assignAuditJob(input: {
    auditId: string;
    jobIndex: number;
    relayPeerId: string;
    relayBuyerAddress: string;
    assignmentAttempt: number;
    assignmentSignature: string;
    assignedAt?: number;
  }): void {
    const assignedAt = input.assignedAt ?? Date.now();
    const result = this._db.prepare(`
      UPDATE audit_jobs SET
        state = 'assigned', relay_peer_id = @relayPeerId, relay_buyer_address = @relayBuyerAddress,
        assignment_attempt = @assignmentAttempt, assignment_signature = @assignmentSignature,
        assignment_state = 'assigned', assigned_at = @assignedAt,
        failure_kind = NULL, failure_message = NULL
      WHERE audit_id = @auditId AND job_index = @jobIndex
        AND state IN ('planned', 'due', 'assigned')
    `).run({ ...input, assignedAt });
    if (result.changes !== 1) throw new Error(`audit job ${input.auditId}/${input.jobIndex} is not assignable`);
  }

  markAuditJobRejected(auditId: string, jobIndex: number, message: string): void {
    const result = this._db.prepare(`
      UPDATE audit_jobs SET
        state = 'due', relay_peer_id = NULL, relay_buyer_address = NULL,
        assignment_signature = NULL, assignment_state = 'rejected', assigned_at = NULL,
        assignment_attempt = assignment_attempt + 1,
        failure_kind = 'relay-rejected', failure_message = ?
      WHERE audit_id = ? AND job_index = ? AND state = 'assigned' AND assignment_attempt < 2
    `).run(message, auditId, jobIndex);
    if (result.changes !== 1) throw new Error(`audit job ${auditId}/${jobIndex} cannot be reassigned`);
  }

  markAuditJobDispatchAttempt(auditId: string, jobIndex: number, attemptedAt = Date.now()): void {
    const result = this._db.prepare(`
      UPDATE audit_jobs SET last_dispatch_at = ?
      WHERE audit_id = ? AND job_index = ? AND state = 'assigned'
    `).run(attemptedAt, auditId, jobIndex);
    if (result.changes !== 1) throw new Error(`audit job ${auditId}/${jobIndex} is not assigned`);
  }

  markAuditJobDispatched(auditId: string, jobIndex: number, dispatchedAt = Date.now()): void {
    const result = this._db.prepare(`
      UPDATE audit_jobs SET state = 'dispatched', assignment_state = 'accepted',
        dispatched_at = ?, last_dispatch_at = ?
      WHERE audit_id = ? AND job_index = ? AND state = 'assigned'
    `).run(dispatchedAt, dispatchedAt, auditId, jobIndex);
    if (result.changes !== 1) throw new Error(`audit job ${auditId}/${jobIndex} is not dispatchable`);
  }

  markAuditJobFailed(
    auditId: string,
    jobIndex: number,
    failureKind: string,
    failureMessage: string,
    completedAt = Date.now(),
  ): void {
    const result = this._db.prepare(`
      UPDATE audit_jobs SET state = 'failed', completed_at = ?, failure_kind = ?, failure_message = ?
      WHERE audit_id = ? AND job_index = ? AND state IN ('planned', 'due', 'assigned', 'dispatched')
    `).run(completedAt, failureKind, failureMessage, auditId, jobIndex);
    if (result.changes !== 1) throw new Error(`audit job ${auditId}/${jobIndex} is not fail-able`);
  }

  persistRelaySuccess(input: {
    auditId: string;
    jobIndex: number;
    responseBytes: Uint8Array;
    entitlement: StoredRelayEntitlement;
    completedAt?: number;
  }): void {
    const completedAt = input.completedAt ?? Date.now();
    const updateJob = this._db.prepare(`
      UPDATE audit_jobs SET
        state = 'succeeded', response_bytes = @responseBytes,
        response_auth_payload = @responseAuthPayload, seller_charge_usdc = @sellerChargeUsdc,
        payment_metadata_json = @paymentMetadataJson, completed_at = @completedAt,
        failure_kind = NULL, failure_message = NULL, entitlement_persisted_at = @completedAt
      WHERE audit_id = @auditId AND job_index = @jobIndex AND state IN ('assigned', 'dispatched')
    `);
    const insertEntitlement = this._db.prepare(`
      INSERT INTO relay_entitlements (
        audit_id, job_index, relay_peer_id, relay_buyer_address, registry_address,
        treasury_address, job_json, positional_proof_json, assignment_json, verifier_signature, response_bytes, response_auth_payload,
        payout_usdc, seller_charge_usdc, payment_metadata_json,
        force_claim_available_at, force_claim_deadline, state, claim_tx_hash,
        created_at, updated_at
      ) VALUES (
        @auditId, @jobIndex, @relayPeerId, @relayBuyerAddress, @registryAddress,
        @treasuryAddress, @jobJson, @positionalProofJson, @assignmentJson, @verifierSignature, @responseBytes, @responseAuthPayload,
        @payoutUsdc, @sellerChargeUsdc, @paymentMetadataJson,
        @forceClaimAvailableAt, @forceClaimDeadline, @state, @claimTxHash,
        @createdAt, @updatedAt
      )
    `);
    this._db.transaction(() => {
      const result = updateJob.run({
        auditId: input.auditId,
        jobIndex: input.jobIndex,
        responseBytes: Buffer.from(input.responseBytes),
        responseAuthPayload: Buffer.from(input.entitlement.responseAuthPayload),
        sellerChargeUsdc: input.entitlement.sellerChargeUsdc.toString(),
        paymentMetadataJson: JSON.stringify(input.entitlement.paymentMetadata),
        completedAt,
      });
      if (result.changes !== 1) throw new Error(`audit job ${input.auditId}/${input.jobIndex} is not completable`);
      const entitlementResult = insertEntitlement.run(serializeEntitlement(input.entitlement));
      if (entitlementResult.changes !== 1) throw new Error(`relay entitlement ${input.auditId}/${input.jobIndex} already exists`);
      this._insertAuditJobCharge(input.auditId, input.jobIndex, input.entitlement.paymentMetadata, input.entitlement.sellerChargeUsdc, completedAt);
    })();
  }

  persistAuditJobSuccess(input: {
    auditId: string;
    jobIndex: number;
    responseBytes: Uint8Array;
    responseAuthPayload: Uint8Array;
    sellerChargeUsdc: bigint;
    paymentMetadata: Record<string, unknown>;
    completedAt?: number;
  }): void {
    const completedAt = input.completedAt ?? Date.now();
    const updateJob = this._db.prepare(`
      UPDATE audit_jobs SET
        state = 'succeeded', response_bytes = @responseBytes,
        response_auth_payload = @responseAuthPayload, seller_charge_usdc = @sellerChargeUsdc,
        payment_metadata_json = @paymentMetadataJson, completed_at = @completedAt,
        failure_kind = NULL, failure_message = NULL
      WHERE audit_id = @auditId AND job_index = @jobIndex AND state IN ('assigned', 'dispatched')
    `);
    this._db.transaction(() => {
      const result = updateJob.run({
        auditId: input.auditId,
        jobIndex: input.jobIndex,
        responseBytes: Buffer.from(input.responseBytes),
        responseAuthPayload: Buffer.from(input.responseAuthPayload),
        sellerChargeUsdc: input.sellerChargeUsdc.toString(),
        paymentMetadataJson: JSON.stringify(input.paymentMetadata),
        completedAt,
      });
      if (result.changes !== 1) throw new Error(`audit job ${input.auditId}/${input.jobIndex} is not completable`);
      this._insertAuditJobCharge(input.auditId, input.jobIndex, input.paymentMetadata, input.sellerChargeUsdc, completedAt);
    })();
  }

  persistRelayEntitlement(entitlement: StoredRelayEntitlement): void {
    this._db.prepare(`
      INSERT INTO relay_entitlements (
        audit_id, job_index, relay_peer_id, relay_buyer_address, registry_address,
        treasury_address, job_json, positional_proof_json, assignment_json, verifier_signature, response_bytes, response_auth_payload,
        payout_usdc, seller_charge_usdc, payment_metadata_json,
        force_claim_available_at, force_claim_deadline, state, claim_tx_hash,
        created_at, updated_at
      ) VALUES (
        @auditId, @jobIndex, @relayPeerId, @relayBuyerAddress, @registryAddress,
        @treasuryAddress, @jobJson, @positionalProofJson, @assignmentJson, @verifierSignature, @responseBytes, @responseAuthPayload,
        @payoutUsdc, @sellerChargeUsdc, @paymentMetadataJson,
        @forceClaimAvailableAt, @forceClaimDeadline, @state, @claimTxHash,
        @createdAt, @updatedAt
      )
    `).run(serializeEntitlement(entitlement));
  }

  private _insertAuditJobCharge(
    auditId: string,
    jobIndex: number,
    paymentMetadata: Record<string, unknown>,
    chargeUsdc: bigint,
    createdAt: number,
  ): void {
    const spendingAuth = paymentMetadata['spendingAuth'];
    if (!spendingAuth || typeof spendingAuth !== 'object' || Array.isArray(spendingAuth)) {
      throw new Error('audit payment metadata has no SpendingAuth');
    }
    const channelId = (spendingAuth as Record<string, unknown>)['channelId'];
    const cumulativeAmount = (spendingAuth as Record<string, unknown>)['cumulativeAmount'];
    if (typeof channelId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(channelId)) {
      throw new Error('audit payment metadata has an invalid channel id');
    }
    if (typeof cumulativeAmount !== 'string' || !/^\d+$/.test(cumulativeAmount)) {
      throw new Error('audit payment metadata has an invalid cumulative amount');
    }
    const result = this._db.prepare(`
      INSERT INTO audit_job_charges (
        audit_id, job_index, channel_id, service_hash, cumulative_amount_usdc, charge_usdc, created_at
      )
      SELECT audit_id, job_index, ?, service_hash, ?, ?, ?
      FROM audit_jobs WHERE audit_id = ? AND job_index = ?
    `).run(channelId, cumulativeAmount, chargeUsdc.toString(), createdAt, auditId, jobIndex);
    if (result.changes !== 1) throw new Error(`audit job ${auditId}/${jobIndex} has no normalized charge target`);
  }

  getRelayEntitlement(auditId: string, jobIndex: number): StoredRelayEntitlement | null {
    const row = this._db.prepare(
      'SELECT * FROM relay_entitlements WHERE audit_id = ? AND job_index = ?',
    ).get(auditId, jobIndex) as RelayEntitlementRow | undefined;
    return row ? rowToEntitlement(row) : null;
  }

  listRelayEntitlements(status?: RelayEntitlementState): StoredRelayEntitlement[] {
    const rows = status
      ? this._db.prepare('SELECT * FROM relay_entitlements WHERE state = ? ORDER BY created_at').all(status)
      : this._db.prepare('SELECT * FROM relay_entitlements ORDER BY created_at').all();
    return (rows as RelayEntitlementRow[]).map(rowToEntitlement);
  }

  updateRelayEntitlementState(
    auditId: string,
    jobIndex: number,
    state: RelayEntitlementState,
    claimTxHash: string | null = null,
  ): void {
    const result = this._db.prepare(`
      UPDATE relay_entitlements SET state = ?, claim_tx_hash = COALESCE(?, claim_tx_hash), updated_at = ?
      WHERE audit_id = ? AND job_index = ?
    `).run(state, claimTxHash, Date.now(), auditId, jobIndex);
    if (result.changes !== 1) throw new Error(`unknown relay entitlement ${auditId}/${jobIndex}`);
  }

  getSettlementCursor(chainId: string, channelsAddress: string): SettlementIndexCursor | null {
    const row = this._db.prepare(`
      SELECT * FROM settlement_index_cursors WHERE chain_id = ? AND channels_address = ?
    `).get(chainId, channelsAddress) as SettlementCursorRow | undefined;
    return row ? {
      chainId: row.chain_id,
      channelsAddress: row.channels_address,
      finalizedBlock: row.finalized_block,
      finalizedBlockHash: row.finalized_block_hash,
      updatedAt: row.updated_at,
    } : null;
  }

  updateSettlementCursor(cursor: SettlementIndexCursor): void {
    this._db.prepare(`
      INSERT INTO settlement_index_cursors (
        chain_id, channels_address, finalized_block, finalized_block_hash, updated_at
      ) VALUES (@chainId, @channelsAddress, @finalizedBlock, @finalizedBlockHash, @updatedAt)
      ON CONFLICT(chain_id, channels_address) DO UPDATE SET
        finalized_block = excluded.finalized_block,
        finalized_block_hash = excluded.finalized_block_hash,
        updated_at = excluded.updated_at
      WHERE excluded.finalized_block >= settlement_index_cursors.finalized_block
    `).run(cursor);
  }

  getSettlementServiceTotal(
    chainId: string,
    channelsAddress: string,
    channelId: string,
    serviceHash: string,
  ): { cumulativeServiceUsdc: bigint; cumulativeChannelUsdc: bigint } | null {
    const row = this._db.prepare(`
      SELECT cumulative_service_usdc, cumulative_channel_usdc
      FROM settlement_service_totals
      WHERE chain_id = ? AND channels_address = ? AND channel_id = ? AND service = ?
    `).get(chainId, channelsAddress, channelId, serviceHash) as {
      cumulative_service_usdc: string;
      cumulative_channel_usdc: string;
    } | undefined;
    return row ? {
      cumulativeServiceUsdc: BigInt(row.cumulative_service_usdc),
      cumulativeChannelUsdc: BigInt(row.cumulative_channel_usdc),
    } : null;
  }

  auditChargeForSettlement(
    channelId: string,
    serviceHash: string,
    previousCumulativeAmountUsdc: bigint,
    cumulativeAmountUsdc: bigint,
  ): bigint {
    const rows = this._db.prepare(`
      SELECT charge_usdc, cumulative_amount_usdc
      FROM audit_job_charges
      WHERE channel_id = ? AND service_hash = ?
    `).all(channelId, serviceHash) as Array<{ charge_usdc: string; cumulative_amount_usdc: string }>;
    return rows.reduce((total, row) => {
      const cumulative = BigInt(row.cumulative_amount_usdc);
      return cumulative > previousCumulativeAmountUsdc && cumulative <= cumulativeAmountUsdc
        ? total + BigInt(row.charge_usdc)
        : total;
    }, 0n);
  }

  recordFinalizedSettlement(event: SettlementUsageEvent, cursor?: SettlementIndexCursor): boolean {
    const insertEvent = this._db.prepare(`
      INSERT OR IGNORE INTO settlement_usage_events (
        chain_id, channels_address, tx_hash, log_index, block_number, block_hash, settled_at,
        channel_id, agent_id, seller_peer_id, service, cumulative_service_usdc,
        service_delta_usdc, cumulative_channel_usdc, channel_delta_usdc,
        audit_charge_usdc, organic_service_delta_usdc
      ) VALUES (
        @chainId, @channelsAddress, @txHash, @logIndex, @blockNumber, @blockHash, @settledAt,
        @channelId, @agentId, @sellerPeerId, @service, @cumulativeServiceUsdc,
        @serviceDeltaUsdc, @cumulativeChannelUsdc, @channelDeltaUsdc,
        @auditChargeUsdc, @organicServiceDeltaUsdc
      )
    `);
    const upsertTotal = this._db.prepare(`
      INSERT INTO settlement_service_totals (
        chain_id, channels_address, channel_id, agent_id, seller_peer_id, service,
        cumulative_service_usdc, cumulative_channel_usdc, last_block_number,
        last_log_index, updated_at
      ) VALUES (
        @chainId, @channelsAddress, @channelId, @agentId, @sellerPeerId, @service,
        @cumulativeServiceUsdc, @cumulativeChannelUsdc, @blockNumber, @logIndex, @updatedAt
      )
      ON CONFLICT(chain_id, channels_address, channel_id, service) DO UPDATE SET
        cumulative_service_usdc = excluded.cumulative_service_usdc,
        cumulative_channel_usdc = excluded.cumulative_channel_usdc,
        last_block_number = excluded.last_block_number,
        last_log_index = excluded.last_log_index,
        updated_at = excluded.updated_at
      WHERE excluded.last_block_number > settlement_service_totals.last_block_number
         OR (excluded.last_block_number = settlement_service_totals.last_block_number
             AND excluded.last_log_index > settlement_service_totals.last_log_index)
    `);
    const upsertCursor = this._db.prepare(`
      INSERT INTO settlement_index_cursors (
        chain_id, channels_address, finalized_block, finalized_block_hash, updated_at
      ) VALUES (@chainId, @channelsAddress, @finalizedBlock, @finalizedBlockHash, @updatedAt)
      ON CONFLICT(chain_id, channels_address) DO UPDATE SET
        finalized_block = excluded.finalized_block,
        finalized_block_hash = excluded.finalized_block_hash,
        updated_at = excluded.updated_at
      WHERE excluded.finalized_block >= settlement_index_cursors.finalized_block
    `);
    return this._db.transaction(() => {
      const inserted = insertEvent.run(serializeSettlementEvent(event)).changes === 1;
      if (inserted) upsertTotal.run({ ...serializeSettlementEvent(event), updatedAt: Date.now() });
      if (cursor) upsertCursor.run(cursor);
      return inserted;
    })();
  }

  computeModelShareBps(agentId: string, failedService: string, fromMs: number, toMs: number): number {
    const failedServiceHash = getServiceMetadataId(failedService);
    const rows = this._db.prepare(`
      SELECT service, organic_service_delta_usdc
      FROM settlement_usage_events
      WHERE agent_id = ? AND settled_at >= ? AND settled_at < ?
    `).all(agentId, fromMs, toMs) as Array<{ service: string; organic_service_delta_usdc: string }>;
    let agentOrganicUsdc = 0n;
    let serviceOrganicUsdc = 0n;
    for (const row of rows) {
      const amount = BigInt(row.organic_service_delta_usdc);
      agentOrganicUsdc += amount;
      if (row.service.toLowerCase() === failedServiceHash.toLowerCase()) serviceOrganicUsdc += amount;
    }
    if (agentOrganicUsdc <= 0n) return 0;
    return Number((serviceOrganicUsdc * 10_000n) / agentOrganicUsdc);
  }

  close(): void {
    this._db.close();
  }
}

interface VerificationStorageStatements {
  insertResponseAuth: Database.Statement;
  getResponseAuth: Database.Statement;
  listResponseAuthsBySeller: Database.Statement;
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

interface AuditPlanRow {
  audit_id: string;
  state: AuditLifecycleState;
  source: 'manual' | 'automatic';
  epoch: string | null;
  duration_ms: number;
  chain_id: string | null;
  registry_address: string | null;
  treasury_address: string | null;
  verifier_address: string | null;
  agent_id: string | null;
  target_peer_id: string;
  target_service: string;
  target_service_hash: string | null;
  target_salt: string | null;
  target_commitment: string | null;
  probe_root: string | null;
  audit_job_root: string | null;
  reference_id: string | null;
  query_profile_hash: string | null;
  verifier_config_hash: string | null;
  probe_count: number | null;
  job_count: number | null;
  required_relay_count: number | null;
  job_timeout_ms: number;
  payout_per_job_usdc: string | null;
  reserved_budget_usdc: string | null;
  commit_tx_hash: string | null;
  attestation_tx_hash: string | null;
  evidence_hash: string | null;
  evidence_uri: string | null;
  evidence_state: 'none' | 'local' | 'published';
  execute_after: number | null;
  execute_before: number | null;
  force_claim_available_at: number | null;
  force_claim_deadline: number | null;
  created_at: number;
  updated_at: number;
  failure_reason: string | null;
}

interface AuditJobRow {
  audit_id: string;
  job_index: number;
  state: AuditJobState;
  scheduled_at: number;
  relay_peer_id: string | null;
  relay_buyer_address: string | null;
  assignment_attempt: number;
  assignment_signature: string | null;
  assignment_state: AuditAssignmentState;
  assigned_at: number | null;
  last_dispatch_at: number | null;
  seller_peer_id: string;
  service: string;
  service_hash: string;
  request_hash: string;
  job_salt: string;
  execute_after: number;
  execute_before: number;
  request_bytes: Buffer;
  positional_proof_json: string;
  response_bytes: Buffer | null;
  response_auth_payload: Buffer | null;
  seller_charge_usdc: string | null;
  payment_metadata_json: string | null;
  dispatched_at: number | null;
  completed_at: number | null;
  failure_kind: string | null;
  failure_message: string | null;
  entitlement_persisted_at: number | null;
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

interface AuditRoundRow {
  round_id: string;
  service: string;
  endpoint_hash: string;
  epoch: string | null;
  state: AuditRoundState;
  attempts: number;
  next_retry_at: number | null;
  target_count: number;
  generated_probe_count: number;
  request_count: number;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface AuditRoundMemberRow {
  round_id: string;
  audit_id: string;
  state: AuditRoundMemberState;
  reference_id: string | null;
  probe_count: number | null;
  cached_probe_count: number;
  generated_probe_count: number;
  created_at: number;
  updated_at: number;
}

interface RelayEntitlementRow {
  audit_id: string;
  job_index: number;
  relay_peer_id: string;
  relay_buyer_address: string;
  registry_address: string;
  treasury_address: string;
  job_json: string;
  positional_proof_json: string;
  assignment_json: string;
  verifier_signature: string;
  response_bytes: Buffer;
  response_auth_payload: Buffer;
  payout_usdc: string;
  seller_charge_usdc: string;
  payment_metadata_json: string;
  force_claim_available_at: number;
  force_claim_deadline: number;
  state: RelayEntitlementState;
  claim_tx_hash: string | null;
  created_at: number;
  updated_at: number;
}

interface SettlementCursorRow {
  chain_id: string;
  channels_address: string;
  finalized_block: number;
  finalized_block_hash: string;
  updated_at: number;
}

function serializeAuditPlan(plan: StoredAuditPlan): Record<string, unknown> {
  return {
    ...plan,
    payoutPerJobUsdc: plan.payoutPerJobUsdc?.toString() ?? null,
    reservedBudgetUsdc: plan.reservedBudgetUsdc?.toString() ?? null,
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

function rowToAuditRound(row: AuditRoundRow): StoredAuditRound {
  return {
    roundId: row.round_id,
    service: row.service,
    endpointHash: row.endpoint_hash,
    epoch: row.epoch,
    state: row.state,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    targetCount: row.target_count,
    generatedProbeCount: row.generated_probe_count,
    requestCount: row.request_count,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAuditRoundMember(row: AuditRoundMemberRow): StoredAuditRoundMember {
  return {
    roundId: row.round_id,
    auditId: row.audit_id,
    state: row.state,
    referenceId: row.reference_id,
    probeCount: row.probe_count,
    cachedProbeCount: row.cached_probe_count,
    generatedProbeCount: row.generated_probe_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAuditPlan(row: AuditPlanRow): StoredAuditPlan {
  return {
    auditId: row.audit_id,
    state: row.state,
    source: row.source,
    epoch: row.epoch,
    durationMs: row.duration_ms,
    chainId: row.chain_id,
    registryAddress: row.registry_address,
    treasuryAddress: row.treasury_address,
    verifierAddress: row.verifier_address,
    agentId: row.agent_id,
    targetPeerId: row.target_peer_id,
    targetService: row.target_service,
    targetServiceHash: row.target_service_hash,
    targetSalt: row.target_salt,
    targetCommitment: row.target_commitment,
    probeRoot: row.probe_root,
    auditJobRoot: row.audit_job_root,
    referenceId: row.reference_id,
    queryProfileHash: row.query_profile_hash,
    verifierConfigHash: row.verifier_config_hash,
    probeCount: row.probe_count,
    jobCount: row.job_count,
    requiredRelayCount: row.required_relay_count,
    jobTimeoutMs: row.job_timeout_ms,
    payoutPerJobUsdc: row.payout_per_job_usdc === null ? null : BigInt(row.payout_per_job_usdc),
    reservedBudgetUsdc: row.reserved_budget_usdc === null ? null : BigInt(row.reserved_budget_usdc),
    commitTxHash: row.commit_tx_hash,
    attestationTxHash: row.attestation_tx_hash,
    evidenceHash: row.evidence_hash,
    evidenceUri: row.evidence_uri,
    evidenceState: row.evidence_state,
    executeAfter: row.execute_after,
    executeBefore: row.execute_before,
    forceClaimAvailableAt: row.force_claim_available_at,
    forceClaimDeadline: row.force_claim_deadline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureReason: row.failure_reason,
  };
}

function serializeAuditJob(job: StoredAuditJob): Record<string, unknown> {
  return {
    ...job,
    requestBytes: Buffer.from(job.requestBytes),
    positionalProofJson: JSON.stringify(job.positionalProof),
    responseBytes: job.responseBytes ? Buffer.from(job.responseBytes) : null,
    responseAuthPayload: job.responseAuthPayload ? Buffer.from(job.responseAuthPayload) : null,
    sellerChargeUsdc: job.sellerChargeUsdc?.toString() ?? null,
    paymentMetadataJson: job.paymentMetadata ? JSON.stringify(job.paymentMetadata) : null,
  };
}

function rowToAuditJob(row: AuditJobRow): StoredAuditJob {
  return {
    auditId: row.audit_id,
    jobIndex: row.job_index,
    state: row.state,
    scheduledAt: row.scheduled_at,
    relayPeerId: row.relay_peer_id,
    relayBuyerAddress: row.relay_buyer_address,
    assignmentAttempt: row.assignment_attempt,
    assignmentSignature: row.assignment_signature,
    assignmentState: row.assignment_state,
    assignedAt: row.assigned_at,
    lastDispatchAt: row.last_dispatch_at,
    sellerPeerId: row.seller_peer_id,
    service: row.service,
    serviceHash: row.service_hash,
    requestHash: row.request_hash,
    jobSalt: row.job_salt,
    executeAfter: row.execute_after,
    executeBefore: row.execute_before,
    requestBytes: new Uint8Array(row.request_bytes),
    positionalProof: JSON.parse(row.positional_proof_json) as string[],
    responseBytes: row.response_bytes ? new Uint8Array(row.response_bytes) : null,
    responseAuthPayload: row.response_auth_payload ? new Uint8Array(row.response_auth_payload) : null,
    sellerChargeUsdc: row.seller_charge_usdc === null ? null : BigInt(row.seller_charge_usdc),
    paymentMetadata: row.payment_metadata_json ? JSON.parse(row.payment_metadata_json) as Record<string, unknown> : null,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    failureKind: row.failure_kind,
    failureMessage: row.failure_message,
    entitlementPersistedAt: row.entitlement_persisted_at,
  };
}

function serializeEntitlement(entitlement: StoredRelayEntitlement): Record<string, unknown> {
  return {
    ...entitlement,
    jobJson: JSON.stringify(entitlement.job),
    positionalProofJson: JSON.stringify(entitlement.positionalProof),
    assignmentJson: JSON.stringify(entitlement.assignment),
    responseBytes: Buffer.from(entitlement.responseBytes),
    responseAuthPayload: Buffer.from(entitlement.responseAuthPayload),
    payoutUsdc: entitlement.payoutUsdc.toString(),
    sellerChargeUsdc: entitlement.sellerChargeUsdc.toString(),
    paymentMetadataJson: JSON.stringify(entitlement.paymentMetadata),
  };
}

function rowToEntitlement(row: RelayEntitlementRow): StoredRelayEntitlement {
  return {
    auditId: row.audit_id,
    jobIndex: row.job_index,
    relayPeerId: row.relay_peer_id,
    relayBuyerAddress: row.relay_buyer_address,
    registryAddress: row.registry_address,
    treasuryAddress: row.treasury_address,
    job: JSON.parse(row.job_json) as Record<string, unknown>,
    positionalProof: JSON.parse(row.positional_proof_json) as string[],
    assignment: JSON.parse(row.assignment_json) as Record<string, unknown>,
    verifierSignature: row.verifier_signature,
    responseBytes: new Uint8Array(row.response_bytes),
    responseAuthPayload: new Uint8Array(row.response_auth_payload),
    payoutUsdc: BigInt(row.payout_usdc),
    sellerChargeUsdc: BigInt(row.seller_charge_usdc),
    paymentMetadata: JSON.parse(row.payment_metadata_json) as Record<string, unknown>,
    forceClaimAvailableAt: row.force_claim_available_at,
    forceClaimDeadline: row.force_claim_deadline,
    state: row.state,
    claimTxHash: row.claim_tx_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeSettlementEvent(event: SettlementUsageEvent): Record<string, unknown> {
  return {
    ...event,
    cumulativeServiceUsdc: event.cumulativeServiceUsdc.toString(),
    serviceDeltaUsdc: event.serviceDeltaUsdc.toString(),
    cumulativeChannelUsdc: event.cumulativeChannelUsdc.toString(),
    channelDeltaUsdc: event.channelDeltaUsdc.toString(),
    auditChargeUsdc: event.auditChargeUsdc.toString(),
    organicServiceDeltaUsdc: event.organicServiceDeltaUsdc.toString(),
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

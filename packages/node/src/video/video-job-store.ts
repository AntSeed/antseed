import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  VideoArtifactManifest,
  VideoGenerationError,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoPaymentQuoteV1,
} from '@antseed/protocol/video';
import { runMigrations } from '../storage/migrate.js';
import { videoMigrations } from '../storage/migrations/video/index.js';

export type InternalVideoStatus = VideoGenerationStatus
  | 'submitting'
  | 'fetching_artifact'
  | 'cancel_requested'
  | 'reconciliation_required';

export interface StoredVideoGeneration {
  id: string;
  buyerPeerId: string;
  sellerPeerId: string;
  provider: string;
  serviceId: string;
  request: VideoGenerationRequest;
  requestHash: string;
  idempotencyKey: string;
  paymentChannelId: string | null;
  upstreamJobId: string | null;
  status: InternalVideoStatus;
  nativeStatus: string | null;
  progress: number | null;
  quote: VideoPaymentQuoteV1;
  executionStatus: 'pending' | 'authorized' | 'earned';
  deliveryStatus: 'pending' | 'authorized' | 'earned';
  error: VideoGenerationError | null;
  pollAttempt: number;
  nextPollAt: number | null;
  workerLeaseUntil: number | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  expiresAt: number;
}

export interface StoredVideoArtifact extends VideoArtifactManifest {
  generationId: string;
  providerArtifactId: string | null;
  path: string;
  createdAt: number;
}

export interface StoredVideoInputAsset {
  id: string;
  buyerPeerId: string;
  path: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
}

export interface VideoJobDiagnostics {
  statusCounts: Record<string, number>;
  reconciliationRequired: Array<{ id: string; provider: string; serviceId: string; updatedAt: number; error: VideoGenerationError | null }>;
  missingUpstreamJobIds: string[];
  pendingMilestoneAuthorizations: number;
  artifactBytes: number;
}

export class VideoJobStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db, videoMigrations);
  }

  close(): void {
    this.db.close();
  }

  createGeneration(generation: StoredVideoGeneration): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO video_generations (
          id, buyer_peer_id, seller_peer_id, provider, service_id,
          request_json, request_hash, idempotency_key, payment_channel_id, upstream_job_id,
          status, native_status, progress, quote_json, execution_status,
          delivery_status, error_json, poll_attempt, next_poll_at,
          worker_lease_until, cancel_requested, created_at, updated_at,
          completed_at, expires_at
        ) VALUES (
          @id, @buyerPeerId, @sellerPeerId, @provider, @serviceId,
          @requestJson, @requestHash, @idempotencyKey, @paymentChannelId, @upstreamJobId,
          @status, @nativeStatus, @progress, @quoteJson, @executionStatus,
          @deliveryStatus, @errorJson, @pollAttempt, @nextPollAt,
          @workerLeaseUntil, @cancelRequested, @createdAt, @updatedAt,
          @completedAt, @expiresAt
        )
      `).run(toGenerationParams(generation));
      this.db.prepare(`
        INSERT INTO video_idempotency_keys (
          buyer_peer_id, idempotency_key, request_hash, generation_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(generation.buyerPeerId, generation.idempotencyKey, generation.requestHash, generation.id, generation.createdAt);
      this.appendEvent(generation.id, 'created', { requestHash: generation.requestHash });
    })();
  }

  getGeneration(id: string): StoredVideoGeneration | null {
    const row = this.db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id) as GenerationRow | undefined;
    return row ? fromGenerationRow(row) : null;
  }

  findByIdempotencyKey(buyerPeerId: string, idempotencyKey: string): StoredVideoGeneration | null {
    const row = this.db.prepare(`
      SELECT g.* FROM video_generations g
      JOIN video_idempotency_keys i ON i.generation_id = g.id
      WHERE i.buyer_peer_id = ? AND i.idempotency_key = ?
    `).get(buyerPeerId, idempotencyKey) as GenerationRow | undefined;
    return row ? fromGenerationRow(row) : null;
  }

  listByBuyer(buyerPeerId: string, limit = 100): StoredVideoGeneration[] {
    return (this.db.prepare(`
      SELECT * FROM video_generations WHERE buyer_peer_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(buyerPeerId, Math.max(1, Math.min(limit, 500))) as GenerationRow[]).map(fromGenerationRow);
  }

  listRecoverable(now = Date.now(), limit = 100): StoredVideoGeneration[] {
    return (this.db.prepare(`
      SELECT * FROM video_generations
      WHERE status IN ('submitting', 'in_progress', 'cancel_requested', 'fetching_artifact')
        AND (next_poll_at IS NULL OR next_poll_at <= ?)
        AND (worker_lease_until IS NULL OR worker_lease_until < ?)
      ORDER BY COALESCE(next_poll_at, 0) ASC LIMIT ?
    `).all(now, now, Math.max(1, Math.min(limit, 500))) as GenerationRow[]).map(fromGenerationRow);
  }

  claimLease(id: string, now: number, leaseMs: number): boolean {
    const result = this.db.prepare(`
      UPDATE video_generations SET worker_lease_until = ?, updated_at = ?
      WHERE id = ? AND (worker_lease_until IS NULL OR worker_lease_until < ?)
    `).run(now + leaseMs, now, id, now);
    return result.changes === 1;
  }

  claimSubmission(id: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE video_generations SET status = 'submitting', updated_at = ?
      WHERE id = ? AND status = 'queued' AND upstream_job_id IS NULL
    `).run(now, id);
    if (result.changes === 1) this.appendEvent(id, 'submission_started');
    return result.changes === 1;
  }

  cancelBeforeSubmission(id: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE video_generations SET
        status = 'canceled', cancel_requested = 1, execution_status = 'pending',
        completed_at = ?, next_poll_at = NULL, worker_lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued' AND upstream_job_id IS NULL
    `).run(now, now, id);
    if (result.changes === 1) this.appendEvent(id, 'canceled_before_submission');
    return result.changes === 1;
  }

  countActiveByBuyer(buyerPeerId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM video_generations
      WHERE buyer_peer_id = ?
        AND status IN ('queued', 'submitting', 'in_progress', 'cancel_requested', 'fetching_artifact', 'reconciliation_required')
    `).get(buyerPeerId) as { count: number };
    return row.count;
  }

  countActiveByProvider(provider: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM video_generations
      WHERE provider = ?
        AND status IN ('submitting', 'in_progress', 'cancel_requested', 'fetching_artifact', 'reconciliation_required')
    `).get(provider) as { count: number };
    return row.count;
  }

  totalArtifactBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM video_artifacts').get() as { bytes: number };
    return row.bytes;
  }

  diagnostics(): VideoJobDiagnostics {
    const statusCounts = Object.fromEntries((this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM video_generations GROUP BY status
    `).all() as Array<{ status: string; count: number }>).map((row) => [row.status, row.count]));
    const reconciliationRequired = (this.db.prepare(`
      SELECT * FROM video_generations WHERE status = 'reconciliation_required'
      ORDER BY updated_at DESC LIMIT 20
    `).all() as GenerationRow[]).map((row) => {
      const generation = fromGenerationRow(row);
      return {
        id: generation.id,
        provider: generation.provider,
        serviceId: generation.serviceId,
        updatedAt: generation.updatedAt,
        error: generation.error,
      };
    });
    const missingUpstreamJobIds = (this.db.prepare(`
      SELECT id FROM video_generations
      WHERE status IN ('in_progress', 'cancel_requested', 'fetching_artifact') AND upstream_job_id IS NULL
      ORDER BY updated_at DESC LIMIT 20
    `).all() as Array<{ id: string }>).map((row) => row.id);
    const pending = this.db.prepare(`
      SELECT COUNT(*) AS count FROM video_pending_milestone_auths WHERE promoted_at IS NULL
    `).get() as { count: number };
    return {
      statusCounts,
      reconciliationRequired,
      missingUpstreamJobIds,
      pendingMilestoneAuthorizations: pending.count,
      artifactBytes: this.totalArtifactBytes(),
    };
  }

  updateGeneration(id: string, patch: Partial<StoredVideoGeneration>, eventType = 'updated'): void {
    const current = this.getGeneration(id);
    if (!current) throw new Error(`Unknown video generation ${id}`);
    const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE video_generations SET
          payment_channel_id=@paymentChannelId, upstream_job_id=@upstreamJobId, status=@status, native_status=@nativeStatus,
          progress=@progress, quote_json=@quoteJson, execution_status=@executionStatus,
          delivery_status=@deliveryStatus, error_json=@errorJson, poll_attempt=@pollAttempt,
          next_poll_at=@nextPollAt, worker_lease_until=@workerLeaseUntil,
          cancel_requested=@cancelRequested, updated_at=@updatedAt,
          completed_at=@completedAt, expires_at=@expiresAt
        WHERE id=@id
      `).run(toGenerationParams(next));
      this.appendEvent(id, eventType, patch);
    })();
  }

  addArtifact(artifact: StoredVideoArtifact): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO video_artifacts (
          id, generation_id, provider_artifact_id, path, mime_type, bytes,
          sha256, duration_seconds, width, height, fps, has_audio,
          created_at, expires_at
        ) VALUES (
          @id, @generationId, @providerArtifactId, @path, @mime_type, @bytes,
          @sha256, @duration_seconds, @width, @height, @fps, @has_audio,
          @createdAt, @expires_at
        )
      `).run({
        ...artifact,
        duration_seconds: artifact.duration_seconds ?? null,
        width: artifact.width ?? null,
        height: artifact.height ?? null,
        fps: artifact.fps ?? null,
        has_audio: artifact.has_audio === undefined ? null : artifact.has_audio ? 1 : 0,
      });
      this.appendEvent(artifact.generationId, 'artifact_cached', { artifactId: artifact.id, sha256: artifact.sha256 });
    })();
  }

  addInputAsset(asset: StoredVideoInputAsset): void {
    this.db.prepare(`
      INSERT INTO video_input_assets (id, buyer_peer_id, path, mime_type, bytes, sha256, created_at, expires_at)
      VALUES (@id, @buyerPeerId, @path, @mimeType, @bytes, @sha256, @createdAt, @expiresAt)
    `).run(asset);
  }

  getInputAsset(id: string, buyerPeerId: string): StoredVideoInputAsset | null {
    const row = this.db.prepare(`
      SELECT * FROM video_input_assets WHERE id = ? AND buyer_peer_id = ? AND expires_at > ?
    `).get(id, buyerPeerId, Date.now()) as {
      id: string; buyer_peer_id: string; path: string; mime_type: string; bytes: number;
      sha256: string; created_at: number; expires_at: number;
    } | undefined;
    return row ? {
      id: row.id, buyerPeerId: row.buyer_peer_id, path: row.path, mimeType: row.mime_type,
      bytes: row.bytes, sha256: row.sha256, createdAt: row.created_at, expiresAt: row.expires_at,
    } : null;
  }

  getArtifact(generationId: string, artifactId: string): StoredVideoArtifact | null {
    const row = this.db.prepare(`
      SELECT * FROM video_artifacts WHERE generation_id = ? AND id = ?
    `).get(generationId, artifactId) as ArtifactRow | undefined;
    return row ? fromArtifactRow(row) : null;
  }

  listArtifacts(generationId: string): StoredVideoArtifact[] {
    return (this.db.prepare(`SELECT * FROM video_artifacts WHERE generation_id = ? ORDER BY created_at`).all(generationId) as ArtifactRow[])
      .map(fromArtifactRow);
  }

  savePendingMilestoneAuth(generationId: string, milestoneId: 'execution' | 'delivery', auth: unknown): void {
    this.db.prepare(`
      INSERT INTO video_pending_milestone_auths (generation_id, milestone_id, auth_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(generation_id, milestone_id) DO UPDATE SET auth_json=excluded.auth_json, created_at=excluded.created_at
    `).run(
      generationId,
      milestoneId,
      JSON.stringify(auth, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
      Date.now(),
    );
  }

  listExpiredFiles(now = Date.now()): string[] {
    const artifacts = this.db.prepare('SELECT path FROM video_artifacts WHERE expires_at <= ?').all(now) as Array<{ path: string }>;
    const inputs = this.db.prepare('SELECT path FROM video_input_assets WHERE expires_at <= ?').all(now) as Array<{ path: string }>;
    return [...artifacts, ...inputs].map((row) => row.path);
  }

  deleteExpired(now = Date.now()): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM video_artifacts WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM video_input_assets WHERE expires_at <= ?').run(now);
      this.db.prepare(`
        DELETE FROM video_generations
        WHERE expires_at <= ? AND status IN ('succeeded', 'failed', 'canceled', 'expired')
      `).run(now);
    })();
  }

  promoteMilestoneAuth(generationId: string, milestoneId: 'execution' | 'delivery'): void {
    this.db.prepare(`
      UPDATE video_pending_milestone_auths SET promoted_at = ?
      WHERE generation_id = ? AND milestone_id = ?
    `).run(Date.now(), generationId, milestoneId);
  }

  discardPendingMilestoneAuth(generationId: string, milestoneId: 'execution' | 'delivery'): void {
    this.db.prepare(`
      DELETE FROM video_pending_milestone_auths
      WHERE generation_id = ? AND milestone_id = ? AND promoted_at IS NULL
    `).run(generationId, milestoneId);
  }

  appendEvent(generationId: string, eventType: string, payload?: unknown): void {
    this.db.prepare(`
      INSERT INTO video_generation_events (generation_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(generationId, eventType, payload === undefined ? null : JSON.stringify(payload), Date.now());
  }
}

interface GenerationRow {
  id: string; buyer_peer_id: string; seller_peer_id: string; provider: string; service_id: string;
  request_json: string; request_hash: string; idempotency_key: string; payment_channel_id: string | null; upstream_job_id: string | null;
  status: InternalVideoStatus; native_status: string | null; progress: number | null; quote_json: string;
  execution_status: StoredVideoGeneration['executionStatus']; delivery_status: StoredVideoGeneration['deliveryStatus'];
  error_json: string | null; poll_attempt: number; next_poll_at: number | null; worker_lease_until: number | null;
  cancel_requested: number; created_at: number; updated_at: number; completed_at: number | null; expires_at: number;
}

interface ArtifactRow {
  id: string; generation_id: string; provider_artifact_id: string | null; path: string; mime_type: string;
  bytes: number; sha256: string; duration_seconds: number | null; width: number | null; height: number | null;
  fps: number | null; has_audio: number | null; created_at: number; expires_at: number;
}

function toGenerationParams(generation: StoredVideoGeneration): Record<string, unknown> {
  return {
    ...generation,
    requestJson: JSON.stringify(generation.request),
    quoteJson: JSON.stringify(generation.quote),
    errorJson: generation.error ? JSON.stringify(generation.error) : null,
    cancelRequested: generation.cancelRequested ? 1 : 0,
  };
}

function fromGenerationRow(row: GenerationRow): StoredVideoGeneration {
  return {
    id: row.id, buyerPeerId: row.buyer_peer_id, sellerPeerId: row.seller_peer_id,
    provider: row.provider, serviceId: row.service_id, request: JSON.parse(row.request_json) as VideoGenerationRequest,
    requestHash: row.request_hash, idempotencyKey: row.idempotency_key, paymentChannelId: row.payment_channel_id, upstreamJobId: row.upstream_job_id,
    status: row.status, nativeStatus: row.native_status, progress: row.progress,
    quote: JSON.parse(row.quote_json) as VideoPaymentQuoteV1, executionStatus: row.execution_status,
    deliveryStatus: row.delivery_status, error: row.error_json ? JSON.parse(row.error_json) as VideoGenerationError : null,
    pollAttempt: row.poll_attempt, nextPollAt: row.next_poll_at, workerLeaseUntil: row.worker_lease_until,
    cancelRequested: row.cancel_requested === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at, expiresAt: row.expires_at,
  };
}

function fromArtifactRow(row: ArtifactRow): StoredVideoArtifact {
  return {
    id: row.id, generationId: row.generation_id, providerArtifactId: row.provider_artifact_id, path: row.path,
    type: 'video', mime_type: row.mime_type, bytes: row.bytes, sha256: row.sha256,
    ...(row.duration_seconds === null ? {} : { duration_seconds: row.duration_seconds }),
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    ...(row.fps === null ? {} : { fps: row.fps }),
    ...(row.has_audio === null ? {} : { has_audio: row.has_audio === 1 }),
    createdAt: row.created_at, expires_at: row.expires_at,
    links: { content: `/v1/video/generations/${row.generation_id}/artifacts/${row.id}/content` },
  };
}

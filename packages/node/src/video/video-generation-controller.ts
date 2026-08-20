import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
} from '../types/http.js';
import type { Identity } from '../p2p/identity.js';
import { signUtf8, verifyUtf8 } from '../p2p/identity.js';
import type { Provider } from '../interfaces/seller-provider.js';
import type { ProviderVideoArtifact, VideoProviderAdapter } from '../interfaces/video-provider.js';
import type { SellerPaymentManager } from '../payments/seller-payment-manager.js';
import {
  validateVideoGenerationRequest,
  type VideoGenerationRequest,
  type VideoGenerationResource,
  type VideoGenerationStatus,
  type VideoPaymentQuoteV1,
  type VideoDeliveryReceiptV1,
} from '@antseed/protocol/video';
import {
  VideoJobStore,
  type StoredVideoArtifact,
  type StoredVideoGeneration,
} from './video-job-store.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_INPUT_ASSET_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_STORAGE_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ACTIVE_PER_BUYER = 4;
const POLL_TICK_MS = 1_000;
const WORKER_LEASE_MS = 60_000;

export interface VideoGenerationControllerConfig {
  identity: Identity;
  providers: Provider[];
  dataDir: string;
  retentionMs?: number;
  maxArtifactBytes?: number;
  maxInputAssetBytes?: number;
  maxStorageBytes?: number;
  maxActivePerBuyer?: number;
  sellerPaymentManager?: SellerPaymentManager | null;
}

export interface VideoStreamResponse {
  response: SerializedHttpResponse;
  chunks: AsyncIterable<Uint8Array>;
}

export type VideoControllerResult = SerializedHttpResponse | VideoStreamResponse;

export class VideoGenerationController {
  private readonly store: VideoJobStore;
  private readonly artifactDir: string;
  private readonly inputDir: string;
  private readonly retentionMs: number;
  private readonly maxArtifactBytes: number;
  private readonly maxInputAssetBytes: number;
  private readonly maxStorageBytes: number;
  private readonly maxActivePerBuyer: number;
  private readonly adapters: Map<string, { provider: Provider; adapter: VideoProviderAdapter }>;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastCleanupAt = 0;

  constructor(private readonly config: VideoGenerationControllerConfig) {
    const root = join(config.dataDir, 'video');
    this.store = new VideoJobStore(join(root, 'video-jobs.db'));
    this.artifactDir = join(root, 'artifacts');
    this.inputDir = join(root, 'inputs');
    this.retentionMs = config.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxArtifactBytes = config.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxInputAssetBytes = config.maxInputAssetBytes ?? DEFAULT_MAX_INPUT_ASSET_BYTES;
    this.maxStorageBytes = config.maxStorageBytes ?? DEFAULT_MAX_STORAGE_BYTES;
    this.maxActivePerBuyer = config.maxActivePerBuyer ?? DEFAULT_MAX_ACTIVE_PER_BUYER;
    this.adapters = new Map(
      config.providers
        .filter((provider): provider is Provider & { videoAdapter: VideoProviderAdapter } => provider.videoAdapter !== undefined)
        .map((provider) => [provider.name, { provider, adapter: provider.videoAdapter }]),
    );
  }

  get enabled(): boolean {
    return this.adapters.size > 0;
  }

  async start(): Promise<void> {
    await mkdir(this.artifactDir, { recursive: true });
    await mkdir(this.inputDir, { recursive: true });
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollDueJobs(), POLL_TICK_MS);
    this.pollTimer.unref?.();
    void this.pollDueJobs();
  }

  close(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.store.close();
  }

  isVideoPath(path: string): boolean {
    const normalized = path.split('?')[0]?.toLowerCase() ?? '';
    return normalized === '/v1/video/assets' || normalized.startsWith('/v1/video/generations');
  }

  async handleRequest(request: SerializedHttpRequest, buyerPeerId: string): Promise<VideoControllerResult> {
    const url = new URL(request.path, 'http://antseed.local');
    const path = url.pathname;
    if (path === '/v1/video/assets' && request.method === 'POST') return this.createInputAsset(request, buyerPeerId);
    if (path === '/v1/video/generations' && request.method === 'POST') return this.createGeneration(request, buyerPeerId);
    if (path === '/v1/video/generations' && request.method === 'GET') return this.listGenerations(request, buyerPeerId, url);

    const contentMatch = /^\/v1\/video\/generations\/([^/]+)\/artifacts\/([^/]+)\/content$/.exec(path);
    if (contentMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      return this.getArtifactContent(request, buyerPeerId, contentMatch[1]!, contentMatch[2]!);
    }
    const receiptMatch = /^\/v1\/video\/generations\/([^/]+)\/artifacts\/([^/]+)\/receipt$/.exec(path);
    if (receiptMatch && request.method === 'POST') {
      return this.acceptDeliveryReceipt(request, buyerPeerId, receiptMatch[1]!, receiptMatch[2]!);
    }
    const cancelMatch = /^\/v1\/video\/generations\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch && request.method === 'POST') return this.cancelGeneration(request, buyerPeerId, cancelMatch[1]!);
    const generationMatch = /^\/v1\/video\/generations\/([^/]+)$/.exec(path);
    if (generationMatch && request.method === 'GET') return this.getGeneration(request, buyerPeerId, generationMatch[1]!);
    return jsonResponse(request.requestId, 404, { error: { code: 'not_found', message: 'Video endpoint not found', retryable: false } });
  }

  private async createInputAsset(request: SerializedHttpRequest, buyerPeerId: string): Promise<SerializedHttpResponse> {
    const mimeType = getHeader(request.headers, 'content-type');
    if (!mimeType.startsWith('image/')) return errorResponse(request.requestId, 422, 'invalid_asset', 'Input asset must be an image');
    if (request.body.length === 0 || request.body.length > this.maxInputAssetBytes) {
      return errorResponse(request.requestId, 413, 'asset_too_large', `Input asset must be between 1 and ${this.maxInputAssetBytes} bytes`);
    }
    const id = `asset_${randomUUID().replaceAll('-', '')}`;
    const extension = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
    const path = join(this.inputDir, `${id}${extension}`);
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, request.body));
    const sha256 = createHash('sha256').update(request.body).digest('hex');
    const now = Date.now();
    this.store.addInputAsset({
      id, buyerPeerId, path, mimeType, bytes: request.body.length, sha256,
      createdAt: now, expiresAt: now + this.retentionMs,
    });
    return jsonResponse(request.requestId, 201, {
      id, object: 'video.input_asset', mime_type: mimeType, bytes: request.body.length,
      sha256, expires_at: Math.floor((now + this.retentionMs) / 1000),
    });
  }

  private async createGeneration(request: SerializedHttpRequest, buyerPeerId: string): Promise<SerializedHttpResponse> {
    const idempotencyKey = getHeader(request.headers, 'idempotency-key').trim();
    if (!idempotencyKey) return errorResponse(request.requestId, 400, 'idempotency_key_required', 'Idempotency-Key is required');
    const parsed = parseJson(request.body);
    if (!parsed) return errorResponse(request.requestId, 400, 'invalid_json', 'Request body must be valid JSON');
    const model = typeof parsed.model === 'string' ? parsed.model : '';
    const selected = this.selectAdapter(model, getHeader(request.headers, 'x-antseed-provider'));
    if (!selected) return errorResponse(request.requestId, 422, 'model_not_found', `No video provider serves model "${model}"`);
    const capabilities = selected.adapter.getCapabilities(model);
    const providerErrors = selected.adapter.validateRequest?.(parsed as unknown as VideoGenerationRequest) ?? [];
    const validationErrors = validateVideoGenerationRequest(parsed, {
      supportedModels: selected.adapter.supportedModels,
      ...(capabilities ? { capabilities } : {}),
      providerErrors,
    });
    if (validationErrors.length > 0) {
      return jsonResponse(request.requestId, 422, {
        error: { code: 'invalid_video_request', message: validationErrors.join('; '), retryable: false, details: validationErrors },
      });
    }
    const videoRequest = parsed as unknown as VideoGenerationRequest;
    const requestHash = sha256Canonical(videoRequest);
    let created = false;
    let existing = this.store.findByIdempotencyKey(buyerPeerId, idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) return errorResponse(request.requestId, 409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request');
      if (existing.status !== 'queued') return this.generationResponse(request.requestId, existing, existing.status === 'submitting' ? 202 : 200);
    } else {
      if (this.store.countActiveByBuyer(buyerPeerId) >= this.maxActivePerBuyer) {
        return errorResponse(request.requestId, 429, 'buyer_video_limit', `Buyer already has ${this.maxActivePerBuyer} active video generations`, true);
      }
      const input = videoRequest.input_assets?.[0];
      const inputAsset = input ? this.store.getInputAsset(input.asset_id, buyerPeerId) : null;
      if (input && !inputAsset) {
        return errorResponse(request.requestId, 422, 'asset_not_found', 'The first-frame asset is missing, expired, or owned by another buyer');
      }
      if (inputAsset && capabilities?.maxFirstFrameBytes && inputAsset.bytes > capabilities.maxFirstFrameBytes) {
        return errorResponse(request.requestId, 422, 'asset_too_large_for_model', `The first-frame asset exceeds the model limit of ${capabilities.maxFirstFrameBytes} bytes`);
      }
      const now = Date.now();
      const id = `vg_${randomUUID().replaceAll('-', '')}`;
      const totalAmount = this.quoteAmount(selected.provider, model, videoRequest);
      const upfrontBps = capabilities?.upfrontBps ?? 5_000;
      const upfrontAmount = totalAmount * BigInt(upfrontBps) / 10_000n;
      const unsignedQuote = {
        version: 1 as const,
        quote_id: `vq_${randomUUID().replaceAll('-', '')}`,
        request_hash: requestHash,
        seller_peer_id: this.config.identity.peerId,
        total_amount: totalAmount.toString(),
        upfront_amount: upfrontAmount.toString(),
        delivery_amount: (totalAmount - upfrontAmount).toString(),
        upfront_bps: upfrontBps,
        expires_at: Math.floor((now + 5 * 60_000) / 1000),
      };
      const quote: VideoPaymentQuoteV1 = {
        ...unsignedQuote,
        signature: await signUtf8(this.config.identity.wallet, JSON.stringify(unsignedQuote)),
      };
      existing = {
        id, buyerPeerId, sellerPeerId: this.config.identity.peerId, provider: selected.provider.name,
        serviceId: model, request: videoRequest, requestHash, idempotencyKey, paymentChannelId: null, upstreamJobId: null,
        status: 'queued', nativeStatus: null, progress: null, quote,
        executionStatus: 'pending', deliveryStatus: 'pending', error: null,
        pollAttempt: 0, nextPollAt: null, workerLeaseUntil: null, cancelRequested: false,
        createdAt: now, updatedAt: now, completedAt: null, expiresAt: now + this.retentionMs,
      };
      try {
        this.store.createGeneration(existing);
        created = true;
      } catch (error) {
        const concurrent = this.store.findByIdempotencyKey(buyerPeerId, idempotencyKey);
        if (!concurrent) throw error;
        if (concurrent.requestHash !== requestHash) {
          return errorResponse(request.requestId, 409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request');
        }
        existing = concurrent;
      }
    }

    if (existing.quote.expires_at <= Math.floor(Date.now() / 1000)) {
      return errorResponse(request.requestId, 409, 'video_quote_expired', 'The video quote expired; retry with a new Idempotency-Key');
    }

    const providerCapacity = Math.max(1, selected.provider.maxConcurrency ?? 1);
    if (this.store.countActiveByProvider(selected.provider.name) >= providerCapacity) {
      return errorResponse(request.requestId, 429, 'provider_video_capacity', 'The selected video provider is at capacity', true);
    }

    const authorization = this.executionAuthorization(existing, request.requestId, created);
    if ('response' in authorization) return authorization.response;
    if (!this.store.claimSubmission(existing.id)) {
      return this.generationResponse(request.requestId, this.store.getGeneration(existing.id) ?? existing, 202);
    }
    this.store.updateGeneration(existing.id, {
      executionStatus: 'authorized',
      paymentChannelId: authorization.channelId,
    }, 'execution_authorized');
    this.store.savePendingMilestoneAuth(existing.id, 'execution', authorization);

    let firstFrame: Uint8Array | undefined;
    let firstFrameMimeType: string | undefined;
    const input = videoRequest.input_assets?.[0];
    if (input) {
      const asset = this.store.getInputAsset(input.asset_id, buyerPeerId);
      if (!asset) {
        this.store.discardPendingMilestoneAuth(existing.id, 'execution');
        this.store.updateGeneration(existing.id, {
          status: 'failed', executionStatus: 'pending', completedAt: Date.now(), workerLeaseUntil: null,
          error: { code: 'asset_expired', message: 'The first-frame asset expired before submission', retryable: false },
        }, 'asset_expired_before_submission');
        return errorResponse(request.requestId, 422, 'asset_not_found', 'The first-frame asset expired before submission');
      }
      firstFrame = new Uint8Array(await readFile(asset.path));
      firstFrameMimeType = asset.mimeType;
    }
    const latest = this.store.getGeneration(existing.id);
    if (latest?.cancelRequested) {
      this.store.discardPendingMilestoneAuth(existing.id, 'execution');
      this.store.updateGeneration(existing.id, {
        status: 'canceled', executionStatus: 'pending', completedAt: Date.now(), nextPollAt: null,
        workerLeaseUntil: null,
      }, 'canceled_before_upstream_submission');
      return this.generationResponse(request.requestId, this.store.getGeneration(existing.id) ?? latest);
    }
    try {
      const upstream = await selected.adapter.create(videoRequest, {
        idempotencyKey,
        generationId: existing.id,
        ...(firstFrame ? { firstFrame } : {}),
        ...(firstFrameMimeType ? { firstFrameMimeType } : {}),
      });
      const acceptedAt = Date.now();
      this.store.updateGeneration(existing.id, {
        upstreamJobId: upstream.id, status: upstream.status,
        nativeStatus: upstream.nativeStatus ?? null, progress: upstream.progress ?? null,
        executionStatus: 'earned', nextPollAt: acceptedAt + (upstream.retryAfterMs ?? 2_000),
        updatedAt: acceptedAt,
      }, 'upstream_accepted');
      this.store.promoteMilestoneAuth(existing.id, 'execution');
      if (authorization.channelId && authorization.amount > 0n) {
        this.config.sellerPaymentManager?.recordSpend(authorization.channelId, authorization.amount);
      }
      let accepted = this.store.getGeneration(existing.id) ?? existing;
      if (accepted.cancelRequested) {
        try {
          const cancelResult = await selected.adapter.cancel(upstream.id);
          this.store.updateGeneration(existing.id, {
            status: cancelResult.status,
            ...(cancelResult.status === 'canceled' ? { completedAt: Date.now(), nextPollAt: null } : {}),
          }, 'cancel_after_upstream_acceptance');
        } catch (error) {
          this.store.updateGeneration(existing.id, {
            status: 'cancel_requested',
            error: { code: 'cancel_failed', message: errorMessage(error), retryable: true },
          }, 'cancel_after_acceptance_failed');
        }
        accepted = this.store.getGeneration(existing.id) ?? accepted;
      }
      return this.generationResponse(request.requestId, accepted, 202);
    } catch (error) {
      const knownRejection = /_http_4\d\d$/.test(error instanceof Error ? error.name : '');
      if (knownRejection) this.store.discardPendingMilestoneAuth(existing.id, 'execution');
      this.store.updateGeneration(existing.id, {
        status: knownRejection ? 'failed' : 'reconciliation_required',
        executionStatus: knownRejection ? 'pending' : 'authorized',
        completedAt: knownRejection ? Date.now() : null,
        error: { code: knownRejection ? 'upstream_rejected' : 'upstream_create_uncertain', message: errorMessage(error), retryable: !knownRejection },
      }, knownRejection ? 'upstream_rejected' : 'reconciliation_required');
      return errorResponse(request.requestId, 502, knownRejection ? 'upstream_rejected' : 'upstream_create_uncertain', errorMessage(error), !knownRejection);
    }
  }

  private getGeneration(request: SerializedHttpRequest, buyerPeerId: string, id: string): SerializedHttpResponse {
    const generation = this.ownedGeneration(id, buyerPeerId);
    return generation
      ? this.generationResponse(request.requestId, generation)
      : errorResponse(request.requestId, 404, 'generation_not_found', 'Generation not found');
  }

  private listGenerations(request: SerializedHttpRequest, buyerPeerId: string, url: URL): SerializedHttpResponse {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? '100') || 100, 500));
    return jsonResponse(request.requestId, 200, {
      object: 'list', data: this.store.listByBuyer(buyerPeerId, limit).map((item) => this.toResource(item)),
    });
  }

  private async cancelGeneration(request: SerializedHttpRequest, buyerPeerId: string, id: string): Promise<SerializedHttpResponse> {
    const generation = this.ownedGeneration(id, buyerPeerId);
    if (!generation) return errorResponse(request.requestId, 404, 'generation_not_found', 'Generation not found');
    if (isTerminal(generation.status)) {
      return jsonResponse(request.requestId, 200, { id, status: publicStatus(generation.status), cancellation_requested: false });
    }
    if (!generation.upstreamJobId) {
      if (this.store.cancelBeforeSubmission(id)) {
        return jsonResponse(request.requestId, 200, { id, status: 'canceled', cancellation_requested: false });
      }
      this.store.updateGeneration(id, { cancelRequested: true }, 'cancel_requested_during_submission');
      return jsonResponse(request.requestId, 202, { id, status: publicStatus(generation.status), cancellation_requested: true });
    }
    const selected = this.adapters.get(generation.provider);
    if (!selected) return errorResponse(request.requestId, 409, 'cannot_cancel', 'Generation provider is unavailable');
    this.store.updateGeneration(id, { cancelRequested: true, status: 'cancel_requested' }, 'cancel_requested');
    try {
      const result = await selected.adapter.cancel(generation.upstreamJobId);
      this.store.updateGeneration(id, {
        status: result.status,
        ...(result.status === 'canceled' ? { completedAt: Date.now() } : {}),
        workerLeaseUntil: null,
      }, 'cancel_result');
      return jsonResponse(request.requestId, result.accepted ? 202 : 200, {
        id, status: result.status, cancellation_requested: result.accepted && result.status !== 'canceled',
      });
    } catch (error) {
      this.store.updateGeneration(id, { status: generation.status, workerLeaseUntil: null }, 'cancel_failed');
      return errorResponse(request.requestId, 502, 'cancel_failed', errorMessage(error), true);
    }
  }

  private async getArtifactContent(
    request: SerializedHttpRequest,
    buyerPeerId: string,
    generationId: string,
    artifactId: string,
  ): Promise<VideoControllerResult> {
    const generation = this.ownedGeneration(generationId, buyerPeerId);
    if (!generation) return errorResponse(request.requestId, 404, 'generation_not_found', 'Generation not found');
    const artifact = this.store.getArtifact(generationId, artifactId);
    if (!artifact || artifact.expires_at <= Date.now()) return errorResponse(request.requestId, 404, 'artifact_not_found', 'Artifact not found or expired');
    const file = await stat(artifact.path).catch(() => null);
    if (!file?.isFile()) return errorResponse(request.requestId, 404, 'artifact_not_found', 'Artifact file is unavailable');
    const range = parseRange(getHeader(request.headers, 'range'), file.size);
    if (range === 'invalid') {
      return {
        requestId: request.requestId, statusCode: 416,
        headers: { 'content-range': `bytes */${file.size}`, 'accept-ranges': 'bytes' }, body: new Uint8Array(0),
      };
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    const headers: Record<string, string> = {
      'content-type': artifact.mime_type,
      'content-length': String(Math.max(0, end - start + 1)),
      'accept-ranges': 'bytes',
      etag: `"sha256-${artifact.sha256}"`,
      'x-antseed-artifact-sha256': artifact.sha256,
      'content-disposition': `attachment; filename="${basename(artifact.path)}"`,
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${file.size}`;
    const response: SerializedHttpResponse = {
      requestId: request.requestId, statusCode: range ? 206 : 200, headers, body: new Uint8Array(0),
    };
    if (request.method === 'HEAD') return response;
    return { response, chunks: fileChunks(artifact.path, start, end) };
  }

  private executionAuthorization(
    generation: StoredVideoGeneration,
    requestId: string,
    forceQuote: boolean,
  ): { channelId: string | null; amount: bigint } | { response: SerializedHttpResponse } {
    const amount = BigInt(generation.quote.upfront_amount);
    if (amount === 0n) return { channelId: null, amount };
    const payments = this.config.sellerPaymentManager;
    if (!payments) {
      return { response: errorResponse(requestId, 503, 'video_payments_unavailable', 'Paid video generation requires seller payment channels') };
    }
    const channel = payments.getChannelByPeer(generation.buyerPeerId);
    if (!channel) {
      const requirements = payments.getPaymentRequirements(requestId, generation.buyerPeerId);
      return {
        response: this.paymentRequiredResponse(requestId, generation, {
          minBudgetPerRequest: amount.toString(),
          suggestedAmount: maxBigInt(BigInt(requirements.suggestedAmount), BigInt(generation.quote.total_amount)).toString(),
        }),
      };
    }
    const target = payments.getCumulativeSpend(channel.sessionId) + amount;
    if (forceQuote || payments.getAcceptedCumulative(channel.sessionId) < target) {
      return {
        response: this.paymentRequiredResponse(requestId, generation, {
          minBudgetPerRequest: amount.toString(),
          suggestedAmount: maxBigInt(target, BigInt(generation.quote.total_amount)).toString(),
          requiredCumulativeAmount: target.toString(),
          currentSpent: payments.getCumulativeSpend(channel.sessionId).toString(),
          currentAcceptedCumulative: payments.getAcceptedCumulative(channel.sessionId).toString(),
          channelId: channel.sessionId,
          reserveMaxAmount: payments.getReserveMax(channel.sessionId).toString(),
        }),
      };
    }
    return { channelId: channel.sessionId, amount };
  }

  private async acceptDeliveryReceipt(
    request: SerializedHttpRequest,
    buyerPeerId: string,
    generationId: string,
    artifactId: string,
  ): Promise<SerializedHttpResponse> {
    const generation = this.ownedGeneration(generationId, buyerPeerId);
    if (!generation) return errorResponse(request.requestId, 404, 'generation_not_found', 'Generation not found');
    const artifact = this.store.getArtifact(generationId, artifactId);
    if (!artifact) return errorResponse(request.requestId, 404, 'artifact_not_found', 'Artifact not found');
    const parsed = parseJson(request.body);
    if (!parsed) return errorResponse(request.requestId, 400, 'invalid_receipt', 'Delivery receipt must be valid JSON');
    const receipt = parsed as unknown as VideoDeliveryReceiptV1;
    const unsignedReceipt = {
      version: receipt.version,
      generation_id: receipt.generation_id,
      artifact_id: receipt.artifact_id,
      sha256: receipt.sha256,
      bytes: receipt.bytes,
      received_at: receipt.received_at,
      buyer_peer_id: receipt.buyer_peer_id,
    };
    const valid = receipt.version === 1
      && receipt.generation_id === generationId
      && receipt.artifact_id === artifactId
      && receipt.sha256 === artifact.sha256
      && receipt.bytes === artifact.bytes
      && receipt.buyer_peer_id.toLowerCase() === buyerPeerId.toLowerCase()
      && Number.isSafeInteger(receipt.received_at)
      && receipt.received_at >= Math.floor((generation.completedAt ?? generation.createdAt) / 1000)
      && receipt.received_at <= Math.floor(Date.now() / 1000) + 300
      && verifyUtf8(buyerPeerId, JSON.stringify(unsignedReceipt), receipt.signature);
    if (!valid) return errorResponse(request.requestId, 422, 'invalid_receipt', 'Delivery receipt signature or artifact details are invalid');
    if (generation.deliveryStatus === 'earned') return this.generationResponse(request.requestId, generation);
    const amount = BigInt(generation.quote.delivery_amount);
    if (amount === 0n) {
      this.store.updateGeneration(generationId, { deliveryStatus: 'earned' }, 'delivery_earned');
      return this.generationResponse(request.requestId, this.store.getGeneration(generationId) ?? generation);
    }
    const payments = this.config.sellerPaymentManager;
    const channel = payments?.getChannelByPeer(buyerPeerId) ?? null;
    if (!payments || !channel || channel.sessionId !== generation.paymentChannelId) {
      return errorResponse(request.requestId, 409, 'payment_channel_unavailable', 'The original video payment channel is no longer active');
    }
    const target = payments.getCumulativeSpend(channel.sessionId) + amount;
    if (payments.getAcceptedCumulative(channel.sessionId) < target) {
      this.store.appendEvent(generationId, 'delivery_authorization_requested');
      this.store.savePendingMilestoneAuth(generationId, 'delivery', { receipt: unsignedReceipt, channelId: channel.sessionId, target: target.toString() });
      return this.paymentRequiredResponse(request.requestId, generation, {
        minBudgetPerRequest: amount.toString(),
        suggestedAmount: target.toString(),
        requiredCumulativeAmount: target.toString(),
        currentSpent: payments.getCumulativeSpend(channel.sessionId).toString(),
        currentAcceptedCumulative: payments.getAcceptedCumulative(channel.sessionId).toString(),
        channelId: channel.sessionId,
        reserveMaxAmount: payments.getReserveMax(channel.sessionId).toString(),
      });
    }
    payments.recordSpend(channel.sessionId, amount);
    this.store.promoteMilestoneAuth(generationId, 'delivery');
    this.store.updateGeneration(generationId, { deliveryStatus: 'earned' }, 'delivery_earned');
    return this.generationResponse(request.requestId, this.store.getGeneration(generationId) ?? generation);
  }

  private paymentRequiredResponse(
    requestId: string,
    generation: StoredVideoGeneration,
    requirements: Record<string, string>,
  ): SerializedHttpResponse {
    return jsonResponse(requestId, 402, {
      error: 'payment_required',
      ...requirements,
      generation_id: generation.id,
      video_quote: generation.quote,
    });
  }

  private async pollDueJobs(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (Date.now() - this.lastCleanupAt >= 60_000) {
        this.lastCleanupAt = Date.now();
        for (const path of this.store.listExpiredFiles(this.lastCleanupAt)) await rm(path, { force: true });
        this.store.deleteExpired(this.lastCleanupAt);
      }
      for (const generation of this.store.listRecoverable()) {
        const now = Date.now();
        if (!this.store.claimLease(generation.id, now, WORKER_LEASE_MS)) continue;
        await this.pollOne(generation).catch((error) => {
          const attempt = generation.pollAttempt + 1;
          this.store.updateGeneration(generation.id, {
            pollAttempt: attempt, nextPollAt: Date.now() + pollDelay(attempt), workerLeaseUntil: null,
            error: { code: 'poll_failed', message: errorMessage(error), retryable: true },
          }, 'poll_failed');
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollOne(generation: StoredVideoGeneration): Promise<void> {
    if (generation.expiresAt <= Date.now()) {
      this.store.discardPendingMilestoneAuth(generation.id, 'delivery');
      this.store.updateGeneration(generation.id, {
        status: 'expired', completedAt: Date.now(), nextPollAt: null, workerLeaseUntil: null,
        error: { code: 'generation_expired', message: 'Video generation expired before completion', retryable: false },
      }, 'expired');
      return;
    }
    const selected = this.adapters.get(generation.provider);
    if (!selected || !generation.upstreamJobId) {
      this.store.updateGeneration(generation.id, {
        status: 'reconciliation_required', workerLeaseUntil: null,
        error: { code: 'missing_upstream_job', message: 'Provider or upstream job ID is unavailable', retryable: false },
      }, 'reconciliation_required');
      return;
    }
    const status = await selected.adapter.getStatus(generation.upstreamJobId);
    if (status.status === 'succeeded' && status.artifacts?.length) {
      this.store.updateGeneration(generation.id, {
        status: 'fetching_artifact', nativeStatus: status.nativeStatus ?? null,
        progress: 100, workerLeaseUntil: null,
      }, 'fetching_artifact');
      try {
        await this.cacheArtifacts(generation, selected.adapter, status.artifacts);
      } catch (error) {
        this.store.updateGeneration(generation.id, {
          status: 'failed', completedAt: Date.now(), nextPollAt: null, workerLeaseUntil: null,
          error: { code: 'artifact_acquisition_failed', message: errorMessage(error), retryable: false },
        }, 'artifact_acquisition_failed');
        return;
      }
      this.store.updateGeneration(generation.id, {
        status: 'succeeded', completedAt: Date.now(), nextPollAt: null, workerLeaseUntil: null,
        error: null, progress: 100,
      }, 'succeeded');
      return;
    }
    if (isTerminal(status.status)) {
      this.store.updateGeneration(generation.id, {
        status: status.status, nativeStatus: status.nativeStatus ?? null,
        progress: status.progress ?? generation.progress, error: status.error ?? null,
        completedAt: Date.now(), nextPollAt: null, workerLeaseUntil: null,
      }, status.status);
      return;
    }
    const attempt = generation.pollAttempt + 1;
    this.store.updateGeneration(generation.id, {
      status: status.status, nativeStatus: status.nativeStatus ?? null, progress: status.progress ?? null,
      error: null, pollAttempt: attempt, nextPollAt: Date.now() + (status.retryAfterMs ?? pollDelay(attempt)),
      workerLeaseUntil: null,
    }, 'polled');
  }

  private async cacheArtifacts(
    generation: StoredVideoGeneration,
    adapter: VideoProviderAdapter,
    artifacts: ProviderVideoArtifact[],
  ): Promise<void> {
    for (const providerArtifact of artifacts) {
      if (this.store.totalArtifactBytes() >= this.maxStorageBytes) {
        throw new Error(`Video artifact storage quota of ${this.maxStorageBytes} bytes is exhausted`);
      }
      const id = `va_${randomUUID().replaceAll('-', '')}`;
      const finalPath = join(this.artifactDir, `${id}.mp4`);
      const tempPath = `${finalPath}.part`;
      const stream = await adapter.openArtifact(providerArtifact);
      const output = createWriteStream(tempPath, { flags: 'wx' });
      const hash = createHash('sha256');
      let bytes = 0;
      const storedBytes = this.store.totalArtifactBytes();
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          bytes += chunk.byteLength;
          if (bytes > this.maxArtifactBytes) {
            callback(new Error(`Artifact exceeds ${this.maxArtifactBytes} bytes`));
            return;
          }
          if (storedBytes + bytes > this.maxStorageBytes) {
            callback(new Error(`Video artifact storage quota of ${this.maxStorageBytes} bytes is exhausted`));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(stream), meter, output);
        await rename(tempPath, finalPath);
      } catch (error) {
        await rm(tempPath, { force: true });
        throw error;
      }
      const now = Date.now();
      const artifact: StoredVideoArtifact = {
        id, generationId: generation.id, providerArtifactId: providerArtifact.providerArtifactId ?? null,
        path: finalPath, type: 'video', mime_type: providerArtifact.mimeType ?? 'video/mp4', bytes,
        sha256: hash.digest('hex'),
        ...(providerArtifact.durationSeconds === undefined ? {} : { duration_seconds: providerArtifact.durationSeconds }),
        ...(providerArtifact.width === undefined ? {} : { width: providerArtifact.width }),
        ...(providerArtifact.height === undefined ? {} : { height: providerArtifact.height }),
        ...(providerArtifact.fps === undefined ? {} : { fps: providerArtifact.fps }),
        ...(providerArtifact.hasAudio === undefined ? {} : { has_audio: providerArtifact.hasAudio }),
        createdAt: now, expires_at: now + this.retentionMs,
        links: { content: `/v1/video/generations/${generation.id}/artifacts/${id}/content` },
      };
      this.store.addArtifact(artifact);
    }
  }

  private selectAdapter(model: string, providerOverride: string): { provider: Provider; adapter: VideoProviderAdapter } | null {
    const normalizedOverride = providerOverride.trim().toLowerCase();
    for (const selected of this.adapters.values()) {
      if (normalizedOverride && selected.provider.name.toLowerCase() !== normalizedOverride) continue;
      if (selected.adapter.supportedModels.includes(model) && selected.provider.services.includes(model)) return selected;
    }
    return null;
  }

  private quoteAmount(provider: Provider, model: string, request: VideoGenerationRequest): bigint {
    const billing = provider.serviceUnitBillingModels?.[model]?.['antseed-video-jobs-v1'];
    if (!billing) return 0n;
    let microUsdc = 0;
    const attributes: Record<string, string> = {
      model,
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.aspect_ratio ? { aspect_ratio: request.aspect_ratio } : {}),
      audio: String(request.generate_audio === true),
      output_format: request.output_format ?? 'mp4',
    };
    for (const component of billing.components) {
      if (component.match && Object.entries(component.match).some(([key, value]) => attributes[key] !== value)) continue;
      const units = component.unit === 'output_video_seconds' ? request.duration_seconds
        : component.unit === 'output_videos' ? 1 : 0;
      microUsdc += component.priceUsd * units * 1_000_000;
    }
    return BigInt(Math.max(0, Math.round(microUsdc)));
  }

  private ownedGeneration(id: string, buyerPeerId: string): StoredVideoGeneration | null {
    const generation = this.store.getGeneration(id);
    return generation?.buyerPeerId === buyerPeerId ? generation : null;
  }

  private generationResponse(requestId: string, generation: StoredVideoGeneration, statusCode = 200): SerializedHttpResponse {
    return jsonResponse(requestId, statusCode, this.toResource(generation), {
      location: `/v1/video/generations/${generation.id}`,
      'retry-after': isTerminal(generation.status) ? '0' : '3',
    });
  }

  private toResource(generation: StoredVideoGeneration): VideoGenerationResource {
    const artifacts = this.store.listArtifacts(generation.id).map(({
      path: _path,
      generationId: _generationId,
      providerArtifactId: _providerArtifactId,
      createdAt: _createdAt,
      expires_at,
      ...artifact
    }) => ({ ...artifact, expires_at: Math.floor(expires_at / 1000) }));
    return {
      id: generation.id, object: 'video.generation',
      created_at: Math.floor(generation.createdAt / 1000), updated_at: Math.floor(generation.updatedAt / 1000),
      model: generation.serviceId, status: publicStatus(generation.status), progress: generation.progress,
      artifacts, error: generation.error,
      payment: {
        currency: 'USDC', total_amount: generation.quote.total_amount, upfront_bps: generation.quote.upfront_bps,
        milestones: [
          { id: 'execution', trigger: 'submission_authorized', amount: generation.quote.upfront_amount, status: generation.executionStatus },
          { id: 'delivery', trigger: 'artifact_received', amount: generation.quote.delivery_amount, status: generation.deliveryStatus },
        ],
      },
      links: { self: `/v1/video/generations/${generation.id}`, cancel: `/v1/video/generations/${generation.id}/cancel` },
    };
  }
}

function jsonResponse(requestId: string, statusCode: number, value: unknown, extraHeaders: Record<string, string> = {}): SerializedHttpResponse {
  return { requestId, statusCode, headers: { ...JSON_HEADERS, ...extraHeaders }, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function errorResponse(requestId: string, statusCode: number, code: string, message: string, retryable = false): SerializedHttpResponse {
  return jsonResponse(requestId, statusCode, { error: { code, message, retryable } });
}

function parseJson(body: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getHeader(headers: Record<string, string>, name: string): string {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? '';
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function publicStatus(status: StoredVideoGeneration['status']): VideoGenerationStatus {
  if (status === 'submitting' || status === 'reconciliation_required') return 'queued';
  if (status === 'fetching_artifact' || status === 'cancel_requested') return 'in_progress';
  return status;
}

function isTerminal(status: StoredVideoGeneration['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'expired';
}

function pollDelay(attempt: number): number {
  const base = Math.min(30_000, 2_000 * (2 ** Math.min(attempt, 4)));
  return Math.floor(base * (0.85 + Math.random() * 0.3));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function parseRange(value: string, size: number): { start: number; end: number } | null | 'invalid' {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return 'invalid';
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return 'invalid';
  if (Number.isNaN(start)) {
    const suffix = end;
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return 'invalid';
    if (Number.isNaN(end)) end = size - 1;
    if (!Number.isSafeInteger(end) || end < start) return 'invalid';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function* fileChunks(path: string, start: number, end: number): AsyncIterable<Uint8Array> {
  const stream = createReadStream(path, { start, end, highWaterMark: 64 * 1024 });
  for await (const chunk of stream) yield new Uint8Array(chunk as Buffer);
}

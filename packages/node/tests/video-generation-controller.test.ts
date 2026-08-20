import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identityFromPrivateKeyHex, signUtf8 } from '../src/p2p/identity.js';
import { parseRange, VideoGenerationController } from '../src/video/video-generation-controller.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SellerPaymentManager } from '../src/payments/seller-payment-manager.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { VideoProviderAdapter } from '../src/interfaces/video-provider.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function request(path: string, method: string, body?: unknown): SerializedHttpRequest {
  return {
    requestId: crypto.randomUUID(), method, path,
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
    body: body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body)),
  };
}

function provider(adapter: VideoProviderAdapter): Provider {
  return {
    name: 'runway', services: ['gen4.5'], pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 2, videoAdapter: adapter,
    serviceUnitBillingModels: {
      'gen4.5': { 'antseed-video-jobs-v1': { version: 1, components: [{ unit: 'output_videos', priceUsd: 1 }] } },
    },
    async handleRequest() { throw new Error('not used'); },
    getCapacity: () => ({ current: 0, max: 2 }),
  };
}

function adapter(create = vi.fn().mockResolvedValue({ id: 'task-1', status: 'queued' })): VideoProviderAdapter {
  return {
    provider: 'runway', supportedModels: ['gen4.5'],
    getCapabilities: () => ({
      generationModes: ['text_to_video'], minDurationSeconds: 2, maxDurationSeconds: 10,
      resolutions: ['720p'], aspectRatios: ['16:9'], generateAudio: false, outputFormats: ['mp4'], upfrontBps: 5000,
    }),
    create, getStatus: vi.fn(), cancel: vi.fn(), openArtifact: vi.fn(),
  };
}

function paidManager(accepted: bigint): SellerPaymentManager {
  return {
    getChannelByPeer: () => ({ sessionId: 'channel-1' }),
    getCumulativeSpend: () => 0n,
    getAcceptedCumulative: () => accepted,
    getReserveMax: () => 5_000_000n,
    getPaymentRequirements: () => ({ suggestedAmount: '1000000' }),
    recordSpend: vi.fn(),
  } as unknown as SellerPaymentManager;
}

describe('VideoGenerationController', () => {
  it('always presents the signed paid quote before upstream submission', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-controller-'));
    tempDirs.push(dir);
    const create = vi.fn().mockResolvedValue({ id: 'task-1', status: 'queued' });
    const payments = paidManager(5_000_000n);
    const controller = new VideoGenerationController({
      identity: identityFromPrivateKeyHex('11'.repeat(32)), providers: [provider(adapter(create))], dataDir: dir,
      sellerPaymentManager: payments,
    });
    const body = { model: 'gen4.5', prompt: 'test', duration_seconds: 4, aspect_ratio: '16:9', resolution: '720p' };
    const first = await controller.handleRequest(request('/v1/video/generations', 'POST', body), 'a'.repeat(40));
    expect('statusCode' in first && first.statusCode).toBe(402);
    expect(create).not.toHaveBeenCalled();

    const second = await controller.handleRequest(request('/v1/video/generations', 'POST', body), 'a'.repeat(40));
    expect('statusCode' in second && second.statusCode).toBe(202);
    expect(create).toHaveBeenCalledTimes(1);
    expect(payments.recordSpend).toHaveBeenCalledWith('channel-1', 500_000n);
    controller.close();
  });

  it('cancels a quoted queued generation with no upstream call or charge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-controller-'));
    tempDirs.push(dir);
    const create = vi.fn();
    const payments = {
      getChannelByPeer: () => null,
      getPaymentRequirements: () => ({ suggestedAmount: '1000000' }),
      recordSpend: vi.fn(),
    } as unknown as SellerPaymentManager;
    const controller = new VideoGenerationController({
      identity: identityFromPrivateKeyHex('22'.repeat(32)), providers: [provider(adapter(create))], dataDir: dir,
      sellerPaymentManager: payments,
    });
    const body = { model: 'gen4.5', prompt: 'test', duration_seconds: 4, aspect_ratio: '16:9', resolution: '720p' };
    const quoted = await controller.handleRequest(request('/v1/video/generations', 'POST', body), 'a'.repeat(40));
    const payload = JSON.parse(new TextDecoder().decode('body' in quoted ? quoted.body : new Uint8Array())) as { generation_id: string };
    const canceled = await controller.handleRequest(request(`/v1/video/generations/${payload.generation_id}/cancel`, 'POST'), 'a'.repeat(40));
    expect('statusCode' in canceled && canceled.statusCode).toBe(200);
    expect(JSON.parse(new TextDecoder().decode('body' in canceled ? canceled.body : new Uint8Array()))).toMatchObject({ status: 'canceled' });
    expect(create).not.toHaveBeenCalled();
    expect(payments.recordSpend).not.toHaveBeenCalled();
    controller.close();
  });

  it('does not retain or charge execution authorization after an upstream rejection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-controller-'));
    tempDirs.push(dir);
    const rejection = Object.assign(new Error('Runway rejected the request'), { name: 'runway_http_400' });
    const payments = paidManager(5_000_000n);
    const controller = new VideoGenerationController({
      identity: identityFromPrivateKeyHex('33'.repeat(32)),
      providers: [provider(adapter(vi.fn().mockRejectedValue(rejection)))],
      dataDir: dir,
      sellerPaymentManager: payments,
    });
    const body = { model: 'gen4.5', prompt: 'test', duration_seconds: 4, aspect_ratio: '16:9', resolution: '720p' };
    await controller.handleRequest(request('/v1/video/generations', 'POST', body), 'a'.repeat(40));
    const rejected = await controller.handleRequest(request('/v1/video/generations', 'POST', body), 'a'.repeat(40));
    expect('statusCode' in rejected && rejected.statusCode).toBe(502);
    expect(payments.recordSpend).not.toHaveBeenCalled();
    expect((controller as any).store.diagnostics().pendingMilestoneAuthorizations).toBe(0);
    expect((controller as any).store.findByIdempotencyKey('a'.repeat(40), 'idem-1')).toMatchObject({
      status: 'failed', executionStatus: 'pending',
    });
    controller.close();
  });

  it('parses valid byte ranges and rejects malformed or unsatisfiable ranges', () => {
    expect(parseRange('', 100)).toBeNull();
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=10-999', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=20-10', 100)).toBe('invalid');
    expect(parseRange('bytes=1-2,4-5', 100)).toBe('invalid');
  });

  it('earns delivery exactly once after a valid receipt and final authorization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-controller-'));
    tempDirs.push(dir);
    const seller = identityFromPrivateKeyHex('55'.repeat(32));
    const buyer = identityFromPrivateKeyHex('66'.repeat(32));
    let spent = 500_000n;
    let accepted = 500_000n;
    const recordSpend = vi.fn((_channelId: string, amount: bigint) => { spent += amount; });
    const payments = {
      getChannelByPeer: () => ({ sessionId: 'channel-1' }),
      getCumulativeSpend: () => spent,
      getAcceptedCumulative: () => accepted,
      getReserveMax: () => 5_000_000n,
      recordSpend,
    } as unknown as SellerPaymentManager;
    const controller = new VideoGenerationController({
      identity: seller, providers: [provider(adapter())], dataDir: dir, sellerPaymentManager: payments,
    });
    const now = Date.now();
    (controller as any).store.createGeneration({
      id: 'vg_delivery', buyerPeerId: buyer.peerId, sellerPeerId: seller.peerId, provider: 'runway', serviceId: 'gen4.5',
      request: { model: 'gen4.5', prompt: 'test', duration_seconds: 4 }, requestHash: 'c'.repeat(64),
      idempotencyKey: 'delivery-idem', paymentChannelId: 'channel-1', upstreamJobId: 'task-1', status: 'succeeded',
      nativeStatus: 'SUCCEEDED', progress: 100,
      quote: {
        version: 1, quote_id: 'vq_delivery', request_hash: 'c'.repeat(64), seller_peer_id: seller.peerId,
        total_amount: '1000000', upfront_amount: '500000', delivery_amount: '500000', upfront_bps: 5000,
        expires_at: Math.floor((now + 300_000) / 1000), signature: 'quote-signature',
      },
      executionStatus: 'earned', deliveryStatus: 'pending', error: null, pollAttempt: 0, nextPollAt: null,
      workerLeaseUntil: null, cancelRequested: false, createdAt: now - 10_000, updatedAt: now,
      completedAt: now - 1_000, expiresAt: now + 86_400_000,
    });
    (controller as any).store.addArtifact({
      id: 'va_delivery', generationId: 'vg_delivery', providerArtifactId: 'provider-video', path: join(dir, 'video.mp4'),
      type: 'video', mime_type: 'video/mp4', bytes: 3, sha256: 'a'.repeat(64), createdAt: now,
      expires_at: now + 86_400_000, links: { content: '/v1/video/generations/vg_delivery/artifacts/va_delivery/content' },
    });
    const unsigned = {
      version: 1 as const, generation_id: 'vg_delivery', artifact_id: 'va_delivery', sha256: 'a'.repeat(64), bytes: 3,
      received_at: Math.floor(now / 1000), buyer_peer_id: buyer.peerId,
    };
    const receipt = { ...unsigned, signature: await signUtf8(buyer.wallet, JSON.stringify(unsigned)) };
    const receiptRequest = () => request('/v1/video/generations/vg_delivery/artifacts/va_delivery/receipt', 'POST', receipt);

    const awaitingFinalAuth = await controller.handleRequest(receiptRequest(), buyer.peerId);
    expect('statusCode' in awaitingFinalAuth && awaitingFinalAuth.statusCode).toBe(402);
    expect(recordSpend).not.toHaveBeenCalled();
    expect((controller as any).store.getGeneration('vg_delivery').deliveryStatus).toBe('pending');

    accepted = 1_000_000n;
    const delivered = await controller.handleRequest(receiptRequest(), buyer.peerId);
    expect('statusCode' in delivered && delivered.statusCode).toBe(200);
    expect(recordSpend).toHaveBeenCalledTimes(1);
    expect(recordSpend).toHaveBeenCalledWith('channel-1', 500_000n);
    expect((controller as any).store.getGeneration('vg_delivery').deliveryStatus).toBe('earned');

    await controller.handleRequest(receiptRequest(), buyer.peerId);
    expect(recordSpend).toHaveBeenCalledTimes(1);

    const invalid = { ...receipt, signature: '00'.repeat(65) };
    const invalidResponse = await controller.handleRequest(
      request('/v1/video/generations/vg_delivery/artifacts/va_delivery/receipt', 'POST', invalid),
      buyer.peerId,
    );
    expect('statusCode' in invalidResponse && invalidResponse.statusCode).toBe(422);
    controller.close();
  });
});

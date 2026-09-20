import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { parseRange, VideoGenerationController } from '../src/video/video-generation-controller.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SellerPaymentManager } from '../src/payments/seller-payment-manager.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { VideoProviderAdapter } from '../src/interfaces/video-provider.js';
import type { VideoJobStore } from '../src/video/video-job-store.js';

const tempDirs: string[] = [];
const controllers: VideoGenerationController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.close();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function singleChargeFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-video-charge-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'video', 'artifacts'), { recursive: true });
  let accepted = 0n;
  let spent = 0n;
  const upstream = adapter();
  const payments = paidManager(0n);
  payments.getAcceptedCumulative = () => accepted;
  payments.getCumulativeSpend = () => spent;
  payments.recordSpend = vi.fn((_channelId: string, amount: bigint) => { spent += amount; });
  const controller = new VideoGenerationController({
    identity: identityFromPrivateKeyHex('77'.repeat(32)), providers: [provider(upstream)], dataDir: dir,
    sellerPaymentManager: payments,
  });
  controllers.push(controller);
  const internal = controller as unknown as { store: VideoJobStore; pollDueJobs(): Promise<void> };
  const buyer = 'a'.repeat(40);
  const send = (path: string, method: string, body?: unknown) => controller.handleRequest(request(path, method, body), buyer);
  const submit = (key = 'idem-1') => {
    const req = request('/v1/video/generations', 'POST', { model: 'gen4.5', prompt: 'test', duration_seconds: 4 });
    req.headers['idempotency-key'] = key;
    return controller.handleRequest(req, buyer);
  };
  return { controller, internal, upstream, payments, submit, send, authorize: (amount: bigint) => { accepted = amount; } };
}

describe('single-charge video billing', () => {
  it('requires full authorization and charges exactly once at acceptance', async () => {
    const fixture = await singleChargeFixture();
    const quote = await fixture.submit();
    expect(quote).toMatchObject({ statusCode: 402 });
    const quoteBody = JSON.parse(new TextDecoder().decode('body' in quote ? quote.body : new Uint8Array()));
    expect(quoteBody).toMatchObject({ minBudgetPerRequest: '1000000', video_quote: { total_amount: '1000000', payment_trigger: 'upstream_accepted' } });
    expect(quoteBody.video_quote).not.toHaveProperty('delivery_amount');
    fixture.authorize(500_000n);
    expect(await fixture.submit()).toMatchObject({ statusCode: 402 });
    expect(fixture.upstream.create).not.toHaveBeenCalled();
    fixture.authorize(1_000_000n);
    expect(await fixture.submit()).toMatchObject({ statusCode: 202 });
    expect(fixture.payments.recordSpend).toHaveBeenCalledWith('channel-1', 1_000_000n);
    await fixture.submit();
    expect(fixture.upstream.create).toHaveBeenCalledTimes(1);
    expect(fixture.payments.recordSpend).toHaveBeenCalledTimes(1);
  });

  it('polls an accepted queued job and delivers verified bytes without a second charge', async () => {
    const fixture = await singleChargeFixture();
    await fixture.submit();
    fixture.authorize(1_000_000n);
    await fixture.submit();
    const generation = fixture.internal.store.findByIdempotencyKey('a'.repeat(40), 'idem-1')!;
    const bytes = new TextEncoder().encode('video-content');
    fixture.upstream.getStatus = vi.fn().mockResolvedValue({ id: 'task-1', status: 'succeeded', artifacts: [{ locator: 'private-provider-url' }] });
    fixture.upstream.openArtifact = vi.fn().mockResolvedValue(new Response(bytes).body);
    fixture.internal.store.updateGeneration(generation.id, { nextPollAt: 0 });
    await fixture.internal.pollDueJobs();
    expect(fixture.upstream.getStatus).toHaveBeenCalledWith('task-1');
    const status = await fixture.send(`/v1/video/generations/${generation.id}`, 'GET');
    const resource = JSON.parse(new TextDecoder().decode('body' in status ? status.body : new Uint8Array()));
    expect(resource).toMatchObject({ status: 'succeeded', payment: { total_amount: '1000000', trigger: 'upstream_accepted', status: 'earned' } });
    expect(resource.payment).not.toHaveProperty('milestones');
    const artifact = resource.artifacts[0];
    expect(await fixture.send(artifact.links.content, 'HEAD')).toMatchObject({ statusCode: 200 });
    const download = await fixture.send(artifact.links.content, 'GET');
    expect('chunks' in download).toBe(true);
    if ('chunks' in download) {
      const chunks = [];
      for await (const chunk of download.chunks) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    }
    expect(await fixture.send(`/v1/video/generations/${generation.id}/artifacts/${artifact.id}/receipt`, 'POST', {})).toMatchObject({ statusCode: 404 });
    expect(fixture.payments.recordSpend).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'canceled'] as const)('keeps the execution charge when an accepted job is later %s', async (status) => {
    const fixture = await singleChargeFixture();
    await fixture.submit();
    fixture.authorize(1_000_000n);
    await fixture.submit();
    const generation = fixture.internal.store.findByIdempotencyKey('a'.repeat(40), 'idem-1')!;
    fixture.upstream.getStatus = vi.fn().mockResolvedValue({ id: 'task-1', status });
    fixture.internal.store.updateGeneration(generation.id, { nextPollAt: 0 });
    await fixture.internal.pollDueJobs();
    expect(fixture.internal.store.getGeneration(generation.id)).toMatchObject({ status, executionStatus: 'earned' });
    expect(fixture.payments.recordSpend).toHaveBeenCalledTimes(1);
  });

  it('reserves authorization for pending submissions rather than reusing it concurrently', async () => {
    const fixture = await singleChargeFixture();
    let complete!: (job: { id: string; status: 'queued' }) => void;
    fixture.upstream.create = vi.fn(() => new Promise<{ id: string; status: 'queued' }>((resolve) => { complete = resolve; }));
    await fixture.submit('one');
    await fixture.submit('two');
    fixture.authorize(1_000_000n);
    const first = fixture.submit('one');
    try {
      expect(await fixture.submit('two')).toMatchObject({ statusCode: 402 });
      expect(fixture.upstream.create).toHaveBeenCalledTimes(1);
      expect(fixture.payments.recordSpend).not.toHaveBeenCalled();
    } finally {
      complete({ id: 'task-1', status: 'queued' });
      await first;
    }
    expect(fixture.payments.recordSpend).toHaveBeenCalledTimes(1);
  });

  it('never resubmits an uncertain upstream acceptance or marks it earned', async () => {
    const fixture = await singleChargeFixture();
    fixture.upstream.create = vi.fn().mockRejectedValue(new Error('Connection lost'));
    await fixture.submit();
    fixture.authorize(1_000_000n);
    expect(await fixture.submit()).toMatchObject({ statusCode: 502 });
    await fixture.submit();
    expect(fixture.upstream.create).toHaveBeenCalledTimes(1);
    expect(fixture.payments.recordSpend).not.toHaveBeenCalled();
    expect(fixture.internal.store.pendingExecutionAmount('channel-1')).toBe(1_000_000n);
    expect(fixture.internal.store.findByIdempotencyKey('a'.repeat(40), 'idem-1')).toMatchObject({ status: 'reconciliation_required', executionStatus: 'authorized' });
  });
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
      resolutions: ['720p'], aspectRatios: ['16:9'], generateAudio: false, outputFormats: ['mp4'],
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
    expect(payments.recordSpend).toHaveBeenCalledWith('channel-1', 1_000_000n);
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
    expect((controller as any).store.diagnostics().pendingExecutionAuthorizations).toBe(0);
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

});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VideoJobStore, type StoredVideoGeneration } from '../src/video/video-job-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function generation(overrides: Partial<StoredVideoGeneration> = {}): StoredVideoGeneration {
  const now = Date.now();
  return {
    id: 'vg_test', buyerPeerId: 'a'.repeat(40), sellerPeerId: 'b'.repeat(40), provider: 'runway',
    serviceId: 'gen4.5', request: { model: 'gen4.5', prompt: 'test', duration_seconds: 4 },
    requestHash: 'c'.repeat(64), idempotencyKey: 'idem-1', paymentChannelId: null, upstreamJobId: null,
    status: 'queued', nativeStatus: null, progress: null,
    quote: {
      version: 1, quote_id: 'vq_test', request_hash: 'c'.repeat(64), seller_peer_id: 'b'.repeat(40),
      total_amount: '1000000', upfront_amount: '500000', delivery_amount: '500000', upfront_bps: 5000,
      expires_at: Math.floor((now + 300_000) / 1000), signature: 'sig',
    },
    executionStatus: 'pending', deliveryStatus: 'pending', error: null, pollAttempt: 0, nextPollAt: null,
    workerLeaseUntil: null, cancelRequested: false, createdAt: now, updatedAt: now, completedAt: null,
    expiresAt: now + 86_400_000,
    ...overrides,
  };
}

describe('VideoJobStore', () => {
  it('persists idempotency and restart state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-store-'));
    tempDirs.push(dir);
    const path = join(dir, 'jobs.db');
    const first = new VideoJobStore(path);
    first.createGeneration(generation());
    first.updateGeneration('vg_test', { upstreamJobId: 'task-1', status: 'in_progress', nextPollAt: 1 }, 'accepted');
    first.close();

    const reopened = new VideoJobStore(path);
    expect(reopened.findByIdempotencyKey('a'.repeat(40), 'idem-1')).toMatchObject({
      id: 'vg_test', upstreamJobId: 'task-1', status: 'in_progress',
    });
    expect(reopened.listRecoverable(Date.now())).toHaveLength(1);
    reopened.close();
  });

  it('recovers submissions but never polls unpaid queued quotes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-store-'));
    tempDirs.push(dir);
    const store = new VideoJobStore(join(dir, 'jobs.db'));
    store.createGeneration(generation());
    expect(store.listRecoverable(Date.now())).toEqual([]);
    expect(store.claimSubmission('vg_test')).toBe(true);
    expect(store.listRecoverable(Date.now())).toMatchObject([{ id: 'vg_test', status: 'submitting' }]);
    store.close();
  });

  it('cancels a queued intent atomically before submission', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-store-'));
    tempDirs.push(dir);
    const store = new VideoJobStore(join(dir, 'jobs.db'));
    store.createGeneration(generation());
    expect(store.cancelBeforeSubmission('vg_test')).toBe(true);
    expect(store.claimSubmission('vg_test')).toBe(false);
    expect(store.getGeneration('vg_test')).toMatchObject({ status: 'canceled', executionStatus: 'pending' });
    store.close();
  });

  it('reports reconciliation and pending payment evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-store-'));
    tempDirs.push(dir);
    const store = new VideoJobStore(join(dir, 'jobs.db'));
    store.createGeneration(generation({ status: 'reconciliation_required' }));
    store.savePendingMilestoneAuth('vg_test', 'execution', { target: '500000' });
    expect(store.diagnostics()).toMatchObject({
      statusCounts: { reconciliation_required: 1 },
      pendingMilestoneAuthorizations: 1,
    });
    expect(store.diagnostics().reconciliationRequired[0]?.id).toBe('vg_test');
    store.discardPendingMilestoneAuth('vg_test', 'execution');
    expect(store.diagnostics().pendingMilestoneAuthorizations).toBe(0);
    store.close();
  });
});

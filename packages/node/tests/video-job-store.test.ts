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
      total_amount: '1000000', payment_trigger: 'upstream_accepted',
      expires_at: Math.floor((now + 300_000) / 1000), signature: 'sig',
    },
    executionStatus: 'pending', error: null, pollAttempt: 0, nextPollAt: null,
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

  it('polls and counts accepted queued jobs without resubmitting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-store-'));
    tempDirs.push(dir);
    const store = new VideoJobStore(join(dir, 'jobs.db'));
    try {
      store.createGeneration(generation({ upstreamJobId: 'task-1', executionStatus: 'earned', nextPollAt: 1 }));
      expect(store.listRecoverable()).toHaveLength(1);
      expect(store.countActiveByProvider('runway')).toBe(1);
      expect(store.claimSubmission('vg_test')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('keeps pending execution commitments across restarts until earned or discarded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-store-'));
    tempDirs.push(dir);
    const path = join(dir, 'jobs.db');
    const first = new VideoJobStore(path);
    first.createGeneration(generation());
    first.savePendingExecutionAuth('vg_test', { channelId: 'channel-1', amount: 1_000_000n });
    first.close();
    const reopened = new VideoJobStore(path);
    try {
      expect(reopened.pendingExecutionAmount('channel-1')).toBe(1_000_000n);
      expect(reopened.pendingExecutionAmount('channel-2')).toBe(0n);
      reopened.promoteExecutionAuth('vg_test');
      expect(reopened.pendingExecutionAmount('channel-1')).toBe(0n);
    } finally {
      reopened.close();
    }
  });

  it('reports reconciliation and pending payment evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-video-store-'));
    tempDirs.push(dir);
    const store = new VideoJobStore(join(dir, 'jobs.db'));
    store.createGeneration(generation({ status: 'reconciliation_required' }));
    store.savePendingExecutionAuth('vg_test', { target: '500000' });
    expect(store.diagnostics()).toMatchObject({
      statusCounts: { reconciliation_required: 1 },
      pendingExecutionAuthorizations: 1,
    });
    expect(store.diagnostics().reconciliationRequired[0]?.id).toBe('vg_test');
    store.discardPendingExecutionAuth('vg_test');
    expect(store.diagnostics().pendingExecutionAuthorizations).toBe(0);
    store.close();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeteringStorage } from '../src/metering/storage.js';
import { SellerFreeTierLimiter } from '../src/payments/seller-free-tier-limiter.js';

const BUYER = '11'.repeat(20);
const OTHER_BUYER = '22'.repeat(20);
const tempDirs: string[] = [];

function persistentStorage(): MeteringStorage {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-free-tier-'));
  tempDirs.push(dir);
  return new MeteringStorage(join(dir, 'metering.db'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SellerFreeTierLimiter', () => {
  it('limits zero-priced requests across services by buyer address', () => {
    const storage = persistentStorage();
    const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 2, windowMs: 60_000 }, storage);

    expect(limiter.consume(BUYER, 'free-model-a', 1_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume(BUYER, 'free-model-b', 2_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume(BUYER, 'free-model-a', 3_000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 58_000,
      buyerAddress: `0x${BUYER}`,
    });
    expect(limiter.consume(OTHER_BUYER, 'free-model-a', 3_000).allowed).toBe(true);
    storage.close();
  });

  it('uses a sliding window and persists usage across seller restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antseed-free-tier-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'metering.db');
    const firstStorage = new MeteringStorage(dbPath);
    const first = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, windowMs: 10_000 }, firstStorage);
    expect(first.consume(BUYER, 'free-model', 5_000).allowed).toBe(true);
    firstStorage.close();

    const restartedStorage = new MeteringStorage(dbPath);
    const restarted = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, windowMs: 10_000 }, restartedStorage);
    expect(restarted.consume(BUYER, 'free-model', 14_999).allowed).toBe(false);
    expect(restarted.consume(BUYER, 'free-model', 15_001)).toMatchObject({ allowed: true, remaining: 0 });
    restartedStorage.close();
  });

  it('falls back to bounded in-memory accounting when metering is unavailable', () => {
    const limiter = new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, windowMs: 1_000 });
    expect(limiter.consume(BUYER, 'free-model', 1_000).allowed).toBe(true);
    expect(limiter.consume(BUYER, 'free-model', 1_500).allowed).toBe(false);
    expect(limiter.consume(BUYER, 'free-model', 2_001).allowed).toBe(true);
  });

  it('rejects invalid limits', () => {
    expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 0 })).toThrow(/maxRequestsPerAddress/);
    expect(() => new SellerFreeTierLimiter({ maxRequestsPerAddress: 1, windowMs: 999 })).toThrow(/windowMs/);
  });
});

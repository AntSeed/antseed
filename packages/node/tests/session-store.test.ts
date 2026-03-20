import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, type StoredSession, type StoredReceipt } from '../src/payments/session-store.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-store-test-'));
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = Date.now();
  return {
    sessionId: '0x' + 'aa'.repeat(32),
    peerId: 'peer-abc123',
    role: 'buyer',
    sellerEvmAddr: '0x' + 'bb'.repeat(20),
    buyerEvmAddr: '0x' + 'cc'.repeat(20),
    nonce: 1,
    authMax: '1000000',
    deadline: Math.floor(now / 1000) + 3600,
    previousSessionId: '0x' + '00'.repeat(32),
    previousConsumption: '0',
    tokensDelivered: '0',
    requestCount: 0,
    reservedAt: now,
    settledAt: null,
    settledAmount: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('SessionStore', () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new SessionStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_createAndRead: insert session, read back all fields', () => {
    const session = makeSession();
    store.upsertSession(session);

    const loaded = store.getSession(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(session.sessionId);
    expect(loaded!.peerId).toBe(session.peerId);
    expect(loaded!.role).toBe(session.role);
    expect(loaded!.sellerEvmAddr).toBe(session.sellerEvmAddr);
    expect(loaded!.buyerEvmAddr).toBe(session.buyerEvmAddr);
    expect(loaded!.nonce).toBe(session.nonce);
    expect(loaded!.authMax).toBe(session.authMax);
    expect(loaded!.deadline).toBe(session.deadline);
    expect(loaded!.previousSessionId).toBe(session.previousSessionId);
    expect(loaded!.previousConsumption).toBe(session.previousConsumption);
    expect(loaded!.tokensDelivered).toBe(session.tokensDelivered);
    expect(loaded!.requestCount).toBe(session.requestCount);
    expect(loaded!.status).toBe('active');
    expect(loaded!.settledAt).toBeNull();
    expect(loaded!.settledAmount).toBeNull();
  });

  it('test_updateStatus: update to settled, verify', () => {
    const session = makeSession();
    store.upsertSession(session);

    store.updateSessionStatus(session.sessionId, 'settled', '500000');

    const loaded = store.getSession(session.sessionId);
    expect(loaded!.status).toBe('settled');
    expect(loaded!.settledAmount).toBe('500000');
    expect(loaded!.settledAt).toBeTypeOf('number');
  });

  it('test_updateTokensDelivered: increment tokens, verify', () => {
    const session = makeSession();
    store.upsertSession(session);

    store.updateTokensDelivered(session.sessionId, '250000', 3);

    const loaded = store.getSession(session.sessionId);
    expect(loaded!.tokensDelivered).toBe('250000');
    expect(loaded!.requestCount).toBe(3);
  });

  it('test_getActiveByPeer: returns correct active session', () => {
    const s1 = makeSession({ sessionId: '0x' + '01'.repeat(32), status: 'settled', createdAt: Date.now() - 1000 });
    const s2 = makeSession({ sessionId: '0x' + '02'.repeat(32), status: 'active', createdAt: Date.now() });
    store.upsertSession(s1);
    store.upsertSession(s2);

    const active = store.getActiveSessionByPeer('peer-abc123', 'buyer');
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe(s2.sessionId);
  });

  it('test_getActiveByPeer: returns null when no active session', () => {
    const s1 = makeSession({ status: 'settled' });
    store.upsertSession(s1);

    const active = store.getActiveSessionByPeer('peer-abc123', 'buyer');
    expect(active).toBeNull();
  });

  it('test_getLatestByPeer: returns most recent (any status)', () => {
    const s1 = makeSession({ sessionId: '0x' + '01'.repeat(32), status: 'settled', createdAt: Date.now() - 2000 });
    const s2 = makeSession({ sessionId: '0x' + '02'.repeat(32), status: 'settled', createdAt: Date.now() - 1000 });
    const s3 = makeSession({ sessionId: '0x' + '03'.repeat(32), status: 'active', createdAt: Date.now() });
    store.upsertSession(s1);
    store.upsertSession(s2);
    store.upsertSession(s3);

    const latest = store.getLatestSession('peer-abc123', 'buyer');
    expect(latest).not.toBeNull();
    expect(latest!.sessionId).toBe(s3.sessionId);
  });

  it('test_getTimedOut: returns sessions past timeout', () => {
    const oldTime = Date.now() - 100_000; // 100 seconds ago
    const s1 = makeSession({
      sessionId: '0x' + '01'.repeat(32),
      updatedAt: oldTime,
      createdAt: oldTime,
    });
    const recentTime = Date.now();
    const s2 = makeSession({
      sessionId: '0x' + '02'.repeat(32),
      updatedAt: recentTime,
      createdAt: recentTime,
    });
    store.upsertSession(s1);
    store.upsertSession(s2);

    // 50 second timeout — s1 should be timed out, s2 should not
    const timedOut = store.getTimedOutSessions(50);
    expect(timedOut.length).toBe(1);
    expect(timedOut[0].sessionId).toBe(s1.sessionId);
  });

  it('test_receiptCRUD: insert and read receipts', () => {
    const session = makeSession();
    store.upsertSession(session);

    const receipt: Omit<StoredReceipt, 'id'> = {
      sessionId: session.sessionId,
      runningTotal: '100000',
      requestCount: 1,
      responseHash: 'dd'.repeat(32),
      sellerSig: 'ee'.repeat(64),
      buyerAckSig: null,
      createdAt: Date.now(),
    };
    store.insertReceipt(receipt);

    const receipt2: Omit<StoredReceipt, 'id'> = {
      sessionId: session.sessionId,
      runningTotal: '200000',
      requestCount: 2,
      responseHash: 'ff'.repeat(32),
      sellerSig: 'ab'.repeat(64),
      buyerAckSig: 'cd'.repeat(64),
      createdAt: Date.now() + 1,
    };
    store.insertReceipt(receipt2);

    const receipts = store.getReceipts(session.sessionId);
    expect(receipts.length).toBe(2);
    expect(receipts[0].runningTotal).toBe('100000');
    expect(receipts[0].requestCount).toBe(1);
    expect(receipts[0].buyerAckSig).toBeNull();
    expect(receipts[1].runningTotal).toBe('200000');
    expect(receipts[1].buyerAckSig).toBe('cd'.repeat(64));
  });

  it('test_persistence: close and reopen, data survives', () => {
    const session = makeSession();
    store.upsertSession(session);
    store.insertReceipt({
      sessionId: session.sessionId,
      runningTotal: '50000',
      requestCount: 1,
      responseHash: 'aa'.repeat(32),
      sellerSig: 'bb'.repeat(64),
      buyerAckSig: null,
      createdAt: Date.now(),
    });

    // Close and reopen
    store.close();
    const store2 = new SessionStore(tempDir);

    const loaded = store2.getSession(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.peerId).toBe(session.peerId);

    const receipts = store2.getReceipts(session.sessionId);
    expect(receipts.length).toBe(1);
    expect(receipts[0].runningTotal).toBe('50000');

    store2.close();
    // Prevent double-close in afterEach
    store = new SessionStore(tempDir);
  });
});

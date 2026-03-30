import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelStore, type StoredChannel, type StoredReceipt } from '../src/payments/channel-store.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'channel-store-test-'));
}

function makeChannel(overrides: Partial<StoredChannel> = {}): StoredChannel {
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

describe('ChannelStore', () => {
  let tempDir: string;
  let store: ChannelStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new ChannelStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_createAndRead: insert channel, read back all fields', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    const loaded = store.getChannel(channel.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(channel.sessionId);
    expect(loaded!.peerId).toBe(channel.peerId);
    expect(loaded!.role).toBe(channel.role);
    expect(loaded!.sellerEvmAddr).toBe(channel.sellerEvmAddr);
    expect(loaded!.buyerEvmAddr).toBe(channel.buyerEvmAddr);
    expect(loaded!.nonce).toBe(channel.nonce);
    expect(loaded!.authMax).toBe(channel.authMax);
    expect(loaded!.deadline).toBe(channel.deadline);
    expect(loaded!.previousSessionId).toBe(channel.previousSessionId);
    expect(loaded!.previousConsumption).toBe(channel.previousConsumption);
    expect(loaded!.tokensDelivered).toBe(channel.tokensDelivered);
    expect(loaded!.requestCount).toBe(channel.requestCount);
    expect(loaded!.status).toBe('active');
    expect(loaded!.settledAt).toBeNull();
    expect(loaded!.settledAmount).toBeNull();
  });

  it('test_updateStatus: update to settled, verify', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    store.updateChannelStatus(channel.sessionId, 'settled', '500000');

    const loaded = store.getChannel(channel.sessionId);
    expect(loaded!.status).toBe('settled');
    expect(loaded!.settledAmount).toBe('500000');
    expect(loaded!.settledAt).toBeTypeOf('number');
  });

  it('test_updateTokensDelivered: increment tokens, verify', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    store.updateTokensDelivered(channel.sessionId, '250000', 3);

    const loaded = store.getChannel(channel.sessionId);
    expect(loaded!.tokensDelivered).toBe('250000');
    expect(loaded!.requestCount).toBe(3);
  });

  it('test_getActiveByPeer: returns correct active channel', () => {
    const s1 = makeChannel({ sessionId: '0x' + '01'.repeat(32), status: 'settled', createdAt: Date.now() - 1000 });
    const s2 = makeChannel({ sessionId: '0x' + '02'.repeat(32), status: 'active', createdAt: Date.now() });
    store.upsertChannel(s1);
    store.upsertChannel(s2);

    const active = store.getActiveChannelByPeer('peer-abc123', 'buyer');
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe(s2.sessionId);
  });

  it('test_getActiveByPeer: returns null when no active channel', () => {
    const s1 = makeChannel({ status: 'settled' });
    store.upsertChannel(s1);

    const active = store.getActiveChannelByPeer('peer-abc123', 'buyer');
    expect(active).toBeNull();
  });

  it('test_getLatestByPeer: returns most recent (any status)', () => {
    const s1 = makeChannel({ sessionId: '0x' + '01'.repeat(32), status: 'settled', createdAt: Date.now() - 2000 });
    const s2 = makeChannel({ sessionId: '0x' + '02'.repeat(32), status: 'settled', createdAt: Date.now() - 1000 });
    const s3 = makeChannel({ sessionId: '0x' + '03'.repeat(32), status: 'active', createdAt: Date.now() });
    store.upsertChannel(s1);
    store.upsertChannel(s2);
    store.upsertChannel(s3);

    const latest = store.getLatestChannel('peer-abc123', 'buyer');
    expect(latest).not.toBeNull();
    expect(latest!.sessionId).toBe(s3.sessionId);
  });

  it('test_getTimedOut: returns channels past timeout', () => {
    const oldTime = Date.now() - 100_000; // 100 seconds ago
    const s1 = makeChannel({
      sessionId: '0x' + '01'.repeat(32),
      updatedAt: oldTime,
      createdAt: oldTime,
    });
    const recentTime = Date.now();
    const s2 = makeChannel({
      sessionId: '0x' + '02'.repeat(32),
      updatedAt: recentTime,
      createdAt: recentTime,
    });
    store.upsertChannel(s1);
    store.upsertChannel(s2);

    // 50 second timeout — s1 should be timed out, s2 should not
    const timedOut = store.getTimedOutChannels(50);
    expect(timedOut.length).toBe(1);
    expect(timedOut[0].sessionId).toBe(s1.sessionId);
  });

  it('test_receiptCRUD: insert and read receipts', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);

    const receipt: Omit<StoredReceipt, 'id'> = {
      sessionId: channel.sessionId,
      runningTotal: '100000',
      requestCount: 1,
      responseHash: 'dd'.repeat(32),
      sellerSig: 'ee'.repeat(64),
      buyerAckSig: null,
      createdAt: Date.now(),
    };
    store.insertReceipt(receipt);

    const receipt2: Omit<StoredReceipt, 'id'> = {
      sessionId: channel.sessionId,
      runningTotal: '200000',
      requestCount: 2,
      responseHash: 'ff'.repeat(32),
      sellerSig: 'ab'.repeat(64),
      buyerAckSig: 'cd'.repeat(64),
      createdAt: Date.now() + 1,
    };
    store.insertReceipt(receipt2);

    const receipts = store.getReceipts(channel.sessionId);
    expect(receipts.length).toBe(2);
    expect(receipts[0].runningTotal).toBe('100000');
    expect(receipts[0].requestCount).toBe(1);
    expect(receipts[0].buyerAckSig).toBeNull();
    expect(receipts[1].runningTotal).toBe('200000');
    expect(receipts[1].buyerAckSig).toBe('cd'.repeat(64));
  });

  it('test_persistence: close and reopen, data survives', () => {
    const channel = makeChannel();
    store.upsertChannel(channel);
    store.insertReceipt({
      sessionId: channel.sessionId,
      runningTotal: '50000',
      requestCount: 1,
      responseHash: 'aa'.repeat(32),
      sellerSig: 'bb'.repeat(64),
      buyerAckSig: null,
      createdAt: Date.now(),
    });

    // Close and reopen
    store.close();
    const store2 = new ChannelStore(tempDir);

    const loaded = store2.getChannel(channel.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.peerId).toBe(channel.peerId);

    const receipts = store2.getReceipts(channel.sessionId);
    expect(receipts.length).toBe(1);
    expect(receipts[0].runningTotal).toBe('50000');

    store2.close();
    // Prevent double-close in afterEach
    store = new ChannelStore(tempDir);
  });
});

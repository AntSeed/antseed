import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { Wallet } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { SessionStore } from '../src/payments/session-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex, hexToBytes } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import {
  buildReceiptMessage,
  signMessageEd25519,
} from '../src/payments/evm/signatures.js';

const ZERO_SESSION_ID = '0x' + '0'.repeat(64);

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));
  return { peerId, privateKey, publicKey };
}

function createMockPaymentMux(): PaymentMux & {
  sentSpendingAuths: unknown[];
  sentBuyerAcks: unknown[];
} {
  const mux = {
    sentSpendingAuths: [] as unknown[],
    sentBuyerAcks: [] as unknown[],
    sendSpendingAuth(payload: unknown) { mux.sentSpendingAuths.push(payload); },
    sendAuthAck() {},
    sendSellerReceipt() {},
    sendBuyerAck(payload: unknown) { mux.sentBuyerAcks.push(payload); },
    sendTopUpRequest() {},
    onSpendingAuth() {},
    onAuthAck() {},
    onSellerReceipt() {},
    onBuyerAck() {},
    onTopUpRequest() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & { sentSpendingAuths: unknown[]; sentBuyerAcks: unknown[] };
}

function makeConfig(dataDir: string): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    contractAddress: '0x' + 'dd'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityAddress: '0x' + 'ff'.repeat(20),
    chainId: 31337,
    defaultMaxAmountUsdc: 1_000_000n,
    defaultAuthDurationSecs: 3600,
    autoAck: true,
    dataDir,
  };
}

describe('BuyerPaymentManager', () => {
  let tempDir: string;
  let identity: Identity;
  let manager: BuyerPaymentManager;
  let store: SessionStore;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-pm-test-'));
    identity = await createTestIdentity();
    store = new SessionStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    // Mock the signer to avoid actual RPC calls
    const wallet = Wallet.createRandom();
    manager.setSigner(wallet);
    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_authorizeSpending_firstSession: previousConsumption=0, previousSessionId=zero', async () => {
    const sellerPeerId = 'seller-peer-001';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux);

    expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mux.sentSpendingAuths.length).toBe(1);

    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.previousConsumption).toBe('0');
    expect(sent.previousSessionId).toBe(ZERO_SESSION_ID);
    expect(sent.sessionId).toBe(sessionId);
    expect(sent.maxAmountUsdc).toBe('1000000');
  });

  it('test_authorizeSpending_withPriorSession: loads prior session, correct previousConsumption', async () => {
    const sellerPeerId = 'seller-peer-002';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    // Create first session
    const firstSessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux);

    // Simulate some token delivery on the first session by updating the store directly
    // Access the store through a new SessionStore since it's the same DB
    const store = new SessionStore(tempDir);
    store.updateTokensDelivered(firstSessionId, '500000', 5);
    store.updateSessionStatus(firstSessionId, 'settled', '500000');
    store.close();

    // Create second session — should reference first
    const secondSessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux);

    expect(mux.sentSpendingAuths.length).toBe(2);
    const sent = mux.sentSpendingAuths[1] as Record<string, unknown>;
    expect(sent.previousConsumption).toBe('500000');
    expect(sent.previousSessionId).toBe(firstSessionId);
    expect(sent.sessionId).toBe(secondSessionId);
  });

  it('test_handleAuthAck: session marked confirmed', async () => {
    const sellerPeerId = 'seller-peer-003';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux);
    expect(manager.isAuthorized(sellerPeerId)).toBe(false);

    manager.handleAuthAck(sellerPeerId, { sessionId, nonce: 1 });
    expect(manager.isAuthorized(sellerPeerId)).toBe(true);
  });

  it('test_handleSellerReceipt_updatesTokens: tokensDelivered updated', async () => {
    const sellerIdentity = await createTestIdentity();
    const sellerPeerId = sellerIdentity.peerId;
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux);

    // Build a valid seller receipt
    const sessionIdBytes = hexToBytes(sessionId.replace(/^0x/, ''));
    const responseHash = new Uint8Array(32).fill(0xaa);
    const receiptMsg = buildReceiptMessage(sessionIdBytes, 100000n, 1, responseHash);
    const sellerSig = await signMessageEd25519(sellerIdentity, receiptMsg);

    await manager.handleSellerReceipt(sellerPeerId, {
      sessionId,
      runningTotal: '100000',
      requestCount: 1,
      responseHash: bytesToHex(responseHash),
      sellerSig: bytesToHex(sellerSig),
    }, mux);

    // Verify tokens updated in store
    const store = new SessionStore(tempDir);
    const session = store.getSession(sessionId);
    expect(session!.tokensDelivered).toBe('100000');
    expect(session!.requestCount).toBe(1);
    store.close();
  });

  it('test_handleSellerReceipt_sendsAck: BuyerAck sent when autoAck=true', async () => {
    const sellerIdentity = await createTestIdentity();
    const sellerPeerId = sellerIdentity.peerId;
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux);

    const sessionIdBytes = hexToBytes(sessionId.replace(/^0x/, ''));
    const responseHash = new Uint8Array(32).fill(0xbb);
    const receiptMsg = buildReceiptMessage(sessionIdBytes, 50000n, 1, responseHash);
    const sellerSig = await signMessageEd25519(sellerIdentity, receiptMsg);

    await manager.handleSellerReceipt(sellerPeerId, {
      sessionId,
      runningTotal: '50000',
      requestCount: 1,
      responseHash: bytesToHex(responseHash),
      sellerSig: bytesToHex(sellerSig),
    }, mux);

    expect(mux.sentBuyerAcks.length).toBe(1);
    const ack = mux.sentBuyerAcks[0] as Record<string, unknown>;
    expect(ack.sessionId).toBe(sessionId);
    expect(ack.runningTotal).toBe('50000');
    expect(ack.requestCount).toBe(1);
    expect(ack.buyerSig).toBeTypeOf('string');
  });

  it('test_isAuthorized: returns true for confirmed session, false otherwise', async () => {
    const peerId1 = 'seller-peer-auth-1';
    const peerId2 = 'seller-peer-auth-2';
    const evmAddr = '0x' + 'ab'.repeat(20);

    expect(manager.isAuthorized(peerId1)).toBe(false);

    const sid = await manager.authorizeSpending(peerId1, evmAddr, mux);
    // Still not authorized until AuthAck
    expect(manager.isAuthorized(peerId1)).toBe(false);

    manager.handleAuthAck(peerId1, { sessionId: sid, nonce: 1 });
    expect(manager.isAuthorized(peerId1)).toBe(true);
    expect(manager.isAuthorized(peerId2)).toBe(false);
  });

  it('test_sessionPersistence: session survives store reconstruction', async () => {
    const sellerPeerId = 'seller-peer-persist';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux);
    store.close();

    // Reopen the store independently and check persistence
    const checkStore = new SessionStore(tempDir);
    const session = checkStore.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.peerId).toBe(sellerPeerId);
    expect(session!.role).toBe('buyer');
    expect(session!.authMax).toBe('1000000');
    expect(session!.previousSessionId).toBe(ZERO_SESSION_ID);
    checkStore.close();

    // Mark first session as settled with tokens delivered (required for proof chain)
    store = new SessionStore(tempDir);
    store.updateTokensDelivered(sessionId, '500', 1);
    store.updateSessionStatus(sessionId, 'settled', '500');

    // Re-create manager with same data dir, authorize again
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(Wallet.createRandom());
    const secondId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux);

    // Second session references the first (now settled)
    const sent = mux.sentSpendingAuths[mux.sentSpendingAuths.length - 1] as Record<string, unknown>;
    expect(sent.previousSessionId).toBe(sessionId);
  });
});

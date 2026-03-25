import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { Wallet } from 'ethers';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { SessionStore, type StoredSession } from '../src/payments/session-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { SpendingAuthPayload, BuyerAckPayload } from '../src/types/protocol.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { identityToEvmWallet, identityToEvmAddress } from '../src/payments/evm/keypair.js';
import { signSpendingAuth, makeSessionsDomain, buildAckMessage, signMessageEd25519 } from '../src/payments/evm/signatures.js';
import type { SpendingAuthMessage } from '../src/payments/evm/signatures.js';
import { hexToBytes } from '../src/utils/hex.js';

const ZERO_SESSION_ID = '0x' + '0'.repeat(64);
const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));
  return { peerId, privateKey, publicKey };
}

function createMockPaymentMux(): PaymentMux & {
  sentAuthAcks: unknown[];
  sentSellerReceipts: unknown[];
  sentTopUpRequests: unknown[];
} {
  const mux = {
    sentAuthAcks: [] as unknown[],
    sentSellerReceipts: [] as unknown[],
    sentTopUpRequests: [] as unknown[],
    sendSpendingAuth() {},
    sendAuthAck(payload: unknown) { mux.sentAuthAcks.push(payload); },
    sendSellerReceipt(payload: unknown) { mux.sentSellerReceipts.push(payload); },
    sendBuyerAck() {},
    sendTopUpRequest(payload: unknown) { mux.sentTopUpRequests.push(payload); },
    onSpendingAuth() {},
    onAuthAck() {},
    onSellerReceipt() {},
    onBuyerAck() {},
    onTopUpRequest() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & {
    sentAuthAcks: unknown[];
    sentSellerReceipts: unknown[];
    sentTopUpRequests: unknown[];
  };
}

/** Build a valid SpendingAuth payload signed by the buyer's EVM wallet. */
async function buildSpendingAuth(
  buyerIdentity: Identity,
  sellerIdentity: Identity,
  sessionId: string,
  opts: {
    maxAmount?: bigint;
    nonce?: number;
    previousConsumption?: bigint;
    previousSessionId?: string;
  } = {},
): Promise<SpendingAuthPayload> {
  const maxAmount = opts.maxAmount ?? 1_000_000n;
  const nonce = opts.nonce ?? 1;
  const previousConsumption = opts.previousConsumption ?? 0n;
  const previousSessionId = opts.previousSessionId ?? ZERO_SESSION_ID;
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const buyerWallet = identityToEvmWallet(buyerIdentity);
  const sellerEvmAddr = identityToEvmAddress(sellerIdentity);
  const buyerEvmAddr = buyerWallet.address;

  const domain = makeSessionsDomain(CHAIN_ID, CONTRACT_ADDR);
  const msg: SpendingAuthMessage = {
    seller: sellerEvmAddr,
    sessionId,
    maxAmount,
    nonce,
    deadline,
    previousConsumption,
    previousSessionId,
  };
  const buyerSig = await signSpendingAuth(buyerWallet, domain, msg);

  return {
    sessionId,
    maxAmountUsdc: maxAmount.toString(),
    nonce,
    deadline,
    buyerSig,
    buyerEvmAddr,
    previousConsumption: previousConsumption.toString(),
    previousSessionId,
  };
}

function makeSessionId(n: number): string {
  return '0x' + n.toString(16).padStart(2, '0').repeat(32);
}

describe('SellerPaymentManager', () => {
  let tempDir: string;
  let store: SessionStore;
  let sellerIdentity: Identity;
  let buyerIdentity: Identity;
  let manager: SellerPaymentManager;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-pm-test-'));
    store = new SessionStore(tempDir);
    sellerIdentity = await createTestIdentity();
    buyerIdentity = await createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      sessionsContractAddress: CONTRACT_ADDR,
      stakingContractAddress: '0x' + 'cc'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      chainId: CHAIN_ID,
      dataDir: tempDir,
      settleTimeoutSecs: 60,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    // Mock sessions client methods to avoid actual RPC calls
    vi.spyOn(manager.sessionsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager.sessionsClient, 'settle').mockResolvedValue('0xsettle-hash');
    vi.spyOn(manager.sessionsClient, 'settleTimeout').mockResolvedValue('0xtimeout-hash');
    vi.spyOn(manager.stakingClient, 'getSellerAccount').mockResolvedValue({
      stake: 100000000n,
      stakedAt: BigInt(Date.now()),
      tokenRate: 1n,
    });

    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_handleSpendingAuth_firstSign: calls reserve, sends AuthAck', async () => {
    const sessionId = makeSessionId(1);
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);

    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    // Verify reserve was called
    expect(manager.sessionsClient.reserve).toHaveBeenCalledOnce();

    // Verify AuthAck sent
    expect(mux.sentAuthAcks.length).toBe(1);
    const ack = mux.sentAuthAcks[0] as Record<string, unknown>;
    expect(ack.sessionId).toBe(sessionId);

    // Verify session stored
    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.role).toBe('seller');
    expect(session!.status).toBe('active');

    // Verify hasSession
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
  });

  it('test_handleSpendingAuth_settleThenReserve: prior session settled before new reserve', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);

    // First session
    const sessionId1 = makeSessionId(1);
    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId1);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload1, mux);

    // Simulate delivery on first session
    store.updateTokensDelivered(sessionId1, '500000', 5);

    // Second session referencing first
    const sessionId2 = makeSessionId(2);
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId2, {
      nonce: 2,
      previousConsumption: 500000n,
      previousSessionId: sessionId1,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload2, mux);

    // Verify settle was called for prior session
    expect(manager.sessionsClient.settle).toHaveBeenCalledOnce();
    // Verify reserve was called twice (once per session)
    expect(manager.sessionsClient.reserve).toHaveBeenCalledTimes(2);

    // Prior session should be settled
    const prior = store.getSession(sessionId1);
    expect(prior!.status).toBe('settled');

    // New session should be active
    const current = store.getSession(sessionId2);
    expect(current!.status).toBe('active');
  });

  it('test_sendReceipt: SellerReceipt sent with correct fields', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(3);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    const responseBody = new TextEncoder().encode('Hello, world!');
    await manager.sendReceipt(buyerIdentity.peerId, mux, responseBody, 100n);

    expect(mux.sentSellerReceipts.length).toBe(1);
    const receipt = mux.sentSellerReceipts[0] as Record<string, unknown>;
    expect(receipt.sessionId).toBe(sessionId);
    expect(receipt.runningTotal).toBe('100');
    expect(receipt.requestCount).toBe(1);
    expect(receipt.sellerSig).toBeTypeOf('string');
    expect(receipt.responseHash).toBeTypeOf('string');

    // Verify tokens updated in store
    const session = store.getSession(sessionId);
    expect(session!.tokensDelivered).toBe('100');
    expect(session!.requestCount).toBe(1);
  });

  it('test_sendReceipt_topUpRequest: TopUp sent when >80% consumed', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(4);
    // Small authMax so we can easily exceed 80%
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId, {
      maxAmount: 100n,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    // Send receipt for 90 tokens out of 100 max (90% > 80%)
    const responseBody = new TextEncoder().encode('response');
    await manager.sendReceipt(buyerIdentity.peerId, mux, responseBody, 90n);

    expect(mux.sentTopUpRequests.length).toBe(1);
    const topUp = mux.sentTopUpRequests[0] as Record<string, unknown>;
    expect(topUp.sessionId).toBe(sessionId);
    expect(topUp.currentUsed).toBe('90');
    expect(topUp.currentMax).toBe('100');
  });

  it('test_handleBuyerAck: receipt stored (no error)', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(5);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    // Send a receipt first
    const responseBody = new TextEncoder().encode('ack test');
    await manager.sendReceipt(buyerIdentity.peerId, mux, responseBody, 200n);

    // Build valid buyer ack
    const sessionIdBytes = hexToBytes(sessionId.replace(/^0x/, ''));
    const ackMsg = buildAckMessage(sessionIdBytes, 200n, 1);
    const buyerSig = await signMessageEd25519(buyerIdentity, ackMsg);

    const ackPayload: BuyerAckPayload = {
      sessionId,
      runningTotal: '200',
      requestCount: 1,
      buyerSig: bytesToHex(buyerSig),
    };

    // Should not throw
    await manager.handleBuyerAck(buyerIdentity.peerId, ackPayload);
  });

  it('test_onBuyerDisconnect: session persisted, not settled immediately', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(6);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);

    manager.onBuyerDisconnect(buyerIdentity.peerId);

    // hasSession should return false (removed from in-memory set)
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);

    // But session still persisted in store and still active
    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');

    // Settle was NOT called
    expect(manager.sessionsClient.settle).not.toHaveBeenCalled();
  });

  it('test_checkTimeouts: timed-out sessions detected', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(7);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    // Manually set updatedAt to be old enough to time out (config has 60s timeout)
    const oldTime = Date.now() - 120_000; // 2 minutes ago
    store.upsertSession({
      ...store.getSession(sessionId)!,
      updatedAt: oldTime,
    });

    await manager.checkTimeouts();

    expect(manager.sessionsClient.settleTimeout).toHaveBeenCalledOnce();
    const session = store.getSession(sessionId);
    expect(session!.status).toBe('timeout');
  });

  it('test_hasSession: returns true/false correctly', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);

    const sessionId = makeSessionId(8);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    expect(manager.hasSession('nonexistent-peer')).toBe(false);
  });

  // ── Payment negotiation (PaymentRequired) ───────────────────

  it('test_init: caches tokenRate and firstSignCap from escrow', async () => {
    vi.spyOn(manager.sessionsClient, 'getFirstSignCap').mockResolvedValue(1_000_000n);

    await manager.init();

    const req = manager.getPaymentRequirements('test-req-1');
    expect(req).not.toBeNull();
    expect(req!.tokenRate).toBe('1'); // from mocked getSellerAccount
    expect(req!.firstSignCap).toBe('1000000');
    expect(req!.suggestedAmount).toBe('100000'); // $0.10 first-sign suggested
    expect(req!.requestId).toBe('test-req-1');
    expect(req!.sellerEvmAddr).toBe(identityToEvmAddress(sellerIdentity));
  });

  it('test_getPaymentRequirements_beforeInit: returns null when on-chain data not cached', () => {
    // init() not called, so tokenRate and firstSignCap are null
    const req = manager.getPaymentRequirements('test-req-2');
    expect(req).toBeNull();
  });

  it('test_init_handles_rpc_failure: does not throw, getPaymentRequirements returns null', async () => {
    vi.spyOn(manager.stakingClient, 'getSellerAccount').mockRejectedValue(new Error('RPC unreachable'));
    vi.spyOn(manager.sessionsClient, 'getFirstSignCap').mockRejectedValue(new Error('RPC unreachable'));

    // Should not throw
    await manager.init();

    const req = manager.getPaymentRequirements('test-req-3');
    expect(req).toBeNull();
  });

  it('test_getPaymentRequirements_includes_requestId: correlates with the triggering request', async () => {
    vi.spyOn(manager.sessionsClient, 'getFirstSignCap').mockResolvedValue(2_000_000n);
    await manager.init();

    const req1 = manager.getPaymentRequirements('req-aaa');
    const req2 = manager.getPaymentRequirements('req-bbb');
    expect(req1!.requestId).toBe('req-aaa');
    expect(req2!.requestId).toBe('req-bbb');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { SessionStore } from '../src/payments/session-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { SpendingAuthPayload } from '../src/types/protocol.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { identityToEvmWallet, identityToEvmAddress } from '../src/payments/evm/keypair.js';
import { signSpendingAuth, makeSessionsDomain } from '../src/payments/evm/signatures.js';
import type { SpendingAuthMessage } from '../src/payments/evm/signatures.js';

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
  sentNeedAuths: unknown[];
} {
  const mux = {
    sentAuthAcks: [] as unknown[],
    sentNeedAuths: [] as unknown[],
    sendSpendingAuth() {},
    sendAuthAck(payload: unknown) { mux.sentAuthAcks.push(payload); },
    sendPaymentRequired() {},
    sendNeedAuth(payload: unknown) { mux.sentNeedAuths.push(payload); },
    onSpendingAuth() {},
    onAuthAck() {},
    onPaymentRequired() {},
    onNeedAuth() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & {
    sentAuthAcks: unknown[];
    sentNeedAuths: unknown[];
  };
}

/** Build a valid SpendingAuth payload signed by the buyer's EVM wallet. */
async function buildSpendingAuth(
  buyerIdentity: Identity,
  sellerIdentity: Identity,
  sessionId: string,
  opts: {
    cumulativeAmount?: bigint;
    cumulativeInputTokens?: bigint;
    cumulativeOutputTokens?: bigint;
    nonce?: number;
    deadline?: number;
  } = {},
): Promise<SpendingAuthPayload> {
  const cumulativeAmount = opts.cumulativeAmount ?? 1_000_000n;
  const cumulativeInputTokens = opts.cumulativeInputTokens ?? 0n;
  const cumulativeOutputTokens = opts.cumulativeOutputTokens ?? 0n;
  const nonce = opts.nonce ?? 1;
  const deadline = opts.deadline ?? Math.floor(Date.now() / 1000) + 3600;

  const buyerWallet = identityToEvmWallet(buyerIdentity);
  const sellerEvmAddr = identityToEvmAddress(sellerIdentity);
  const buyerEvmAddr = buyerWallet.address;

  const domain = makeSessionsDomain(CHAIN_ID, CONTRACT_ADDR);
  const msg: SpendingAuthMessage = {
    seller: sellerEvmAddr,
    sessionId,
    cumulativeAmount,
    cumulativeInputTokens,
    cumulativeOutputTokens,
    nonce,
    deadline,
  };
  const buyerSig = await signSpendingAuth(buyerWallet, domain, msg);

  return {
    sessionId,
    cumulativeAmount: cumulativeAmount.toString(),
    cumulativeInputTokens: cumulativeInputTokens.toString(),
    cumulativeOutputTokens: cumulativeOutputTokens.toString(),
    nonce,
    deadline,
    buyerSig,
    buyerEvmAddr,
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
      chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    // Mock sessions client methods to avoid actual RPC calls
    vi.spyOn(manager.sessionsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager.sessionsClient, 'settle').mockResolvedValue('0xsettle-hash');
    vi.spyOn(manager.sessionsClient, 'settleTimeout').mockResolvedValue('0xtimeout-hash');

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

  it('test_handleSpendingAuth_subsequent: validates monotonic increase', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(2);

    // First auth
    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId, {
      cumulativeAmount: 100_000n,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload1, mux);

    // Subsequent auth with higher cumulative
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId, {
      cumulativeAmount: 200_000n,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload2, mux);

    // Only the initial auth triggers AuthAck
    expect(mux.sentAuthAcks.length).toBe(1);

    // Accepted cumulative should be updated
    expect(manager.getAcceptedCumulative(sessionId)).toBe(200_000n);
  });

  it('test_recordSpend: tracks cumulative spend', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(3);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    manager.recordSpend(sessionId, 50_000n);
    expect(manager.getCumulativeSpend(sessionId)).toBe(50_000n);

    manager.recordSpend(sessionId, 30_000n);
    expect(manager.getCumulativeSpend(sessionId)).toBe(80_000n);
  });

  it('test_getSessionByPeer: returns active session', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(4);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    const session = manager.getSessionByPeer(buyerIdentity.peerId);
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe(sessionId);
  });

  it('test_onBuyerDisconnect: session persisted, not settled when settleOnDisconnect=false', async () => {
    // Create manager with settleOnDisconnect=false
    const config2: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      sessionsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
      settleOnDisconnect: false,
    };
    const manager2 = new SellerPaymentManager(sellerIdentity, config2, store);
    vi.spyOn(manager2.sessionsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager2.sessionsClient, 'settle').mockResolvedValue('0xsettle-hash');

    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(5);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager2.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    expect(manager2.hasSession(buyerIdentity.peerId)).toBe(true);

    manager2.onBuyerDisconnect(buyerIdentity.peerId);

    // hasSession should return false (removed from in-memory set)
    expect(manager2.hasSession(buyerIdentity.peerId)).toBe(false);

    // But session still persisted in store and still active
    const session = store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');

    // Settle was NOT called
    expect(manager2.sessionsClient.settle).not.toHaveBeenCalled();
  });

  it('test_checkTimeouts: timed-out sessions with cumulative > 0 are settled', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(6);
    // Build SpendingAuth with a deadline that's already 3 hours in the past
    // so deadline + CLOSE_GRACE_PERIOD (2h) = 1 hour ago → timeout eligible
    const oldDeadline = Math.floor(Date.now() / 1000) - (3 * 60 * 60);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId, {
      deadline: oldDeadline,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    await manager.checkTimeouts();

    // Session has cumulative > 0 (default 1_000_000), so settle is called
    expect(manager.sessionsClient.settle).toHaveBeenCalledOnce();
    const session = store.getSession(sessionId);
    expect(session!.status).toBe('settled');
  });

  it('test_hasSession: returns true/false correctly', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);

    const sessionId = makeSessionId(7);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    expect(manager.hasSession('nonexistent-peer')).toBe(false);
  });

  // ── Payment negotiation (PaymentRequired) ───────────────────

  it('test_getPaymentRequirements: returns payload without init', () => {
    const req = manager.getPaymentRequirements('test-req-1');
    expect(req).not.toBeNull();
    expect(req.suggestedAmount).toBe('100000'); // $0.10 default
    expect(req.requestId).toBe('test-req-1');
    expect(req.sellerEvmAddr).toBe(identityToEvmAddress(sellerIdentity));
    expect(req.minBudgetPerRequest).toBeDefined();
  });

  it('test_getPaymentRequirements_includes_requestId: correlates with the triggering request', () => {
    const req1 = manager.getPaymentRequirements('req-aaa');
    const req2 = manager.getPaymentRequirements('req-bbb');
    expect(req1.requestId).toBe('req-aaa');
    expect(req2.requestId).toBe('req-bbb');
  });

  it('test_validateAndAcceptAuth: accepts monotonic increase', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sessionId = makeSessionId(8);

    // Establish session
    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId, {
      cumulativeAmount: 100_000n,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload1, mux);

    // Validate and accept a higher auth
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, sessionId, {
      cumulativeAmount: 200_000n,
    });
    const accepted = await manager.validateAndAcceptAuth(buyerIdentity.peerId, payload2);
    expect(accepted).toBe(true);
    expect(manager.getAcceptedCumulative(sessionId)).toBe(200_000n);
  });
});

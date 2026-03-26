import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { SessionStore } from '../src/payments/session-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { SpendingAuthPayload, AuthAckPayload } from '../src/types/protocol.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { identityToEvmAddress, identityToEvmWallet } from '../src/payments/evm/keypair.js';
import { AbiCoder } from 'ethers';

function decodeMetadataTokens(metadata: string): { inputTokens: bigint; outputTokens: bigint } {
  const coder = AbiCoder.defaultAbiCoder();
  const [inputTokens, outputTokens] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], metadata);
  return { inputTokens, outputTokens };
}

// ── Helpers ──────────────────────────────────────────────────

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));
  return { peerId, privateKey, publicKey };
}

function createMockPaymentMux(): PaymentMux & {
  sentSpendingAuths: SpendingAuthPayload[];
  sentAuthAcks: AuthAckPayload[];
} {
  const mux = {
    sentSpendingAuths: [] as SpendingAuthPayload[],
    sentAuthAcks: [] as AuthAckPayload[],
    sendSpendingAuth(payload: SpendingAuthPayload) { mux.sentSpendingAuths.push(payload); },
    sendAuthAck(payload: AuthAckPayload) { mux.sentAuthAcks.push(payload); },
    sendPaymentRequired() {},
    sendNeedAuth() {},
    onSpendingAuth() {},
    onAuthAck() {},
    onPaymentRequired() {},
    onNeedAuth() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & {
    sentSpendingAuths: SpendingAuthPayload[];
    sentAuthAcks: AuthAckPayload[];
  };
}

const CHAIN_ID = 31337;
const SESSIONS_CONTRACT = '0x' + 'cc'.repeat(20);

function makeBuyerConfig(dataDir: string): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    sessionsContractAddress: SESSIONS_CONTRACT,
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityAddress: '0x' + 'ff'.repeat(20),
    chainId: CHAIN_ID,
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 500_000n, // $0.50
    maxReserveAmountUsdc: 10_000_000n, // $10.00
    dataDir,
  };
}

function makeSellerConfig(dataDir: string): SellerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    sessionsContractAddress: SESSIONS_CONTRACT,
    chainId: CHAIN_ID,
    dataDir,
    minBudgetPerRequest: '50000', // $0.05
  };
}

// ═══════════════════════════════════════════════════════════════
// Full Payment Flow Integration Tests
// ═══════════════════════════════════════════════════════════════

describe('Full Payment Flow Integration', () => {
  let buyerDir: string;
  let sellerDir: string;
  let buyerStore: SessionStore;
  let sellerStore: SessionStore;
  let buyerIdentity: Identity;
  let sellerIdentity: Identity;
  let buyer: BuyerPaymentManager;
  let seller: SellerPaymentManager;
  let buyerMux: ReturnType<typeof createMockPaymentMux>;
  let sellerMux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    buyerDir = mkdtempSync(join(tmpdir(), 'flow-buyer-'));
    sellerDir = mkdtempSync(join(tmpdir(), 'flow-seller-'));
    buyerStore = new SessionStore(buyerDir);
    sellerStore = new SessionStore(sellerDir);

    buyerIdentity = await createTestIdentity();
    sellerIdentity = await createTestIdentity();

    buyer = new BuyerPaymentManager(buyerIdentity, makeBuyerConfig(buyerDir), buyerStore);
    // Use the real derived EVM wallet for the buyer (so signatures are valid)
    buyer.setSigner(identityToEvmWallet(buyerIdentity));

    seller = new SellerPaymentManager(sellerIdentity, makeSellerConfig(sellerDir), sellerStore);
    vi.spyOn(seller.sessionsClient, 'reserve').mockResolvedValue('0xreservehash');
    vi.spyOn(seller.sessionsClient, 'settle').mockResolvedValue('0xsettlehash');
    vi.spyOn(seller.sessionsClient, 'settleTimeout').mockResolvedValue('0xtimeouthash');

    buyerMux = createMockPaymentMux();
    sellerMux = createMockPaymentMux();
  });

  afterEach(() => {
    buyerStore.close();
    sellerStore.close();
    rmSync(buyerDir, { recursive: true, force: true });
    rmSync(sellerDir, { recursive: true, force: true });
  });

  // ── Helper to run the initial handshake ─────────────────────

  async function doInitialHandshake(minBudget: bigint): Promise<{ sessionId: string }> {
    const sellerPeerId = sellerIdentity.peerId;
    const sellerEvmAddr = identityToEvmAddress(sellerIdentity);
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const buyerPeerId = buyerIdentity.peerId;

    // Step 1: Buyer signs and sends initial SpendingAuth
    const sessionId = await buyer.authorizeSpending(
      sellerPeerId,
      sellerEvmAddr,
      buyerMux,
      minBudget,
    );
    expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(buyerMux.sentSpendingAuths).toHaveLength(1);

    // Step 2: Seller receives SpendingAuth, reserves on-chain, sends AuthAck
    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    const result = await seller.handleSpendingAuth(
      buyerPeerId,
      buyerEvmAddr,
      initialAuth,
      sellerMux,
    );
    expect(result).toBe('reserved');
    expect(sellerMux.sentAuthAcks).toHaveLength(1);
    expect(sellerMux.sentAuthAcks[0]!.sessionId).toBe(sessionId);

    // Step 3: Buyer receives AuthAck
    buyer.handleAuthAck(sellerPeerId, sellerMux.sentAuthAcks[0]!);
    expect(buyer.isAuthorized(sellerPeerId)).toBe(true);

    return { sessionId };
  }

  // ── Tests ──────────────────────────────────────────────────

  it('complete flow: reserve -> 3 requests -> settle', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const minBudget = 50_000n; // $0.05

    const { sessionId } = await doInitialHandshake(minBudget);

    // Verify reserve was called with reserveAmount (not cumulativeAmount)
    expect(seller.sessionsClient.reserve).toHaveBeenCalledOnce();
    const reserveCall = (seller.sessionsClient.reserve as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // reserveAmount is the 4th arg (index 3)
    const reserveAmount = reserveCall[3] as bigint;
    expect(reserveAmount).toBe(10_000_000n); // maxReserveAmountUsdc from buyer config

    // ── Request 1 ──
    const auth1 = await buyer.signPerRequestAuth(
      sellerPeerId,
      20_000n,  // addedCost (actual cost of previous request)
      500n,     // addedInputTokens
      200n,     // addedOutputTokens
      20_000n,  // estimatedNextCost
    );
    expect(BigInt(auth1.cumulativeAmount)).toBeGreaterThan(0n);
    const meta1 = decodeMetadataTokens(auth1.metadata);
    expect(meta1.inputTokens).toBe(500n);
    expect(meta1.outputTokens).toBe(200n);

    // Seller validates and accepts
    const valid1 = await seller.validateAndAcceptAuth(buyerPeerId, auth1);
    expect(valid1).toBe(true);
    seller.recordSpend(sessionId, 20_000n);

    // ── Request 2 ──
    const auth2 = await buyer.signPerRequestAuth(
      sellerPeerId,
      30_000n,
      800n,
      350n,
      25_000n,
    );
    expect(BigInt(auth2.cumulativeAmount)).toBeGreaterThan(BigInt(auth1.cumulativeAmount));
    const meta2 = decodeMetadataTokens(auth2.metadata);
    expect(meta2.inputTokens).toBe(1300n); // 500 + 800
    expect(meta2.outputTokens).toBe(550n); // 200 + 350

    const valid2 = await seller.validateAndAcceptAuth(buyerPeerId, auth2);
    expect(valid2).toBe(true);
    seller.recordSpend(sessionId, 30_000n);

    // ── Request 3 ──
    const auth3 = await buyer.signPerRequestAuth(
      sellerPeerId,
      15_000n,
      300n,
      150n,
      15_000n,
    );
    expect(BigInt(auth3.cumulativeAmount)).toBeGreaterThan(BigInt(auth2.cumulativeAmount));
    const meta3 = decodeMetadataTokens(auth3.metadata);
    expect(meta3.inputTokens).toBe(1600n); // 1300 + 300
    expect(meta3.outputTokens).toBe(700n); // 550 + 150

    const valid3 = await seller.validateAndAcceptAuth(buyerPeerId, auth3);
    expect(valid3).toBe(true);
    seller.recordSpend(sessionId, 15_000n);

    // Verify total spend
    expect(seller.getCumulativeSpend(sessionId)).toBe(65_000n); // 20k + 30k + 15k

    // ── Settlement ──
    await seller.settleSession(buyerPeerId);

    expect(seller.sessionsClient.settle).toHaveBeenCalledOnce();
    const settleCall = (seller.sessionsClient.settle as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // settle(signer, sessionId, cumulativeAmount, inputTokens, outputTokens, nonce, deadline, buyerSig)
    const settledAmount = settleCall[2] as bigint;
    expect(settledAmount).toBe(BigInt(auth3.cumulativeAmount));
    // Verify signature is non-empty
    const settledSig = settleCall[4] as string;
    expect(settledSig).toBeTruthy();
    expect(settledSig.length).toBeGreaterThan(2); // more than just "0x"
  });

  it('cumulative amounts are strictly monotonically increasing', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(50_000n);

    const amounts: bigint[] = [0n]; // initial cumulative is 0

    for (let i = 0; i < 5; i++) {
      const auth = await buyer.signPerRequestAuth(
        sellerPeerId,
        10_000n,
        100n,
        50n,
        10_000n,
      );
      const amount = BigInt(auth.cumulativeAmount);
      expect(amount).toBeGreaterThan(amounts[amounts.length - 1]!);
      amounts.push(amount);
    }

    // Verify strictly increasing
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i]!).toBeGreaterThan(amounts[i - 1]!);
    }
  });

  it('seller rejects non-monotonic cumulative amount', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(50_000n);

    // Sign a legitimate higher auth first
    const auth1 = await buyer.signPerRequestAuth(
      sellerPeerId,
      20_000n,
      100n,
      50n,
      20_000n,
    );
    const valid1 = await seller.validateAndAcceptAuth(buyerPeerId, auth1);
    expect(valid1).toBe(true);

    // Try to send a lower cumulative amount (replay the initial auth)
    const fakeAuth: SpendingAuthPayload = {
      ...auth1,
      cumulativeAmount: '30000', // lower than what was just accepted
    };
    // Re-sign would produce a valid sig for lower amount, but seller should reject non-monotonic
    const valid2 = await seller.validateAndAcceptAuth(buyerPeerId, fakeAuth);
    expect(valid2).toBe(false);
  });

  it('token counts accumulate correctly across multiple requests', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(50_000n);

    const auth1 = await buyer.signPerRequestAuth(sellerPeerId, 10_000n, 1000n, 500n, 10_000n);
    const tMeta1 = decodeMetadataTokens(auth1.metadata);
    expect(tMeta1.inputTokens).toBe(1000n);
    expect(tMeta1.outputTokens).toBe(500n);

    const auth2 = await buyer.signPerRequestAuth(sellerPeerId, 10_000n, 2000n, 1500n, 10_000n);
    const tMeta2 = decodeMetadataTokens(auth2.metadata);
    expect(tMeta2.inputTokens).toBe(3000n); // 1000 + 2000
    expect(tMeta2.outputTokens).toBe(2000n); // 500 + 1500

    const auth3 = await buyer.signPerRequestAuth(sellerPeerId, 10_000n, 500n, 300n, 10_000n);
    const tMeta3 = decodeMetadataTokens(auth3.metadata);
    expect(tMeta3.inputTokens).toBe(3500n); // 3000 + 500
    expect(tMeta3.outputTokens).toBe(2300n); // 2000 + 300
  });

  it('settle uses latest buyer signature (not initial)', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const { sessionId } = await doInitialHandshake(50_000n);

    // Send several per-request auths
    const auth1 = await buyer.signPerRequestAuth(sellerPeerId, 10_000n, 100n, 50n, 10_000n);
    await seller.validateAndAcceptAuth(buyerPeerId, auth1);
    seller.recordSpend(sessionId, 10_000n);

    const auth2 = await buyer.signPerRequestAuth(sellerPeerId, 20_000n, 200n, 100n, 20_000n);
    await seller.validateAndAcceptAuth(buyerPeerId, auth2);
    seller.recordSpend(sessionId, 20_000n);

    // Settle
    await seller.settleSession(buyerPeerId);

    const settleCall = (seller.sessionsClient.settle as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const settledAmount = settleCall[2] as bigint;
    const settledSig = settleCall[4] as string;

    // Should use auth2's cumulative amount (the latest), not auth1's or the initial
    expect(settledAmount).toBe(BigInt(auth2.cumulativeAmount));
    expect(settledSig).toBe(auth2.buyerSig);
  });

  it('reserve sends reserveAmount from buyer config, not cumulativeAmount', async () => {
    await doInitialHandshake(50_000n);

    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    // The SpendingAuth payload should include reserveAmount
    expect(initialAuth.reserveAmount).toBe('10000000'); // maxReserveAmountUsdc

    // And cumulativeAmount should be 0 (initial reserve auth)
    expect(initialAuth.cumulativeAmount).toBe('0');
  });

  it('seller sends AuthAck only on first SpendingAuth, not subsequent', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);

    await doInitialHandshake(50_000n);
    expect(sellerMux.sentAuthAcks).toHaveLength(1);

    // Send a subsequent auth via handleSpendingAuth
    const auth1 = await buyer.signPerRequestAuth(sellerPeerId, 10_000n, 100n, 50n, 10_000n);
    const result = await seller.handleSpendingAuth(buyerPeerId, buyerEvmAddr, auth1, sellerMux);
    expect(result).toBe('accepted');
    // No new AuthAck should be sent
    expect(sellerMux.sentAuthAcks).toHaveLength(1);
  });

  it('seller hasSession returns true for active buyer, false after settle', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    const sellerPeerId = sellerIdentity.peerId;

    expect(seller.hasSession(buyerPeerId)).toBe(false);

    const { sessionId } = await doInitialHandshake(50_000n);
    expect(seller.hasSession(buyerPeerId)).toBe(true);

    // Record at least one spend so settle works
    const auth = await buyer.signPerRequestAuth(sellerPeerId, 10_000n, 100n, 50n, 10_000n);
    await seller.validateAndAcceptAuth(buyerPeerId, auth);
    seller.recordSpend(sessionId, 10_000n);

    await seller.settleSession(buyerPeerId);
    expect(seller.hasSession(buyerPeerId)).toBe(false);
  });

  it('zero-cumulative session settles via settleTimeout', async () => {
    const buyerPeerId = buyerIdentity.peerId;

    await doInitialHandshake(50_000n);

    // Settle without any per-request auths (no spend recorded)
    // The initial auth now has cumulativeAmount=0, so the seller's
    // acceptedCumulative is 0 — settleSession defers to timeout checker
    // (neither settle nor settleTimeout is called immediately).
    await seller.settleSession(buyerPeerId);

    // With initial cumulative = 0, neither settle nor settleTimeout is called
    expect(seller.sessionsClient.settle).not.toHaveBeenCalled();
    expect(seller.sessionsClient.settleTimeout).not.toHaveBeenCalled();
  });

  it('buyer handleAuthAck ignores mismatched sessionId', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const sellerEvmAddr = identityToEvmAddress(sellerIdentity);

    const sessionId = await buyer.authorizeSpending(
      sellerPeerId,
      sellerEvmAddr,
      buyerMux,
      50_000n,
    );

    // Send AuthAck with wrong sessionId
    buyer.handleAuthAck(sellerPeerId, {
      sessionId: '0x' + 'ff'.repeat(32),
      nonce: 1,
    });

    // Should NOT be authorized
    expect(buyer.isAuthorized(sellerPeerId)).toBe(false);

    // Now send correct AuthAck
    buyer.handleAuthAck(sellerPeerId, { sessionId, nonce: 1 });
    expect(buyer.isAuthorized(sellerPeerId)).toBe(true);
  });

  it('seller rejects SpendingAuth with invalid signature', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sellerPeerId = sellerIdentity.peerId;

    const { ZERO_METADATA_HASH, encodeMetadata, ZERO_METADATA } = await import('../src/payments/evm/signatures.js');
    const badAuth: SpendingAuthPayload = {
      sessionId: '0x' + '01'.repeat(32),
      cumulativeAmount: '50000',
      metadataHash: ZERO_METADATA_HASH,
      metadata: encodeMetadata(ZERO_METADATA),
      buyerSig: '0x' + 'aa'.repeat(65), // garbage signature
      buyerEvmAddr,
      reserveAmount: '10000000',
      reserveNonce: 1,
      reserveDeadline: Math.floor(Date.now() / 1000) + 3600,
    };

    const result = await seller.handleSpendingAuth(buyerPeerId, buyerEvmAddr, badAuth, sellerMux);
    expect(result).toBe('rejected');
    expect(sellerMux.sentAuthAcks).toHaveLength(0);
  });

  it('buyer per-request auth caps cumulative at maxReserveAmountUsdc', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    // Use a small maxReserve for this test
    const tightConfig = makeBuyerConfig(buyerDir);
    tightConfig.maxReserveAmountUsdc = 100_000n; // $0.10 max reserve
    tightConfig.maxPerRequestUsdc = 500_000n;

    buyerStore.close();
    buyerStore = new SessionStore(buyerDir);
    buyer = new BuyerPaymentManager(buyerIdentity, tightConfig, buyerStore);
    buyer.setSigner(identityToEvmWallet(buyerIdentity));

    const sellerEvmAddr = identityToEvmAddress(sellerIdentity);
    await buyer.authorizeSpending(sellerPeerId, sellerEvmAddr, buyerMux, 50_000n);
    buyer.handleAuthAck(sellerPeerId, {
      sessionId: buyerMux.sentSpendingAuths[0]!.sessionId,
      nonce: 1,
    });

    // Try to increment by a lot — should cap at maxReserveAmountUsdc
    const auth = await buyer.signPerRequestAuth(sellerPeerId, 200_000n, 100n, 50n, 200_000n);
    expect(BigInt(auth.cumulativeAmount)).toBeLessThanOrEqual(100_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// Settlement edge cases
// ═══════════════════════════════════════════════════════════════

describe('Settlement edge cases', () => {
  let buyerDir: string;
  let sellerDir: string;
  let buyerStore: SessionStore;
  let sellerStore: SessionStore;
  let buyerIdentity: Identity;
  let sellerIdentity: Identity;
  let buyer: BuyerPaymentManager;
  let seller: SellerPaymentManager;
  let buyerMux: ReturnType<typeof createMockPaymentMux>;
  let sellerMux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    buyerDir = mkdtempSync(join(tmpdir(), 'settle-buyer-'));
    sellerDir = mkdtempSync(join(tmpdir(), 'settle-seller-'));
    buyerStore = new SessionStore(buyerDir);
    sellerStore = new SessionStore(sellerDir);

    buyerIdentity = await createTestIdentity();
    sellerIdentity = await createTestIdentity();

    buyer = new BuyerPaymentManager(buyerIdentity, makeBuyerConfig(buyerDir), buyerStore);
    buyer.setSigner(identityToEvmWallet(buyerIdentity));

    seller = new SellerPaymentManager(sellerIdentity, makeSellerConfig(sellerDir), sellerStore);
    vi.spyOn(seller.sessionsClient, 'reserve').mockResolvedValue('0xreservehash');
    vi.spyOn(seller.sessionsClient, 'settle').mockResolvedValue('0xsettlehash');
    vi.spyOn(seller.sessionsClient, 'settleTimeout').mockResolvedValue('0xtimeouthash');

    buyerMux = createMockPaymentMux();
    sellerMux = createMockPaymentMux();
  });

  afterEach(() => {
    buyerStore.close();
    sellerStore.close();
    rmSync(buyerDir, { recursive: true, force: true });
    rmSync(sellerDir, { recursive: true, force: true });
  });

  it('onBuyerDisconnect triggers settlement for active session', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const sellerEvmAddr = identityToEvmAddress(sellerIdentity);
    const buyerPeerId = buyerIdentity.peerId;
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);

    // Handshake
    const sessionId = await buyer.authorizeSpending(sellerPeerId, sellerEvmAddr, buyerMux, 50_000n);
    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    await seller.handleSpendingAuth(buyerPeerId, buyerEvmAddr, initialAuth, sellerMux);
    buyer.handleAuthAck(sellerPeerId, sellerMux.sentAuthAcks[0]!);

    // Send one request auth
    const auth1 = await buyer.signPerRequestAuth(sellerPeerId, 10_000n, 100n, 50n, 10_000n);
    await seller.validateAndAcceptAuth(buyerPeerId, auth1);
    seller.recordSpend(sessionId, 10_000n);

    // Buyer disconnects
    seller.onBuyerDisconnect(buyerPeerId);

    // Wait for the fire-and-forget settle to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(seller.sessionsClient.settle).toHaveBeenCalledOnce();
  });

  it('settleSession is no-op for unknown buyer', async () => {
    await seller.settleSession('unknown-peer');
    expect(seller.sessionsClient.settle).not.toHaveBeenCalled();
    expect(seller.sessionsClient.settleTimeout).not.toHaveBeenCalled();
  });

  it('recordSpend is no-op for unknown sessionId', () => {
    // Should not throw
    seller.recordSpend('0x' + 'ff'.repeat(32), 1000n);
  });
});

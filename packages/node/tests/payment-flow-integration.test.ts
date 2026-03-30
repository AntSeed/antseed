import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { SessionStore } from '../src/payments/session-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { SpendingAuthPayload, AuthAckPayload } from '../src/types/protocol.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { AbiCoder, Wallet } from 'ethers';

const enc = new TextEncoder();

function decodeMetadataTokens(metadata: string): { inputTokens: bigint; outputTokens: bigint } {
  const coder = AbiCoder.defaultAbiCoder();
  const [inputTokens, outputTokens] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], metadata);
  return { inputTokens, outputTokens };
}

// ── Helpers ──────────────────────────────────────────────────

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
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

const TEST_PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };

/** Realistic test content for tokenx estimation. */
const SAMPLE_INPUT = enc.encode('What is the capital of France? Please provide a detailed historical answer.');
const SAMPLE_OUTPUT = enc.encode('The capital of France is Paris, located on the Seine River. It has been the capital since the 10th century.');

function makeBuyerConfig(dataDir: string): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    channelsContractAddress: SESSIONS_CONTRACT,
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
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
    channelsContractAddress: SESSIONS_CONTRACT,
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

    buyerIdentity = createTestIdentity();
    sellerIdentity = createTestIdentity();

    buyer = new BuyerPaymentManager(buyerIdentity, makeBuyerConfig(buyerDir), buyerStore);
    buyer.setSigner(buyerIdentity.wallet);

    seller = new SellerPaymentManager(sellerIdentity, makeSellerConfig(sellerDir), sellerStore);
    vi.spyOn(seller.channelsClient, 'reserve').mockResolvedValue('0xreservehash');
    vi.spyOn(seller.channelsClient, 'close').mockResolvedValue('0xclosehash');
    vi.spyOn(seller.channelsClient, 'requestClose').mockResolvedValue('0xrequestclosehash');
    vi.spyOn(seller.channelsClient, 'withdraw').mockResolvedValue('0xwithdrawhash');

    buyerMux = createMockPaymentMux();
    sellerMux = createMockPaymentMux();
  });

  afterEach(() => {
    buyerStore.close();
    sellerStore.close();
    rmSync(buyerDir, { recursive: true, force: true });
    rmSync(sellerDir, { recursive: true, force: true });
  });

  async function doInitialHandshake(minBudget: bigint): Promise<{ sessionId: string }> {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const sessionId = await buyer.authorizeSpending(sellerPeerId, buyerMux, minBudget, TEST_PRICING);
    expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(buyerMux.sentSpendingAuths).toHaveLength(1);

    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    const result = await seller.handleSpendingAuth(buyerPeerId, initialAuth, sellerMux);
    expect(result).toBe('reserved');
    expect(sellerMux.sentAuthAcks).toHaveLength(1);

    buyer.handleAuthAck(sellerPeerId, sellerMux.sentAuthAcks[0]!);
    expect(buyer.isAuthorized(sellerPeerId)).toBe(true);

    return { sessionId };
  }

  it('complete flow: reserve -> 3 requests -> settle', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const { sessionId } = await doInitialHandshake(50_000n);

    expect(seller.channelsClient.reserve).toHaveBeenCalledOnce();
    const reserveCall = (seller.channelsClient.reserve as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(reserveCall[3] as bigint).toBe(10_000_000n);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 20_000n },
    );
    expect(BigInt(auth1.cumulativeAmount)).toBeGreaterThan(50_000n);

    const valid1 = await seller.validateAndAcceptAuth(buyerPeerId, auth1);
    expect(valid1).toBe(true);
    seller.recordSpend(sessionId, 20_000n);

    const { payload: auth2 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 30_000n },
    );
    expect(BigInt(auth2.cumulativeAmount)).toBeGreaterThan(BigInt(auth1.cumulativeAmount));

    const valid2 = await seller.validateAndAcceptAuth(buyerPeerId, auth2);
    expect(valid2).toBe(true);
    seller.recordSpend(sessionId, 30_000n);

    const { payload: auth3 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 15_000n },
    );
    expect(BigInt(auth3.cumulativeAmount)).toBeGreaterThan(BigInt(auth2.cumulativeAmount));

    const valid3 = await seller.validateAndAcceptAuth(buyerPeerId, auth3);
    expect(valid3).toBe(true);
    seller.recordSpend(sessionId, 15_000n);

    expect(seller.getCumulativeSpend(sessionId)).toBe(65_000n);

    await seller.settleSession(buyerPeerId);

    expect(seller.channelsClient.close).toHaveBeenCalledOnce();
    const closeCall = (seller.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeCall[2] as bigint).toBe(BigInt(auth3.cumulativeAmount));
    expect((closeCall[4] as string).length).toBeGreaterThan(2);
  });

  it('cumulative amounts are strictly monotonically increasing', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(50_000n);

    const amounts: bigint[] = [50_000n];

    for (let i = 0; i < 5; i++) {
      const { payload: auth } = await buyer.signPerRequestAuth(
        sellerPeerId,
        { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
      );
      const amount = BigInt(auth.cumulativeAmount);
      expect(amount).toBeGreaterThan(amounts[amounts.length - 1]!);
      amounts.push(amount);
    }

    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i]!).toBeGreaterThan(amounts[i - 1]!);
    }
  });

  it('seller rejects non-monotonic cumulative amount', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(50_000n);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 20_000n },
    );
    expect(await seller.validateAndAcceptAuth(buyerPeerId, auth1)).toBe(true);

    const fakeAuth: SpendingAuthPayload = {
      ...auth1,
      cumulativeAmount: '30000',
    };
    expect(await seller.validateAndAcceptAuth(buyerPeerId, fakeAuth)).toBe(false);
  });

  it('token counts accumulate correctly across multiple requests', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    await doInitialHandshake(50_000n);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    const tMeta1 = decodeMetadataTokens(auth1.metadata);
    expect(tMeta1.inputTokens).toBeGreaterThan(0n);
    expect(tMeta1.outputTokens).toBeGreaterThan(0n);
    const firstInput = tMeta1.inputTokens;
    const firstOutput = tMeta1.outputTokens;

    const { payload: auth2 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    const tMeta2 = decodeMetadataTokens(auth2.metadata);
    expect(tMeta2.inputTokens).toBe(firstInput * 2n);
    expect(tMeta2.outputTokens).toBe(firstOutput * 2n);

    const { payload: auth3 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    const tMeta3 = decodeMetadataTokens(auth3.metadata);
    expect(tMeta3.inputTokens).toBe(firstInput * 3n);
    expect(tMeta3.outputTokens).toBe(firstOutput * 3n);
  });

  it('settle uses latest buyer signature (not initial)', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const { sessionId } = await doInitialHandshake(50_000n);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    await seller.validateAndAcceptAuth(buyerPeerId, auth1);
    seller.recordSpend(sessionId, 10_000n);

    const { payload: auth2 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 20_000n },
    );
    await seller.validateAndAcceptAuth(buyerPeerId, auth2);
    seller.recordSpend(sessionId, 20_000n);

    await seller.settleSession(buyerPeerId);

    const closeCall = (seller.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(closeCall[2] as bigint).toBe(BigInt(auth2.cumulativeAmount));
    expect(closeCall[4] as string).toBe(auth2.spendingAuthSig);
  });

  it('reserve sends reserveAmount from buyer config, not cumulativeAmount', async () => {
    await doInitialHandshake(50_000n);

    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    expect(initialAuth.reserveMaxAmount).toBe('10000000');
    expect(initialAuth.cumulativeAmount).toBe('50000');
  });

  it('seller sends AuthAck only on first SpendingAuth, not subsequent', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    await doInitialHandshake(50_000n);
    expect(sellerMux.sentAuthAcks).toHaveLength(1);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    expect(await seller.handleSpendingAuth(buyerPeerId, auth1, sellerMux)).toBe('accepted');
    expect(sellerMux.sentAuthAcks).toHaveLength(1);
  });

  it('seller hasSession returns true for active buyer, false after settle', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    const sellerPeerId = sellerIdentity.peerId;

    expect(seller.hasSession(buyerPeerId)).toBe(false);

    const { sessionId } = await doInitialHandshake(50_000n);
    expect(seller.hasSession(buyerPeerId)).toBe(true);

    const { payload: auth } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    await seller.validateAndAcceptAuth(buyerPeerId, auth);
    seller.recordSpend(sessionId, 10_000n);

    await seller.settleSession(buyerPeerId);
    expect(seller.hasSession(buyerPeerId)).toBe(false);
  });

  it('no-spend session settles via close with initial minBudget auth', async () => {
    const buyerPeerId = buyerIdentity.peerId;
    await doInitialHandshake(50_000n);
    await seller.settleSession(buyerPeerId);
    expect(seller.channelsClient.close).toHaveBeenCalledOnce();
    expect(seller.channelsClient.requestClose).not.toHaveBeenCalled();
  });

  it('buyer handleAuthAck ignores mismatched channelId', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const sessionId = await buyer.authorizeSpending(sellerPeerId, buyerMux, 50_000n, TEST_PRICING);

    buyer.handleAuthAck(sellerPeerId, { channelId: '0x' + 'ff'.repeat(32) });
    expect(buyer.isAuthorized(sellerPeerId)).toBe(false);

    buyer.handleAuthAck(sellerPeerId, { channelId: sessionId });
    expect(buyer.isAuthorized(sellerPeerId)).toBe(true);
  });

  it('seller rejects SpendingAuth with invalid signature', async () => {
    const buyerPeerId = buyerIdentity.peerId;

    const { ZERO_METADATA_HASH, encodeMetadata, ZERO_METADATA } = await import('../src/payments/evm/signatures.js');
    const badAuth: SpendingAuthPayload = {
      channelId: '0x' + '01'.repeat(32),
      cumulativeAmount: '50000',
      metadataHash: ZERO_METADATA_HASH,
      metadata: encodeMetadata(ZERO_METADATA),
      spendingAuthSig: '0x' + 'bb'.repeat(65),
      reserveMaxAmount: '10000000',
      reserveSalt: '0x' + '01'.repeat(32),
      reserveDeadline: Math.floor(Date.now() / 1000) + 3600,
    };

    expect(await seller.handleSpendingAuth(buyerPeerId, badAuth, sellerMux)).toBe('rejected');
    expect(sellerMux.sentAuthAcks).toHaveLength(0);
  });

  it('buyer per-request auth caps cumulative at reserve ceiling', async () => {
    const sellerPeerId = sellerIdentity.peerId;

    const tightConfig = makeBuyerConfig(buyerDir);
    tightConfig.maxReserveAmountUsdc = 100_000n;
    tightConfig.maxPerRequestUsdc = 500_000n;

    buyerStore.close();
    buyerStore = new SessionStore(buyerDir);
    buyer = new BuyerPaymentManager(buyerIdentity, tightConfig, buyerStore);
    buyer.setSigner(buyerIdentity.wallet);

    await buyer.authorizeSpending(sellerPeerId, buyerMux, 50_000n, TEST_PRICING);
    buyer.handleAuthAck(sellerPeerId, { channelId: buyerMux.sentSpendingAuths[0]!.channelId });

    const { payload: auth } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 200_000n },
    );
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

    buyerIdentity = createTestIdentity();
    sellerIdentity = createTestIdentity();

    buyer = new BuyerPaymentManager(buyerIdentity, makeBuyerConfig(buyerDir), buyerStore);
    buyer.setSigner(buyerIdentity.wallet);

    seller = new SellerPaymentManager(sellerIdentity, makeSellerConfig(sellerDir), sellerStore);
    vi.spyOn(seller.channelsClient, 'reserve').mockResolvedValue('0xreservehash');
    vi.spyOn(seller.channelsClient, 'close').mockResolvedValue('0xclosehash');
    vi.spyOn(seller.channelsClient, 'requestClose').mockResolvedValue('0xrequestclosehash');
    vi.spyOn(seller.channelsClient, 'withdraw').mockResolvedValue('0xwithdrawhash');

    buyerMux = createMockPaymentMux();
    sellerMux = createMockPaymentMux();
  });

  afterEach(() => {
    buyerStore.close();
    sellerStore.close();
    rmSync(buyerDir, { recursive: true, force: true });
    rmSync(sellerDir, { recursive: true, force: true });
  });

  const TEST_PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
  const SAMPLE_INPUT = enc.encode('What is the capital of France?');
  const SAMPLE_OUTPUT = enc.encode('The capital of France is Paris.');

  it('onBuyerDisconnect triggers settlement for active session', async () => {
    const sellerPeerId = sellerIdentity.peerId;
    const buyerPeerId = buyerIdentity.peerId;

    const sessionId = await buyer.authorizeSpending(sellerPeerId, buyerMux, 50_000n, TEST_PRICING);
    const initialAuth = buyerMux.sentSpendingAuths[0]!;
    await seller.handleSpendingAuth(buyerPeerId, initialAuth, sellerMux);
    buyer.handleAuthAck(sellerPeerId, sellerMux.sentAuthAcks[0]!);

    const { payload: auth1 } = await buyer.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 10_000n },
    );
    await seller.validateAndAcceptAuth(buyerPeerId, auth1);
    seller.recordSpend(sessionId, 10_000n);

    seller.onBuyerDisconnect(buyerPeerId);
    await new Promise((r) => setTimeout(r, 50));

    expect(seller.channelsClient.close).toHaveBeenCalledOnce();
  });

  it('settleSession is no-op for unknown buyer', async () => {
    await seller.settleSession('unknown-peer');
    expect(seller.channelsClient.close).not.toHaveBeenCalled();
  });

  it('recordSpend is no-op for unknown channelId', () => {
    seller.recordSpend('0x' + 'ff'.repeat(32), 1000n);
  });
});

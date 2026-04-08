import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { estimateCostFromBytes } from '../src/payments/pricing.js';

const enc = new TextEncoder();

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

/** Generate a fake but valid-format peerId (40 hex chars) from a label. */
function fakePeerId(label: string): string {
  const hex = Buffer.from(label).toString('hex').padEnd(40, '0').slice(0, 40);
  return hex;
}

function createMockPaymentMux(): PaymentMux & {
  sentSpendingAuths: unknown[];
} {
  const mux = {
    sentSpendingAuths: [] as unknown[],
    sendSpendingAuth(payload: unknown) { mux.sentSpendingAuths.push(payload); },
    sendAuthAck() {},
    sendPaymentRequired() {},
    sendNeedAuth() {},
    onSpendingAuth() {},
    onAuthAck() {},
    onPaymentRequired() {},
    onNeedAuth() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & { sentSpendingAuths: unknown[] };
}

function makeConfig(dataDir: string, overrides?: Partial<BuyerPaymentConfig>): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    channelsContractAddress: '0x' + 'cc'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
    chainId: 31337,
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 100_000n, // $0.10
    maxReserveAmountUsdc: 10_000_000n, // $10.00
    dataDir,
    ...overrides,
  };
}

/** Standard test pricing: $3/M input, $15/M output (similar to GPT-4). */
const TEST_PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };

/** Realistic test content to get stable tokenx estimates. */
const SAMPLE_INPUT = enc.encode(
  'What is the capital of France? Please provide a detailed answer with historical context.',
);
const SAMPLE_OUTPUT = enc.encode(
  'The capital of France is Paris. Paris has been the capital since the late 10th century when Hugh Capet made it the seat of the French kingdom. The city is located on the Seine River in northern France and is the most populous city in France with over 2 million inhabitants in the city proper.',
);

/** Pre-compute tokenx cost estimate for SAMPLE_INPUT/OUTPUT. */
const SAMPLE_ESTIMATE = estimateCostFromBytes(SAMPLE_INPUT, SAMPLE_OUTPUT, TEST_PRICING);

describe('BuyerPaymentManager', () => {
  let tempDir: string;
  let identity: Identity;
  let manager: BuyerPaymentManager;
  let store: ChannelStore;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-pm-test-'));
    identity = createTestIdentity();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    const wallet = Wallet.createRandom();
    manager.setSigner(wallet);
    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── authorizeSpending ──────────────────────────────────────────

  it('authorizeSpending sends SpendingAuth with channelId and reserve fields', async () => {
    const sellerPeerId = fakePeerId('seller-peer-001');
    const minBudget = 50_000n;

    const channelId = await manager.authorizeSpending(sellerPeerId, mux, minBudget, TEST_PRICING);

    expect(channelId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mux.sentSpendingAuths.length).toBe(1);

    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe('50000');
    expect(sent.metadataHash).toBeTypeOf('string');
    expect(sent.channelId).toBe(channelId);
    expect(sent.spendingAuthSig).toBeTypeOf('string');
    expect(sent.reserveSalt).toBeTypeOf('string');
    expect(sent.reserveMaxAmount).toBe('10000000');
  });

  it('authorizeSpending sends ABI-encoded zero metadata (not empty string)', async () => {
    const sellerPeerId = fakePeerId('seller-peer-meta');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

    expect(channelId).toMatch(/^0x[0-9a-f]{64}$/);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    // metadata must be a valid hex-encoded bytes value, not ''
    expect(sent.metadata).toBeTypeOf('string');
    expect(sent.metadata).not.toBe('');
    expect((sent.metadata as string).startsWith('0x')).toBe(true);
    // Should be ABI-encoded (version,inputTokens,outputTokens,requestCount) = 4 * 32 bytes + 0x prefix
    expect((sent.metadata as string).length).toBe(2 + 4 * 64);
  });

  it('authorizeSpending rejects if minBudgetPerRequest exceeds maxPerRequestUsdc', async () => {
    const sellerPeerId = fakePeerId('seller-peer-reject');
    const tooLarge = 200_000n;

    const channelId = await manager.authorizeSpending(sellerPeerId, mux, tooLarge, TEST_PRICING);

    expect(channelId).toBe('');
    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  it('authorizeSpending initializes verifiedCost to 0', async () => {
    const sellerPeerId = fakePeerId('seller-init');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(0n);
  });

  // ── AuthAck ────────────────────────────────────────────────────

  it('handleAuthAck marks session as confirmed', async () => {
    const sellerPeerId = fakePeerId('seller-peer-003');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    expect(manager.isAuthorized(sellerPeerId)).toBe(false);

    manager.handleAuthAck(sellerPeerId, { channelId });
    expect(manager.isAuthorized(sellerPeerId)).toBe(true);
  });

  it('isAuthorized returns true for confirmed session, false otherwise', async () => {
    const peerId1 = fakePeerId('seller-peer-auth-1');
    const peerId2 = fakePeerId('seller-peer-auth-2');

    expect(manager.isAuthorized(peerId1)).toBe(false);

    const cid = await manager.authorizeSpending(peerId1, mux, 10_000n, TEST_PRICING);
    expect(manager.isAuthorized(peerId1)).toBe(false);

    manager.handleAuthAck(peerId1, { channelId: cid });
    expect(manager.isAuthorized(peerId1)).toBe(true);
    expect(manager.isAuthorized(peerId2)).toBe(false);
  });

  // ── recordResponseBytes ────────────────────────────────────────

  it('recordResponseBytes accumulates verified cost using tokenx', async () => {
    const sellerPeerId = fakePeerId('seller-bytes');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const result1 = manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    expect(result1).not.toBeNull();
    expect(result1!.inputTokens).toBeGreaterThan(5);
    expect(result1!.outputTokens).toBeGreaterThan(20);
    expect(result1!.verifiedCost).toBeGreaterThan(0n);
    expect(result1!.verifiedCost).toBe(SAMPLE_ESTIMATE.cost);

    // Second response accumulates
    const result2 = manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    expect(result2!.verifiedCost).toBe(SAMPLE_ESTIMATE.cost * 2n);
    expect(manager.getVerifiedCost(sellerPeerId)).toBe(SAMPLE_ESTIMATE.cost * 2n);
  });

  it('recordResponseBytes returns null without pricing', async () => {
    const sellerPeerId = fakePeerId('seller-no-pricing');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n); // no pricing
    const result = manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    expect(result).toBeNull();
  });

  // ── signPerRequestAuth (overdraft model) ───────────────────────

  it('signPerRequestAuth uses seller claimed cost within tolerance', async () => {
    const sellerPeerId = fakePeerId('seller-perreq');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    manager.handleAuthAck(sellerPeerId, {
      channelId: (mux.sentSpendingAuths[0] as Record<string, unknown>).channelId as string,
    });

    // Seller claims less than buyer estimate * 1.4 → accepted as-is
    const sellerClaim = SAMPLE_ESTIMATE.cost / 2n; // well under tolerance
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: sellerClaim },
    );

    // new cumulative = 0 (initial) + sellerClaim
    expect(BigInt(payload.cumulativeAmount)).toBe(sellerClaim);
    expect(payload.spendingAuthSig).toBeTypeOf('string');
  });

  it('signPerRequestAuth caps seller claim at tolerance multiplier', async () => {
    const sellerPeerId = fakePeerId('seller-cap');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Seller claims way more than buyer estimate * 1.4
    const outrageousClaim = SAMPLE_ESTIMATE.cost * 10n;
    const maxAcceptable = BigInt(Math.ceil(Number(SAMPLE_ESTIMATE.cost) * 1.4));

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: outrageousClaim },
    );

    // new cumulative = 0 (initial) + capped amount
    expect(BigInt(payload.cumulativeAmount)).toBe(maxAcceptable);
  });

  it('signPerRequestAuth caps at overdraft limit (verifiedCost + maxPerRequestUsdc)', async () => {
    const sellerPeerId = fakePeerId('seller-overdraft');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Seller claims a huge cost — tolerance caps it first, then overdraft limit
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 500_000n },
    );

    // maxSignable = verifiedCost + maxPerRequestUsdc(100_000)
    const maxSignable = SAMPLE_ESTIMATE.cost + 100_000n;
    // The tolerance cap (1.4x estimate) is applied first, which is smaller than overdraft
    expect(BigInt(payload.cumulativeAmount)).toBeLessThanOrEqual(maxSignable);
  });

  it('signPerRequestAuth advances after multiple responses', async () => {
    const sellerPeerId = fakePeerId('seller-multi');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Use a claim within tolerance so it's accepted as-is
    const claim = SAMPLE_ESTIMATE.cost / 2n; // well under 1.4x estimate

    const { payload: p1 } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: claim },
    );
    expect(BigInt(p1.cumulativeAmount)).toBe(claim);

    const { payload: p2 } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: claim },
    );
    expect(BigInt(p2.cumulativeAmount)).toBe(claim * 2n);
  });

  it('signPerRequestAuth uses buyer estimate when no seller claim', async () => {
    const sellerPeerId = fakePeerId('seller-no-claim');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT },
    );

    // Buyer estimate used as cost, cumulative = 0 + estimate
    expect(BigInt(payload.cumulativeAmount)).toBe(SAMPLE_ESTIMATE.cost);
  });

  it('signPerRequestAuth ensures monotonic increase', async () => {
    const sellerPeerId = fakePeerId('seller-mono');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

    // Tiny response — cost would be very small, but cumulative must advance
    const tiny = enc.encode('Hi');
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: tiny, outputBytes: tiny, sellerClaimedCost: 1n },
    );

    expect(BigInt(payload.cumulativeAmount)).toBe(1n);
  });

  it('signPerRequestAuth uses seller claimed cost for verifiedCost when no pricing available', async () => {
    // Simulate post-restart state: session exists but no pricing in memory
    const sellerPeerId = fakePeerId('seller-no-pricing-restart');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n); // no pricing!

    const sellerClaim = 5_000n;
    const { payload: p1 } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: sellerClaim,
        reportedInputTokens: 100n,
        reportedOutputTokens: 50n,
      },
    );

    // Cumulative should advance by seller's claimed cost
    expect(BigInt(p1.cumulativeAmount)).toBe(sellerClaim);

    // Second request — verifiedCost should have grown, allowing maxSignable to increase
    const { payload: p2 } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: sellerClaim,
        reportedInputTokens: 100n,
        reportedOutputTokens: 50n,
      },
    );

    // Should advance further — not stuck at the same value
    expect(BigInt(p2.cumulativeAmount)).toBe(sellerClaim * 2n);
  });

  it('signPerRequestAuth signals topUpNeeded when approaching reserve ceiling', async () => {
    const sellerPeerId = fakePeerId('seller-topup');
    // Use a ceiling just above the expected cost so one request pushes past 80%.
    // Cumulative starts at 0, so after one request cumulative = cost.
    // Set ceiling = cost + 100 so cumulative ≈ ceiling, which exceeds 80% threshold.
    const initialBudget = 9_000n;
    const ceiling = SAMPLE_ESTIMATE.cost + 100n; // tight ceiling
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: ceiling, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());

    await manager.authorizeSpending(sellerPeerId, mux, initialBudget, TEST_PRICING);

    // threshold = ceiling * 80%. After request, cumulative = 0 + cost.
    // ceiling is cost + 100, so cumulative = ceiling - 100.
    // threshold = (ceiling) * 0.8. Since cumulative ≈ ceiling, it must exceed threshold.
    const { topUpNeeded, payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: SAMPLE_ESTIMATE.cost },
    );

    expect(BigInt(payload.cumulativeAmount)).toBe(SAMPLE_ESTIMATE.cost);
    expect(topUpNeeded).toBe(true);
  });

  it('signPerRequestAuth accepts seller claim above buyer estimate when within tolerance', async () => {
    const sellerPeerId = fakePeerId('seller-above-ok');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Seller claims 1.3x the buyer's estimate — within 1.4x tolerance
    const sellerClaim = BigInt(Math.ceil(Number(SAMPLE_ESTIMATE.cost) * 1.3));
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: sellerClaim },
    );

    // Seller's claim accepted as-is (not reduced to buyer's estimate)
    expect(BigInt(payload.cumulativeAmount)).toBe(sellerClaim);
  });

  it('signPerRequestAuth does not underpay when seller claim is slightly above buyer estimate', async () => {
    const sellerPeerId = fakePeerId('seller-no-underpay');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Seller claims 10% more than buyer's estimate — well within tolerance
    const sellerClaim = SAMPLE_ESTIMATE.cost + SAMPLE_ESTIMATE.cost / 10n;
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: sellerClaim },
    );

    // acceptedCost must be the seller's claim, not the buyer's lower estimate
    const cumulative = BigInt(payload.cumulativeAmount);
    expect(cumulative).toBe(sellerClaim);
    expect(cumulative).toBeGreaterThan(SAMPLE_ESTIMATE.cost);
  });

  it('signPerRequestAuth trusts seller claimed cost of zero (no byte fallback)', async () => {
    const sellerPeerId = fakePeerId('seller-zero-claim');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 0n },
    );

    // Seller claimed cost=0 is authoritative — no byte-based fallback, no forced +1
    expect(BigInt(payload.cumulativeAmount)).toBe(0n);
  });

  it('signPerRequestAuth prefers reported tokens over byte estimation for metadata', async () => {
    const sellerPeerId = fakePeerId('seller-reported');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    const reportedIn = 5000n;
    const reportedOut = 200n;
    const { payload } = await manager.signPerRequestAuth(
      sellerPeerId,
      {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        reportedInputTokens: reportedIn,
        reportedOutputTokens: reportedOut,
      },
    );

    // Metadata should encode reported tokens, not byte-estimated tokens.
    // The metadata is ABI-encoded: (version, inputTokens, outputTokens, requestCount)
    // We can verify by checking the payload has a valid metadataHash
    expect(payload.metadata).toBeTypeOf('string');
    expect(payload.metadataHash).toBeTypeOf('string');
    // Cumulative should use cost from reported tokens, not from bytes.
    // Since cumulative starts at 0, the cumulative amount equals the reported cost.
    const reportedCost = BigInt(Math.round(
      (Number(reportedIn) * TEST_PRICING.inputUsdPerMillion +
       Number(reportedOut) * TEST_PRICING.outputUsdPerMillion) / 1_000_000 * 1_000_000
    ));
    expect(BigInt(payload.cumulativeAmount)).toBe(reportedCost);
  });

  it('signPerRequestAuth throws if no active session', async () => {
    await expect(
      manager.signPerRequestAuth('nonexistent-peer', { inputBytes: new Uint8Array(0), outputBytes: new Uint8Array(0) }),
    ).rejects.toThrow(/No active session/);
  });

  // ── handleNeedAuth ─────────────────────────────────────────────

  it('handleNeedAuth signs within overdraft limit', async () => {
    const sellerPeerId = fakePeerId('seller-needauth');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    // Verified cost is 0, so maxSignable = 0 + 100_000 = 100_000
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe('50000');
  });

  it('handleNeedAuth caps at reserve ceiling', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-cap');
    // Reserve ceiling = 10_000 (initial suggested amount)
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    // Seller asks for 500_000 → capped at reserve ceiling (10_000).
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    // Should trigger top-up since required > ceiling, then sign
    expect(mux.sentSpendingAuths.length).toBeGreaterThanOrEqual(1);
  });

  it('handleNeedAuth tops up reserve when the ceiling blocks the required amount', async () => {
    store.close();
    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(
      identity,
      makeConfig(tempDir, { maxReserveAmountUsdc: 100_000n, maxPerRequestUsdc: 100_000n }),
      store,
    );
    manager.setSigner(Wallet.createRandom());

    const sellerPeerId = fakePeerId('seller-needauth-topup');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 100_000n, TEST_PRICING);

    // Increase verified cost so the overdraft model can sign above the current ceiling
    // once the reserve is topped up.
    manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    mux.sentSpendingAuths.length = 0;

    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '100001',
      currentAcceptedCumulative: '100000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(2);
    const reserveTopUp = mux.sentSpendingAuths[0] as Record<string, unknown>;
    const updatedBudget = mux.sentSpendingAuths[1] as Record<string, unknown>;
    expect(reserveTopUp.reserveMaxAmount).toBe('200000');
    expect(updatedBudget.cumulativeAmount).toBe('100001');
  });

  it('handleNeedAuth allows more after verified cost increases', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-v');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);

    // Record response to increase verified cost
    manager.recordResponseBytes(sellerPeerId, SAMPLE_INPUT, SAMPLE_OUTPUT);
    const verified = manager.getVerifiedCost(sellerPeerId);
    const maxSignable = verified + 100_000n;
    mux.sentSpendingAuths.length = 0;

    // Ask for just under maxSignable
    const requested = maxSignable - 1000n;
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: requested.toString(),
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe(requested.toString());
  });

  it('handleNeedAuth ignores stale requests', async () => {
    const sellerPeerId = fakePeerId('seller-needauth-stale');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    // First, advance cumulative by processing a NeedAuth with a higher amount
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '50000',
      currentAcceptedCumulative: '0',
      deposit: '1000000',
    }, mux);
    expect(mux.sentSpendingAuths.length).toBe(1);
    mux.sentSpendingAuths.length = 0;

    // Stale: required (30000) < current cumulative (50000)
    await manager.handleNeedAuth(sellerPeerId, {
      channelId,
      requiredCumulativeAmount: '30000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  it('handleNeedAuth ignores unknown seller', async () => {
    mux.sentSpendingAuths.length = 0;

    await manager.handleNeedAuth('unknown-seller', {
      channelId: '0x' + '00'.repeat(32),
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  // ── Reserve top-up ─────────────────────────────────────────────

  it('topUpReserve sends new ReserveAuth with increased ceiling', async () => {
    const sellerPeerId = fakePeerId('seller-topup-rsv');
    await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    mux.sentSpendingAuths.length = 0;

    await manager.topUpReserve(sellerPeerId, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.reserveMaxAmount).toBe('20000000');
    expect(sent.reserveSalt).toBeTypeOf('string');
    expect(sent.reserveDeadline).toBeTypeOf('number');
    expect(manager.getReserveCeiling(sellerPeerId)).toBe(20_000_000n);
  });

  // parseResponseCost tests removed — method removed (cost flows through NeedAuth now)

  // ── Session persistence ────────────────────────────────────────

  it('session survives store reconstruction', async () => {
    const sellerPeerId = fakePeerId('seller-peer-persist');
    const channelId = await manager.authorizeSpending(sellerPeerId, mux, 10_000n, TEST_PRICING);
    store.close();

    const checkStore = new ChannelStore(tempDir);
    const session = checkStore.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.peerId).toBe(sellerPeerId);
    expect(session!.role).toBe('buyer');
    expect(session!.authMax).toBe('10000');
    checkStore.close();

    store = new ChannelStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(Wallet.createRandom());

    const mux2 = createMockPaymentMux();
    const secondId = await manager.authorizeSpending(sellerPeerId, mux2, 10_000n, TEST_PRICING);
    expect(secondId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(secondId).not.toBe(channelId);
  });

  // ── recordAndPersistTokens ────────────────────────────────────

  it('recordAndPersistTokens accumulates tokens and persists to channel store', async () => {
    const sellerPeerId = fakePeerId('seller-record-tok');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

    manager.recordAndPersistTokens(sellerPeerId, 1000, 200);
    manager.recordAndPersistTokens(sellerPeerId, 500, 150);

    // In-memory totals
    const totals = manager.getResponseTokenTotals(sellerPeerId);
    expect(totals.input).toBe(1500);
    expect(totals.output).toBe(350);
    expect(totals.requests).toBe(2);

    // Persisted in channel store
    const channel = store.getActiveChannelByPeer(sellerPeerId, 'buyer');
    expect(channel).not.toBeNull();
    expect(channel!.tokensDelivered).toBe('1500');
    expect(channel!.previousConsumption).toBe('350');
    expect(channel!.requestCount).toBe(2);
  });

  it('recordAndPersistTokens no-ops when no active session', () => {
    const sellerPeerId = fakePeerId('seller-no-session');
    manager.recordAndPersistTokens(sellerPeerId, 1000, 200);
    expect(manager.getResponseTokenTotals(sellerPeerId)).toBeNull();
  });

  it('getResponseTokenTotals returns null for unknown peer', () => {
    const totals = manager.getResponseTokenTotals(fakePeerId('unknown'));
    expect(totals).toBeNull();
  });

  it('recordAndPersistTokens survives store reopen', async () => {
    const sellerPeerId = fakePeerId('seller-persist');
    await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

    manager.recordAndPersistTokens(sellerPeerId, 2000, 800);
    store.close();

    // Reopen store and verify persisted data
    const store2 = new ChannelStore(tempDir);
    const channel = store2.getActiveChannelByPeer(sellerPeerId, 'buyer');
    expect(channel).not.toBeNull();
    expect(channel!.tokensDelivered).toBe('2000');
    expect(channel!.previousConsumption).toBe('800');
    expect(channel!.requestCount).toBe(1);
    store2.close();

    // Re-assign store so afterEach cleanup doesn't double-close
    store = new ChannelStore(tempDir);
  });
});

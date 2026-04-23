import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { SpendingAuthPayload } from '../src/types/protocol.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { Wallet } from 'ethers';
import { signSpendingAuth, signReserveAuth, makeChannelsDomain, computeMetadataHash, encodeMetadata, ZERO_METADATA, ZERO_METADATA_HASH } from '../src/payments/evm/signatures.js';
import type { SpendingAuthMessage, ReserveAuthMessage, SpendingAuthMetadata } from '../src/payments/evm/signatures.js';

const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
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

/** Build a valid SpendingAuth payload signed by the buyer's EVM wallet with dual sigs. */
async function buildSpendingAuth(
  buyerIdentity: Identity,
  _sellerIdentity: Identity,
  channelId: string,
  opts: {
    cumulativeAmount?: bigint;
    cumulativeInputTokens?: bigint;
    cumulativeOutputTokens?: bigint;
    salt?: string;
    deadline?: number;
    reserveMaxAmount?: string;
    isReserve?: boolean;
  } = {},
): Promise<SpendingAuthPayload> {
  const cumulativeAmount = opts.isReserve ? 0n : (opts.cumulativeAmount ?? 1_000_000n);
  const cumulativeInputTokens = opts.cumulativeInputTokens ?? 0n;
  const cumulativeOutputTokens = opts.cumulativeOutputTokens ?? 0n;
  const salt = opts.salt ?? '0x' + '01'.repeat(32);
  const deadline = opts.deadline ?? Math.floor(Date.now() / 1000) + 3600;

  const meta: SpendingAuthMetadata = {
    cumulativeInputTokens,
    cumulativeOutputTokens,
    cumulativeRequestCount: 0n,
  };
  const metadataHashHex = computeMetadataHash(meta);
  const encodedMetadata = encodeMetadata(meta);

  const buyerWallet = buyerIdentity.wallet;
  const sessionsDomain = makeChannelsDomain(CHAIN_ID, CONTRACT_ADDR);
  const reserveMaxAmount = BigInt(opts.reserveMaxAmount ?? '10000000');

  // First auth (reserve) uses ReserveAuth; subsequent uses SpendingAuth
  const isReserve = opts.isReserve ?? false;
  let spendingAuthSig: string;
  if (isReserve) {
    const reserveMsg: ReserveAuthMessage = { channelId, maxAmount: reserveMaxAmount, deadline: BigInt(deadline) };
    spendingAuthSig = await signReserveAuth(buyerWallet, sessionsDomain, reserveMsg);
  } else {
    const metadataMsg: SpendingAuthMessage = { channelId, cumulativeAmount, metadataHash: metadataHashHex };
    spendingAuthSig = await signSpendingAuth(buyerWallet, sessionsDomain, metadataMsg);
  }

  return {
    channelId,
    cumulativeAmount: cumulativeAmount.toString(),
    metadataHash: metadataHashHex,
    metadata: encodedMetadata,
    spendingAuthSig,
    reserveSalt: salt,
    reserveMaxAmount: reserveMaxAmount.toString(),
    reserveDeadline: deadline,
  };
}

function makeChannelId(n: number): string {
  return '0x' + n.toString(16).padStart(2, '0').repeat(32);
}

function makeOnChainChannel(buyer: Identity, seller: Identity, overrides: Record<string, unknown> = {}) {
  return {
    buyer: buyer.wallet.address,
    seller: seller.wallet.address,
    deposit: 2_000_000n,
    settled: 500_000n,
    metadataHash: ZERO_METADATA_HASH,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    settledAt: 0n,
    closeRequestedAt: 0n,
    status: 1,
    ...overrides,
  };
}

describe('SellerPaymentManager', () => {
  let tempDir: string;
  let store: ChannelStore;
  let sellerIdentity: Identity;
  let buyerIdentity: Identity;
  let manager: SellerPaymentManager;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-pm-test-'));
    store = new ChannelStore(tempDir);
    sellerIdentity = createTestIdentity();
    buyerIdentity = createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    vi.spyOn(manager.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager.channelsClient, 'close').mockResolvedValue('0xclose-hash');
    vi.spyOn(manager.channelsClient, 'requestClose').mockResolvedValue('0xrequesttimeout-hash');
    vi.spyOn(manager.channelsClient, 'withdraw').mockResolvedValue('0xwithdraw-hash');

    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_handleSpendingAuth_firstSign: calls reserve, sends AuthAck', async () => {
    const channelId = makeChannelId(1);

    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });

    await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(manager.channelsClient.reserve).toHaveBeenCalledOnce();
    expect(mux.sentAuthAcks.length).toBe(1);
    const ack = mux.sentAuthAcks[0] as Record<string, unknown>;
    expect(ack.channelId).toBe(channelId);

    const session = store.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.role).toBe('seller');
    expect(session!.status).toBe('active');
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
  });

  it('test_handleSpendingAuth_subsequent: validates monotonic increase', async () => {

    const channelId = makeChannelId(2);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);

    expect(mux.sentAuthAcks.length).toBe(1);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });

  it('waitForPendingAuths drains queued SpendingAuths while an on-chain top-up is in flight', async () => {
    const channelId = makeChannelId(99);

    // Initial reserve with ceiling 1_000_000.
    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    // Advance cumulative to 900_000 and record matching spend so the channel is
    // right at the edge of budget exhaustion.
    const auth900k = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 900_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, auth900k, mux);
    manager.recordSpend(channelId, 900_000n);
    expect(manager.getAcceptedCumulative(channelId)).toBe(900_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(900_000n);

    // Make topUp() block until we release it so we can observe the window
    // where the per-buyer mutex holds queued SpendingAuths.
    let releaseTopUp!: () => void;
    const topUpBlocker = new Promise<void>((resolve) => { releaseTopUp = resolve; });
    const topUpSpy = vi.spyOn(manager.channelsClient, 'topUp').mockImplementation(async () => {
      await topUpBlocker;
      return '0xtopup-hash';
    });

    // Top-up auth (new ceiling 2_000_000) — this fires the blocking topUp() call.
    const topUpPayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '2000000',
      salt: '0x' + '02'.repeat(32),
    });
    const topUpPromise = manager.handleSpendingAuth(buyerIdentity.peerId, topUpPayload, mux);

    // Wait until the handler is parked inside the topUp() call.
    while (topUpSpy.mock.calls.length === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }

    // Queue a follow-up SpendingAuth above the old ceiling. This should sit
    // behind the top-up in the per-buyer mutex until the top-up unblocks.
    const followUpPayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 1_500_000n,
      reserveMaxAmount: '2000000',
    });
    const followUpPromise = manager.handleSpendingAuth(buyerIdentity.peerId, followUpPayload, mux);
    await new Promise<void>((r) => setImmediate(r));

    // The follow-up is queued — accepted cumulative is still stale at 900_000,
    // which is the racing state where a request handler would return 402.
    expect(manager.getAcceptedCumulative(channelId)).toBe(900_000n);

    // waitForPendingAuths must not resolve while the top-up is still in flight.
    let waitResolved = false;
    const waitPromise = manager
      .waitForPendingAuths(buyerIdentity.peerId)
      .then(() => { waitResolved = true; });
    await new Promise<void>((r) => setImmediate(r));
    expect(waitResolved).toBe(false);

    // Release the top-up. The queued follow-up now applies and waitForPendingAuths resolves.
    releaseTopUp();
    await Promise.all([topUpPromise, followUpPromise, waitPromise]);

    expect(waitResolved).toBe(true);
    expect(manager.getAcceptedCumulative(channelId)).toBe(1_500_000n);
    // A budget check after draining sees the advanced cumulative — no bogus 402.
    expect(manager.getCumulativeSpend(channelId) >= manager.getAcceptedCumulative(channelId)).toBe(false);
  });

  it('recovers an active on-chain channel when local seller session is missing', async () => {
    const channelId = makeChannelId(21);
    vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue({
      buyer: buyerIdentity.wallet.address,
      seller: sellerIdentity.wallet.address,
      deposit: 1_000_000n,
      settled: 50_000n,
      metadataHash: ZERO_METADATA_HASH,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      settledAt: 0n,
      closeRequestedAt: 0n,
      status: 1,
    });

    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
      reserveMaxAmount: undefined,
    });
    delete payload.reserveSalt;
    delete payload.reserveMaxAmount;
    delete payload.reserveDeadline;

    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(result).toBe('accepted');
    expect(manager.channelsClient.reserve).not.toHaveBeenCalled();
    expect(manager.channelsClient.getSession).toHaveBeenCalledWith(channelId);
    expect(mux.sentAuthAcks.length).toBe(1);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(50_000n);

    const session = store.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    expect(session!.previousConsumption).toBe('1000000');
    expect(session!.tokensDelivered).toBe('50000');
  });

  it('awaitAcceptedAtLeast resolves when a SpendingAuth raises accepted to the target', async () => {
    const channelId = makeChannelId(77);
    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    // Simulate the race: the request handler is waiting for accepted >= spent
    // while the buyer's catch-up SpendingAuth is still on the wire.
    const waitPromise = manager.awaitAcceptedAtLeast(channelId, 500_000n, 2_000);

    // A late-arriving SpendingAuth unblocks the waiter in a single tick — the
    // request handler resumes instead of emitting a spurious 402.
    const catchUp = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 500_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, catchUp, mux);

    await expect(waitPromise).resolves.toBe(true);
    expect(manager.getAcceptedCumulative(channelId)).toBe(500_000n);
  });

  it('awaitAcceptedAtLeast returns true immediately when the target is already satisfied', async () => {
    const channelId = makeChannelId(78);
    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);
    const authPayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 300_000n,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, authPayload, mux);

    await expect(manager.awaitAcceptedAtLeast(channelId, 200_000n, 1_000)).resolves.toBe(true);
  });

  it('awaitAcceptedAtLeast times out with false when the SpendingAuth never arrives', async () => {
    const channelId = makeChannelId(79);
    const reservePayload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      isReserve: true,
      reserveMaxAmount: '1000000',
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reservePayload, mux);

    await expect(manager.awaitAcceptedAtLeast(channelId, 500_000n, 50)).resolves.toBe(false);
  });

  it('test_recordSpend: tracks cumulative spend', async () => {

    const channelId = makeChannelId(3);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    manager.recordSpend(channelId, 50_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(50_000n);

    manager.recordSpend(channelId, 30_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(80_000n);
  });

  it('test_getChannelByPeer: returns active channel', async () => {

    const channelId = makeChannelId(4);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    const channel = manager.getChannelByPeer(buyerIdentity.peerId);
    expect(channel).not.toBeNull();
    expect(channel!.sessionId).toBe(channelId);
  });

  it('test_onBuyerDisconnect: session persisted, not closed when settleOnDisconnect=false', async () => {
    const config2: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      channelsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
      settleOnDisconnect: false,
    };
    const manager2 = new SellerPaymentManager(sellerIdentity, config2, store);
    vi.spyOn(manager2.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager2.channelsClient, 'close').mockResolvedValue('0xclose-hash');


    const channelId = makeChannelId(5);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager2.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(manager2.hasSession(buyerIdentity.peerId)).toBe(true);
    manager2.onBuyerDisconnect(buyerIdentity.peerId);
    expect(manager2.hasSession(buyerIdentity.peerId)).toBe(false);

    const session = store.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    expect(manager2.channelsClient.close).not.toHaveBeenCalled();
  });

  it('test_onBuyerDisconnect_close: calls close with valid metadata from latest auth', async () => {
    const channelId = makeChannelId(10);

    // Reserve
    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    // Accept a SpendingAuth with real metadata
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
      cumulativeInputTokens: 100n,
      cumulativeOutputTokens: 500n,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);

    // Record some spend so close() is attempted (not zero-cumulative deferral)
    manager.recordSpend(channelId, 50_000n);

    manager.onBuyerDisconnect(buyerIdentity.peerId);

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0];
    // closeArgs: [signer, channelId, cumulativeAmount, metadata, buyerSig]
    const metadata = closeArgs[3] as string;
    expect(metadata).not.toBe('');
    expect(metadata.startsWith('0x')).toBe(true);
  });

  it('test_onBuyerDisconnect_close_empty_metadata: falls back to 0x for empty metadata', async () => {
    const channelId = makeChannelId(11);

    // Reserve
    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    // Accept a SpendingAuth but mutate metadata to empty string (simulates old buyer)
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    payload2.metadata = ''; // simulate old buyer sending empty metadata
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);

    // Record some spend so close() is attempted
    manager.recordSpend(channelId, 5_000n);

    manager.onBuyerDisconnect(buyerIdentity.peerId);

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0];
    const metadata = closeArgs[3] as string;
    // Should fall back to ABI-encoded zero metadata (matching ZERO_METADATA_HASH)
    expect(metadata).toBe(encodeMetadata(ZERO_METADATA));
  });

  it('rejects SpendingAuth when cumulative exceeds on-chain deposit', async () => {
    const channelId = makeChannelId(40);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    // Accept a SpendingAuth within deposit (reserveMax defaults to 10,000,000)
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
    });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);

    // Set reserveMax to 300,000 to simulate a small deposit
    (manager as unknown as { _reserveMax: Map<string, bigint> })._reserveMax.set(channelId, 300_000n);

    // Try to accept a SpendingAuth that exceeds the deposit — should be rejected
    const payload3 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 500_000n,
    });
    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload3, mux);
    expect(result).toBe('rejected');

    // Cumulative should remain at the last valid value
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });

  it('accepts SpendingAuth within deposit ceiling', async () => {
    const channelId = makeChannelId(41);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    // Accept SpendingAuth within default deposit (10,000,000)
    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, {
      cumulativeAmount: 200_000n,
    });
    const result = await manager.handleSpendingAuth(buyerIdentity.peerId, payload2, mux);
    expect(result).toBe('accepted');
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });

  it('test_hasSession: returns true/false correctly', async () => {

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);

    const channelId = makeChannelId(7);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload, mux);

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    expect(manager.hasSession('nonexistent-peer')).toBe(false);
  });

  it('test_getPaymentRequirements: returns payment requirements payload', () => {
    const req = manager.getPaymentRequirements('test-req-1');
    expect(req).not.toBeNull();
    expect(req.suggestedAmount).toBe('1000000');
    expect(req.requestId).toBe('test-req-1');
    expect(req.minBudgetPerRequest).toBeDefined();
  });

  it('test_getPaymentRequirements_includes_requestId: correlates with the triggering request', () => {
    const req1 = manager.getPaymentRequirements('req-aaa');
    const req2 = manager.getPaymentRequirements('req-bbb');
    expect(req1.requestId).toBe('req-aaa');
    expect(req2.requestId).toBe('req-bbb');
  });

  it('test_validateAndAcceptAuth: accepts monotonic increase', async () => {

    const channelId = makeChannelId(8);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, payload1, mux);

    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    const accepted = await manager.validateAndAcceptAuth(buyerIdentity.peerId, payload2);
    expect(accepted).toBe(true);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });

  describe('validateHydratedChannels', () => {
    function seedChannel(
      channelStore: ChannelStore,
      channelId: string,
      buyer: Identity,
      seller: Identity,
      opts: Partial<StoredChannel> = {},
    ): StoredChannel {
      const now = Date.now();
      const channel: StoredChannel = {
        sessionId: channelId,
        peerId: buyer.peerId,
        role: 'seller',
        sellerEvmAddr: seller.wallet.address,
        buyerEvmAddr: buyer.wallet.address,
        nonce: 0,
        authMax: '1000000',
        previousConsumption: '2000000',
        tokensDelivered: '500000',
        deadline: Math.floor(now / 1000) + 3600,
        previousSessionId: '',
        requestCount: 0,
        reservedAt: now,
        settledAt: null,
        settledAmount: null,
        status: 'active',
        latestBuyerSig: '0xdead',
        latestSpendingAuthSig: '0xdead',
        latestMetadata: null,
        createdAt: now,
        updatedAt: now,
        ...opts,
      };
      channelStore.upsertChannel(channel);
      return channel;
    }

    const ZERO_CHANNEL = {
      buyer: '0x0000000000000000000000000000000000000000',
      seller: '0x0000000000000000000000000000000000000000',
      deposit: 0n,
      settled: 0n,
      metadataHash: ZERO_METADATA_HASH,
      deadline: 0n,
      settledAt: 0n,
      closeRequestedAt: 0n,
      status: 0,
    };

    function makeFreshManager() {
      const config: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
      };
      return new SellerPaymentManager(sellerIdentity, config, store);
    }

    it('evicts channel that no longer exists on-chain', async () => {
      const channelId = makeChannelId(30);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(ZERO_CHANNEL);

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(store.getChannel(channelId)!.status).toBe('settled');
    });

    it('evicts channel with settled on-chain status', async () => {
      const channelId = makeChannelId(31);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { status: 2 }),
      );

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(store.getChannel(channelId)!.status).toBe('settled');
    });

    it('keeps channel and reconciles when active on-chain with higher settled', async () => {
      const channelId = makeChannelId(32);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, { tokensDelivered: '100000' });

      const mgr = makeFreshManager();
      expect(mgr.getCumulativeSpend(channelId)).toBe(100_000n);

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 800_000n }),
      );

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
      expect(mgr.getCumulativeSpend(channelId)).toBe(800_000n);
    });

    it('clears stale auth when authMax <= on-chain settled', async () => {
      const channelId = makeChannelId(36);
      // authMax=600000 < on-chain settled=800000 → auth is stale
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, {
        authMax: '600000',
        tokensDelivered: '100000',
        latestSpendingAuthSig: '0xoldauth',
      });

      const mgr = makeFreshManager();

      // Verify auth was hydrated
      const settleParams = (mgr as unknown as { _getSettleParams: (id: string) => { amount: bigint } })._getSettleParams(channelId);
      expect(settleParams.amount).toBeGreaterThan(0n);

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 800_000n }),
      );

      await mgr.validateHydratedChannels();

      // Auth should be cleared — settle(600000) would revert since 600000 <= 800000
      const settleParamsAfter = (mgr as unknown as { _getSettleParams: (id: string) => { amount: bigint } })._getSettleParams(channelId);
      expect(settleParamsAfter.amount).toBe(0n);
    });

    it('preserves valid auth when authMax > on-chain settled', async () => {
      const channelId = makeChannelId(37);
      // authMax=1000000 > on-chain settled=800000 → auth is still valid
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, {
        authMax: '1000000',
        tokensDelivered: '100000',
        latestSpendingAuthSig: '0xvalidauth',
      });

      const mgr = makeFreshManager();

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 800_000n }),
      );

      await mgr.validateHydratedChannels();

      // Auth should remain — settle(1000000) would succeed since 1000000 > 800000
      const settleParams = (mgr as unknown as { _getSettleParams: (id: string) => { amount: bigint } })._getSettleParams(channelId);
      expect(settleParams.amount).toBeGreaterThan(0n);
    });

    it('does NOT clear auth when no reconciliation needed', async () => {
      const channelId = makeChannelId(38);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity, {
        tokensDelivered: '800000',
        latestSpendingAuthSig: '0xvalidauth',
      });

      const mgr = makeFreshManager();

      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 500_000n }),
      );

      await mgr.validateHydratedChannels();

      // No reconciliation (local 800k > on-chain 500k), auth should remain
      const settleParams = (mgr as unknown as { _getSettleParams: (id: string) => { amount: bigint } })._getSettleParams(channelId);
      expect(settleParams.amount).toBeGreaterThan(0n);
    });

    it('keeps channel hydrated on RPC failure', async () => {
      const channelId = makeChannelId(33);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      vi.spyOn(mgr.channelsClient, 'getSession').mockRejectedValue(new Error('RPC timeout'));

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
      expect(store.getChannel(channelId)!.status).toBe('active');
    });

    it('evicts channel with mismatched parties', async () => {
      const channelId = makeChannelId(34);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      const otherBuyer = createTestIdentity();
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(otherBuyer, sellerIdentity),
      );

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(false);
      expect(store.getChannel(channelId)!.status).toBe('settled');
    });

    it('keeps channel with unknown on-chain status', async () => {
      const channelId = makeChannelId(35);
      seedChannel(store, channelId, buyerIdentity, sellerIdentity);

      const mgr = makeFreshManager();
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { status: 99 }),
      );

      await mgr.validateHydratedChannels();

      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
    });
  });

  describe('settleSession idle-settle skip logic', () => {
    async function seedAcceptedAuth(
      mgr: SellerPaymentManager,
      channelId: string,
      cumulativeAmount: bigint,
    ): Promise<void> {
      const reserve = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { isReserve: true });
      await mgr.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);
      const spend = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount });
      await mgr.handleSpendingAuth(buyerIdentity.peerId, spend, mux);
    }

    it('skips idle settle when localAmount equals on-chain settled (stale re-settle)', async () => {
      const channelId = makeChannelId(50);
      await seedAcceptedAuth(manager, channelId, 100_000n);

      vi.spyOn(manager.channelsClient, 'getSession').mockResolvedValue(
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 100_000n }),
      );
      const settleSpy = vi.spyOn(manager.channelsClient, 'settle').mockResolvedValue('0xsettle-hash');

      await manager.settleSession(buyerIdentity.peerId, { settleOnly: true });

      expect(manager.channelsClient.getSession).toHaveBeenCalledWith(channelId);
      expect(settleSpy).not.toHaveBeenCalled();
      // Channel stays alive so the buyer can resume
      expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    });

    it('skips idle settle when delta is below minSettleDelta', async () => {
      const channelId = makeChannelId(51);
      const customConfig: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
        minSettleDelta: '5000',
      };
      const mgr = new SellerPaymentManager(sellerIdentity, customConfig, store);
      vi.spyOn(mgr.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');

      await seedAcceptedAuth(mgr, channelId, 104_000n);
      const getSessionSpy = vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        // delta = 104000 - 100000 = 4000 < 5000 → skip
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 100_000n }),
      );
      const settleSpy = vi.spyOn(mgr.channelsClient, 'settle').mockResolvedValue('0xsettle-hash');

      await mgr.settleSession(buyerIdentity.peerId, { settleOnly: true });
      // Second tick with no new requests: cache must short-circuit so we
      // don't burn an RPC every idle interval until the delta crosses the
      // threshold. Regression guard for the dust-skip caching gap.
      await mgr.settleSession(buyerIdentity.peerId, { settleOnly: true });

      expect(settleSpy).not.toHaveBeenCalled();
      expect(getSessionSpy).toHaveBeenCalledOnce();
      expect(mgr.hasSession(buyerIdentity.peerId)).toBe(true);
    });

    it('proceeds with idle settle when delta is at or above minSettleDelta', async () => {
      const channelId = makeChannelId(52);
      const customConfig: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
        minSettleDelta: '5000',
      };
      const mgr = new SellerPaymentManager(sellerIdentity, customConfig, store);
      vi.spyOn(mgr.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');

      await seedAcceptedAuth(mgr, channelId, 105_000n);
      vi.spyOn(mgr.channelsClient, 'getSession').mockResolvedValue(
        // delta = 105000 - 100000 = 5000 == min → settle proceeds
        makeOnChainChannel(buyerIdentity, sellerIdentity, { settled: 100_000n }),
      );
      const settleSpy = vi.spyOn(mgr.channelsClient, 'settle').mockResolvedValue('0xsettle-hash');

      await mgr.settleSession(buyerIdentity.peerId, { settleOnly: true });

      expect(settleSpy).toHaveBeenCalledOnce();
      const [, calledChannelId, calledAmount] = settleSpy.mock.calls[0]!;
      expect(calledChannelId).toBe(channelId);
      expect(calledAmount).toBe(105_000n);
    });

    it('close path ignores minSettleDelta and still settles tiny deltas', async () => {
      const channelId = makeChannelId(53);
      const customConfig: SellerPaymentConfig = {
        rpcUrl: 'http://127.0.0.1:8545',
        channelsContractAddress: CONTRACT_ADDR,
        chainId: CHAIN_ID,
        dataDir: tempDir,
        minSettleDelta: '1000000', // absurdly high
      };
      const mgr = new SellerPaymentManager(sellerIdentity, customConfig, store);
      vi.spyOn(mgr.channelsClient, 'reserve').mockResolvedValue('0xreserve-hash');
      const closeSpy = vi.spyOn(mgr.channelsClient, 'close').mockResolvedValue('0xclose-hash');
      const getSessionSpy = vi.spyOn(mgr.channelsClient, 'getSession');

      await seedAcceptedAuth(mgr, channelId, 101_000n);

      // Not settleOnly — close path
      await mgr.settleSession(buyerIdentity.peerId, {});

      expect(closeSpy).toHaveBeenCalledOnce();
      // close path never consults on-chain state for the dust check
      expect(getSessionSpy).not.toHaveBeenCalled();
    });
  });
});

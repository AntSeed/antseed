import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet, AbiCoder } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
} from '../src/types/protocol.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';

const enc = new TextEncoder();

const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

const TEST_PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };

const SAMPLE_INPUT = enc.encode('What is the capital of France? Provide historical context.');
const SAMPLE_OUTPUT = enc.encode('The capital of France is Paris, on the Seine River, capital since the 10th century.');

function decodeMetadataTokens(metadata: string): { inputTokens: bigint; outputTokens: bigint } {
  const coder = AbiCoder.defaultAbiCoder();
  const [, inputTokens, outputTokens] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256', 'uint256'], metadata);
  return { inputTokens, outputTokens };
}

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

describe('Cumulative SpendingAuth Integration', () => {
  let buyerTempDir: string;
  let buyerIdentity: Identity;
  let sellerIdentity: Identity;
  let buyerManager: BuyerPaymentManager;
  let buyerStore: ChannelStore;

  beforeEach(async () => {
    buyerTempDir = mkdtempSync(join(tmpdir(), 'cumulative-buyer-'));
    buyerIdentity = createTestIdentity();
    sellerIdentity = createTestIdentity();

    const buyerConfig: BuyerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: CONTRACT_ADDR,
      channelsContractAddress: CONTRACT_ADDR,
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n,
      maxReserveAmountUsdc: 10_000_000n,
      dataDir: buyerTempDir,
    };
    buyerStore = new ChannelStore(buyerTempDir);
    buyerManager = new BuyerPaymentManager(buyerIdentity, buyerConfig, buyerStore);
    buyerManager.setSigner(buyerIdentity.wallet);
  });

  afterEach(() => {
    buyerStore.close();
    rmSync(buyerTempDir, { recursive: true, force: true });
  });

  it('cumulative amount increases across multiple requests within a session', async () => {
    const sentAuths: SpendingAuthPayload[] = [];
    const mux = {
      sendSpendingAuth(p: SpendingAuthPayload) { sentAuths.push(p); },
      sendAuthAck() {},
      sendPaymentRequired() {},
      sendNeedAuth() {},
      onSpendingAuth() {},
      onAuthAck() {},
      onPaymentRequired() {},
      onNeedAuth() {},
      handleFrame: vi.fn(),
    } as unknown as PaymentMux;

    const channelId = await buyerManager.authorizeSpending(
      sellerIdentity.peerId,
      mux,
      10_000n,
      TEST_PRICING,
    );
    expect(sentAuths.length).toBe(1);
    expect(sentAuths[0].cumulativeAmount).toBe('10000');

    buyerManager.handleAuthAck(sellerIdentity.peerId, { channelId });
    expect(buyerManager.isAuthorized(sellerIdentity.peerId)).toBe(true);

    const { payload: auth1 } = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 3_000n },
    );
    expect(BigInt(auth1.cumulativeAmount)).toBeGreaterThan(10_000n);
    const meta1 = decodeMetadataTokens(auth1.metadata);
    expect(meta1.inputTokens).toBeGreaterThan(0n);
    expect(meta1.outputTokens).toBeGreaterThan(0n);
    expect(auth1.channelId).toBe(channelId);
    const firstInput = meta1.inputTokens;
    const firstOutput = meta1.outputTokens;

    const { payload: auth2 } = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 4_000n },
    );
    expect(BigInt(auth2.cumulativeAmount)).toBeGreaterThan(BigInt(auth1.cumulativeAmount));
    const meta2 = decodeMetadataTokens(auth2.metadata);
    expect(meta2.inputTokens).toBe(firstInput * 2n);
    expect(meta2.outputTokens).toBe(firstOutput * 2n);

    const { payload: auth3 } = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 2_000n },
    );
    expect(BigInt(auth3.cumulativeAmount)).toBeGreaterThan(BigInt(auth2.cumulativeAmount));
    const meta3 = decodeMetadataTokens(auth3.metadata);
    expect(meta3.inputTokens).toBe(firstInput * 3n);
    expect(meta3.outputTokens).toBe(firstOutput * 3n);

    expect(auth1.channelId).toBe(channelId);
    expect(auth2.channelId).toBe(channelId);
    expect(auth3.channelId).toBe(channelId);

    expect(BigInt(auth1.cumulativeAmount)).toBeLessThan(BigInt(auth2.cumulativeAmount));
    expect(BigInt(auth2.cumulativeAmount)).toBeLessThan(BigInt(auth3.cumulativeAmount));
  });

  it('NeedAuth triggers cumulative amount increase mid-session', async () => {
    const sentAuths: SpendingAuthPayload[] = [];
    const mux = {
      sendSpendingAuth(p: SpendingAuthPayload) { sentAuths.push(p); },
      sendAuthAck() {},
      sendPaymentRequired() {},
      sendNeedAuth() {},
      onSpendingAuth() {},
      onAuthAck() {},
      onPaymentRequired() {},
      onNeedAuth() {},
      handleFrame: vi.fn(),
    } as unknown as PaymentMux;

    const channelId = await buyerManager.authorizeSpending(
      sellerIdentity.peerId,
      mux,
      10_000n,
      TEST_PRICING,
    );
    expect(sentAuths.length).toBe(1);

    // maxSignable = verifiedCost(0) + maxPerRequestUsdc(100_000) = 100_000
    await buyerManager.handleNeedAuth(
      sellerIdentity.peerId,
      {
        channelId,
        requiredCumulativeAmount: '100000',
        currentAcceptedCumulative: '10000',
        deposit: '1000000',
      },
      mux,
    );

    expect(sentAuths.length).toBe(2);
    const updatedAuth = sentAuths[1];
    expect(updatedAuth.cumulativeAmount).toBe('100000');
    expect(updatedAuth.channelId).toBe(channelId);

    const { payload: auth } = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 5_000n },
    );
    expect(BigInt(auth.cumulativeAmount)).toBeGreaterThan(100_000n);
  });

  it('cumulative state persists across manager restarts', async () => {
    const sentAuths: SpendingAuthPayload[] = [];
    const mux = {
      sendSpendingAuth(p: SpendingAuthPayload) { sentAuths.push(p); },
      sendAuthAck() {},
      sendPaymentRequired() {},
      sendNeedAuth() {},
      onSpendingAuth() {},
      onAuthAck() {},
      onPaymentRequired() {},
      onNeedAuth() {},
      handleFrame: vi.fn(),
    } as unknown as PaymentMux;

    const channelId = await buyerManager.authorizeSpending(
      sellerIdentity.peerId,
      mux,
      10_000n,
      TEST_PRICING,
    );

    buyerManager.handleAuthAck(sellerIdentity.peerId, { channelId });

    const { payload: auth } = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      { inputBytes: SAMPLE_INPUT, outputBytes: SAMPLE_OUTPUT, sellerClaimedCost: 5_000n },
    );

    expect(BigInt(auth.cumulativeAmount)).toBeGreaterThan(10_000n);
    const authMeta = decodeMetadataTokens(auth.metadata);
    expect(authMeta.inputTokens).toBeGreaterThan(0n);
    expect(authMeta.outputTokens).toBeGreaterThan(0n);
    expect(auth.channelId).toBe(channelId);

    // recordAndPersistTokens is now the sole writer for token fields
    const estimatedInputTokens = Math.ceil(SAMPLE_INPUT.length / 4);
    const estimatedOutputTokens = Math.ceil(SAMPLE_OUTPUT.length / 4);
    buyerManager.recordAndPersistTokens(sellerIdentity.peerId, estimatedInputTokens, estimatedOutputTokens);

    buyerStore.close();

    const newStore = new ChannelStore(buyerTempDir);
    const newConfig: BuyerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: CONTRACT_ADDR,
      channelsContractAddress: CONTRACT_ADDR,
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n,
      maxReserveAmountUsdc: 10_000_000n,
      dataDir: buyerTempDir,
    };
    const newManager = new BuyerPaymentManager(buyerIdentity, newConfig, newStore);
    newManager.setSigner(buyerIdentity.wallet);

    const session = newStore.getChannel(channelId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    expect(BigInt(session!.tokensDelivered)).toBeGreaterThan(0n);

    buyerStore = newStore;
  });
});

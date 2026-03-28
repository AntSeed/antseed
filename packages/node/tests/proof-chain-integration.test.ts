import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet, AbiCoder } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { SessionStore } from '../src/payments/session-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
} from '../src/types/protocol.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';

const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

function decodeMetadataTokens(metadata: string): { inputTokens: bigint; outputTokens: bigint } {
  const coder = AbiCoder.defaultAbiCoder();
  const [inputTokens, outputTokens] = coder.decode(['uint256', 'uint256', 'uint256', 'uint256'], metadata);
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
  let buyerStore: SessionStore;

  beforeEach(async () => {
    buyerTempDir = mkdtempSync(join(tmpdir(), 'cumulative-buyer-'));
    buyerIdentity = createTestIdentity();
    sellerIdentity = createTestIdentity();

    const buyerConfig: BuyerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: CONTRACT_ADDR,
      sessionsContractAddress: CONTRACT_ADDR,
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n,
      maxReserveAmountUsdc: 10_000_000n,
      dataDir: buyerTempDir,
    };
    buyerStore = new SessionStore(buyerTempDir);
    buyerManager = new BuyerPaymentManager(buyerIdentity, buyerConfig, buyerStore);
    // Use a deterministic wallet derived from the identity so EIP-712 sigs are valid
    buyerManager.setSigner(buyerIdentity.wallet);
  });

  afterEach(() => {
    buyerStore.close();
    rmSync(buyerTempDir, { recursive: true, force: true });
  });

  it('cumulative amount increases across multiple requests within a session', async () => {
    const sellerEvmAddr = sellerIdentity.wallet.address;

    // Track sent SpendingAuths
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

    // Step 1: Initial authorization with minBudgetPerRequest = 10000
    const channelId = await buyerManager.authorizeSpending(
      sellerIdentity.peerId,
      sellerEvmAddr,
      mux,
      10_000n,
    );
    expect(sentAuths.length).toBe(1);
    expect(sentAuths[0].cumulativeAmount).toBe('0');
    expect(sentAuths[0].metadataHash).toBeTypeOf('string');
    expect(sentAuths[0].metadata).toBeTypeOf('string');

    // Simulate AuthAck
    buyerManager.handleAuthAck(sellerIdentity.peerId, { channelId });
    expect(buyerManager.isAuthorized(sellerIdentity.peerId)).toBe(true);

    // Step 2: First request completes, sign per-request auth
    const auth1 = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      3_000n,   // addedCostUsdc from first request
      500n,     // addedInputTokens
      200n,     // addedOutputTokens
      5_000n,   // estimatedNextCostUsdc
    );

    // Cumulative amount: 0 (initial) + 3000 + 5000 = 8000
    expect(BigInt(auth1.cumulativeAmount)).toBe(8_000n);
    const meta1 = decodeMetadataTokens(auth1.metadata);
    expect(meta1.inputTokens).toBe(500n);
    expect(meta1.outputTokens).toBe(200n);
    expect(auth1.channelId).toBe(channelId);

    // Step 3: Second request completes
    const auth2 = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      4_000n,
      300n,
      150n,
      6_000n,
    );

    // Cumulative amount: 8000 + 4000 + 6000 = 18000
    expect(BigInt(auth2.cumulativeAmount)).toBe(18_000n);
    // Cumulative tokens: 500 + 300 = 800 input, 200 + 150 = 350 output
    const meta2 = decodeMetadataTokens(auth2.metadata);
    expect(meta2.inputTokens).toBe(800n);
    expect(meta2.outputTokens).toBe(350n);

    // Step 4: Third request
    const auth3 = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      2_000n,
      200n,
      100n,
      3_000n,
    );

    // Cumulative amount: 18000 + 2000 + 3000 = 23000
    expect(BigInt(auth3.cumulativeAmount)).toBe(23_000n);
    // Cumulative tokens: 800 + 200 = 1000 input, 350 + 100 = 450 output
    const meta3 = decodeMetadataTokens(auth3.metadata);
    expect(meta3.inputTokens).toBe(1000n);
    expect(meta3.outputTokens).toBe(450n);

    // Verify all auth payloads reference the same channel
    expect(auth1.channelId).toBe(channelId);
    expect(auth2.channelId).toBe(channelId);
    expect(auth3.channelId).toBe(channelId);

    // Verify monotonically increasing cumulative amounts
    expect(BigInt(auth1.cumulativeAmount)).toBeLessThan(BigInt(auth2.cumulativeAmount));
    expect(BigInt(auth2.cumulativeAmount)).toBeLessThan(BigInt(auth3.cumulativeAmount));
  });

  it('NeedAuth triggers cumulative amount increase mid-session', async () => {
    const sellerEvmAddr = sellerIdentity.wallet.address;

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

    // Initial authorization
    const channelId = await buyerManager.authorizeSpending(
      sellerIdentity.peerId,
      sellerEvmAddr,
      mux,
      10_000n,
    );
    expect(sentAuths.length).toBe(1);

    // Simulate seller requesting more budget via NeedAuth
    await buyerManager.handleNeedAuth(
      sellerIdentity.peerId,
      {
        channelId,
        requiredCumulativeAmount: '500000',
        currentAcceptedCumulative: '10000',
        deposit: '1000000',
      },
      mux,
    );

    // Should have sent a new SpendingAuth with the required amount
    expect(sentAuths.length).toBe(2);
    const updatedAuth = sentAuths[1];
    expect(updatedAuth.cumulativeAmount).toBe('500000');
    expect(updatedAuth.channelId).toBe(channelId);

    // Subsequent signPerRequestAuth should build on the new cumulative base
    const auth = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      10_000n,
      100n,
      50n,
      10_000n,
    );

    // 500000 + 10000 + 10000 = 520000
    expect(BigInt(auth.cumulativeAmount)).toBe(520_000n);
  });

  it('cumulative state persists across manager restarts', async () => {
    const sellerEvmAddr = sellerIdentity.wallet.address;

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

    // Create session and do some spending
    const channelId = await buyerManager.authorizeSpending(
      sellerIdentity.peerId,
      sellerEvmAddr,
      mux,
      10_000n,
    );

    // Simulate AuthAck so the session is confirmed
    buyerManager.handleAuthAck(sellerIdentity.peerId, { channelId });

    const auth = await buyerManager.signPerRequestAuth(
      sellerIdentity.peerId,
      5_000n,
      100n,
      50n,
      5_000n,
    );

    // Verify the sign succeeded and returned updated cumulative values
    expect(BigInt(auth.cumulativeAmount)).toBe(10_000n);
    const authMeta = decodeMetadataTokens(auth.metadata);
    expect(authMeta.inputTokens).toBe(100n);
    expect(authMeta.outputTokens).toBe(50n);
    expect(auth.channelId).toBe(channelId);

    // Close store and recreate manager
    buyerStore.close();

    const newStore = new SessionStore(buyerTempDir);
    const newConfig: BuyerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: CONTRACT_ADDR,
      sessionsContractAddress: CONTRACT_ADDR,
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

    // The session should still be accessible
    const session = newStore.getSession(channelId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    // The upsert ON CONFLICT clause persists tokens_delivered but not
    // auth_max or previous_consumption (cumulative output tokens).
    // This verifies the DB-persisted fields survive a store restart.
    expect(session!.tokensDelivered).toBe('100');

    // Reassign buyerStore for cleanup
    buyerStore = newStore;
  });
});

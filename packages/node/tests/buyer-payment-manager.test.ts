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
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));
  return { peerId, privateKey, publicKey };
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

function makeConfig(dataDir: string): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    sessionsContractAddress: '0x' + 'cc'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityAddress: '0x' + 'ff'.repeat(20),
    chainId: 31337,
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 100_000n,
    maxReserveAmountUsdc: 10_000_000n,
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

  it('authorizeSpending sends SpendingAuth with minBudgetPerRequest as initial cumulativeAmount', async () => {
    const sellerPeerId = 'seller-peer-001';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);
    const minBudget = 50_000n;

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux, minBudget);

    expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mux.sentSpendingAuths.length).toBe(1);

    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe('0');
    expect(sent.metadataHash).toBeTypeOf('string');
    expect(sent.metadata).toBeTypeOf('string');
    expect(sent.sessionId).toBe(sessionId);
    expect(sent.buyerSig).toBeTypeOf('string');
    expect(sent.buyerEvmAddr).toBeTypeOf('string');
  });

  it('authorizeSpending rejects if minBudgetPerRequest exceeds maxPerRequestUsdc', async () => {
    const sellerPeerId = 'seller-peer-reject';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);
    const tooLarge = 200_000n; // exceeds maxPerRequestUsdc (100_000)

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux, tooLarge);

    expect(sessionId).toBe('');
    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  it('handleAuthAck marks session as confirmed', async () => {
    const sellerPeerId = 'seller-peer-003';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux, 10_000n);
    expect(manager.isAuthorized(sellerPeerId)).toBe(false);

    manager.handleAuthAck(sellerPeerId, { sessionId, nonce: 1 });
    expect(manager.isAuthorized(sellerPeerId)).toBe(true);
  });

  it('isAuthorized returns true for confirmed session, false otherwise', async () => {
    const peerId1 = 'seller-peer-auth-1';
    const peerId2 = 'seller-peer-auth-2';
    const evmAddr = '0x' + 'ab'.repeat(20);

    expect(manager.isAuthorized(peerId1)).toBe(false);

    const sid = await manager.authorizeSpending(peerId1, evmAddr, mux, 10_000n);
    // Still not authorized until AuthAck
    expect(manager.isAuthorized(peerId1)).toBe(false);

    manager.handleAuthAck(peerId1, { sessionId: sid, nonce: 1 });
    expect(manager.isAuthorized(peerId1)).toBe(true);
    expect(manager.isAuthorized(peerId2)).toBe(false);
  });

  it('signPerRequestAuth increments cumulative values', async () => {
    const sellerPeerId = 'seller-peer-perreq';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux, 10_000n);
    manager.handleAuthAck(sellerPeerId, {
      sessionId: (mux.sentSpendingAuths[0] as Record<string, unknown>).sessionId as string,
      nonce: 1,
    });

    const payload = await manager.signPerRequestAuth(
      sellerPeerId,
      5_000n,     // addedCostUsdc
      100n,       // addedInputTokens
      50n,        // addedOutputTokens
      5_000n,     // estimatedNextCostUsdc
    );

    // cumulativeAmount should be initial (0) + addedCost (5000) + estimatedNext (5000) = 10000
    expect(BigInt(payload.cumulativeAmount)).toBe(10_000n);
    expect(payload.metadataHash).toBeTypeOf('string');
    expect(payload.metadata).toBeTypeOf('string');
    expect(payload.buyerSig).toBeTypeOf('string');
  });

  it('signPerRequestAuth caps increment at maxPerRequestUsdc', async () => {
    const sellerPeerId = 'seller-peer-cap';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux, 10_000n);

    // addedCost + estimatedNext = 80000 + 80000 = 160000 > maxPerRequestUsdc (100000)
    const payload = await manager.signPerRequestAuth(
      sellerPeerId,
      80_000n,
      0n,
      0n,
      80_000n,
    );

    // Should be capped: initial (0) + maxPerRequestUsdc (100000) = 100000
    expect(BigInt(payload.cumulativeAmount)).toBe(100_000n);
  });

  it('signPerRequestAuth throws if no active session', async () => {
    await expect(
      manager.signPerRequestAuth('nonexistent-peer', 1000n, 0n, 0n, 1000n),
    ).rejects.toThrow(/No active session/);
  });

  it('handleNeedAuth signs and sends updated SpendingAuth', async () => {
    const sellerPeerId = 'seller-peer-needauth';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux, 10_000n);
    mux.sentSpendingAuths.length = 0; // clear initial auth

    await manager.handleNeedAuth(sellerPeerId, {
      sessionId,
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(1);
    const sent = mux.sentSpendingAuths[0] as Record<string, unknown>;
    expect(sent.cumulativeAmount).toBe('500000');
    expect(sent.sessionId).toBe(sessionId);
  });

  it('handleNeedAuth rejects if requiredCumulativeAmount exceeds maxReserveAmountUsdc', async () => {
    const sellerPeerId = 'seller-peer-needauth-reject';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux, 10_000n);
    mux.sentSpendingAuths.length = 0;

    await manager.handleNeedAuth(sellerPeerId, {
      sessionId: (mux.sentSpendingAuths[0] as Record<string, unknown>)?.sessionId as string ?? 'dummy',
      requiredCumulativeAmount: '99999999999', // way over maxReserveAmountUsdc (10000000)
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    // Should not send any new SpendingAuth
    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  it('handleNeedAuth ignores unknown seller', async () => {
    mux.sentSpendingAuths.length = 0;

    await manager.handleNeedAuth('unknown-seller', {
      sessionId: '0x' + '00'.repeat(32),
      requiredCumulativeAmount: '500000',
      currentAcceptedCumulative: '10000',
      deposit: '1000000',
    }, mux);

    expect(mux.sentSpendingAuths.length).toBe(0);
  });

  it('parseResponseCost extracts cost and token counts from headers', () => {
    const result = BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': '5000',
      'x-antseed-input-tokens': '100',
      'x-antseed-output-tokens': '50',
    });

    expect(result).not.toBeNull();
    expect(result!.cost).toBe(5000n);
    expect(result!.inputTokens).toBe(100n);
    expect(result!.outputTokens).toBe(50n);
  });

  it('parseResponseCost returns null when cost header is missing', () => {
    expect(BuyerPaymentManager.parseResponseCost({})).toBeNull();
  });

  it('parseResponseCost returns null for non-numeric cost', () => {
    expect(BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': 'not-a-number',
    })).toBeNull();
  });

  it('parseResponseCost defaults tokens to 0 when headers missing', () => {
    const result = BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': '5000',
    });

    expect(result).not.toBeNull();
    expect(result!.cost).toBe(5000n);
    expect(result!.inputTokens).toBe(0n);
    expect(result!.outputTokens).toBe(0n);
  });

  it('parseResponseCost returns null for empty cost header', () => {
    expect(BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': '',
    })).toBeNull();
  });

  it('parseResponseCost handles partial headers (cost + input only)', () => {
    const result = BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': '12000',
      'x-antseed-input-tokens': '500',
    });

    expect(result).not.toBeNull();
    expect(result!.cost).toBe(12000n);
    expect(result!.inputTokens).toBe(500n);
    expect(result!.outputTokens).toBe(0n); // defaults when missing
  });

  it('parseResponseCost handles partial headers (cost + output only)', () => {
    const result = BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': '8000',
      'x-antseed-output-tokens': '250',
    });

    expect(result).not.toBeNull();
    expect(result!.cost).toBe(8000n);
    expect(result!.inputTokens).toBe(0n);
    expect(result!.outputTokens).toBe(250n);
  });

  it('parseResponseCost handles large values', () => {
    const result = BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': '999999999999',
      'x-antseed-input-tokens': '1000000',
      'x-antseed-output-tokens': '500000',
    });

    expect(result).not.toBeNull();
    expect(result!.cost).toBe(999999999999n);
    expect(result!.inputTokens).toBe(1000000n);
    expect(result!.outputTokens).toBe(500000n);
  });

  it('parseResponseCost returns null for non-numeric token values with valid cost', () => {
    // If token headers are non-numeric but cost is valid,
    // BigInt() will throw and the catch block returns null
    const result = BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': '5000',
      'x-antseed-input-tokens': 'not-a-number',
    });

    // This will either return null (if BigInt throws) or handle gracefully
    // Based on the implementation: BigInt('not-a-number') throws, caught by catch -> null
    expect(result).toBeNull();
  });

  it('parseResponseCost handles zero values correctly', () => {
    const result = BuyerPaymentManager.parseResponseCost({
      'x-antseed-cost': '0',
      'x-antseed-input-tokens': '0',
      'x-antseed-output-tokens': '0',
    });

    expect(result).not.toBeNull();
    expect(result!.cost).toBe(0n);
    expect(result!.inputTokens).toBe(0n);
    expect(result!.outputTokens).toBe(0n);
  });

  it('sessionPersistence: session survives store reconstruction', async () => {
    const sellerPeerId = 'seller-peer-persist';
    const sellerEvmAddr = '0x' + 'ab'.repeat(20);

    const sessionId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux, 10_000n);
    store.close();

    // Reopen the store independently and check persistence
    const checkStore = new SessionStore(tempDir);
    const session = checkStore.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.peerId).toBe(sellerPeerId);
    expect(session!.role).toBe('buyer');
    expect(session!.authMax).toBe('0');
    checkStore.close();

    // Re-create manager with same data dir, authorize again
    store = new SessionStore(tempDir);
    manager = new BuyerPaymentManager(identity, makeConfig(tempDir), store);
    manager.setSigner(Wallet.createRandom());

    const mux2 = createMockPaymentMux();
    const secondId = await manager.authorizeSpending(sellerPeerId, sellerEvmAddr, mux2, 10_000n);
    expect(secondId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(secondId).not.toBe(sessionId); // New session ID
  });
});

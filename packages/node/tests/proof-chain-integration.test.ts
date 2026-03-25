import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { Wallet } from 'ethers';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { SessionStore } from '../src/payments/session-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  SellerReceiptPayload,
  BuyerAckPayload,
  TopUpRequestPayload,
} from '../src/types/protocol.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { identityToEvmAddress } from '../src/payments/evm/keypair.js';

const ZERO_SESSION_ID = '0x' + '0'.repeat(64);
const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));
  return { peerId, privateKey, publicKey };
}

/**
 * Creates a pair of cross-wired mock muxes.
 * When buyer mux sends a SpendingAuth, it triggers seller's onSpendingAuth handler, etc.
 */
function createCrossWiredMuxes() {
  const buyerHandlers: Record<string, (...args: unknown[]) => void> = {};
  const sellerHandlers: Record<string, (...args: unknown[]) => void> = {};

  const buyerMux = {
    // Buyer sends, seller receives
    sendSpendingAuth(payload: SpendingAuthPayload) {
      sellerHandlers['spendingAuth']?.(payload);
    },
    sendBuyerAck(payload: BuyerAckPayload) {
      sellerHandlers['buyerAck']?.(payload);
    },
    // Buyer receives
    onAuthAck(handler: (p: AuthAckPayload) => void) {
      buyerHandlers['authAck'] = handler as (...args: unknown[]) => void;
    },
    onSellerReceipt(handler: (p: SellerReceiptPayload) => void) {
      buyerHandlers['sellerReceipt'] = handler as (...args: unknown[]) => void;
    },
    onTopUpRequest(handler: (p: TopUpRequestPayload) => void) {
      buyerHandlers['topUpRequest'] = handler as (...args: unknown[]) => void;
    },
    // Unused on buyer side
    onSpendingAuth() {},
    onBuyerAck() {},
    sendAuthAck() {},
    sendSellerReceipt() {},
    sendTopUpRequest() {},
    handleFrame: vi.fn(),
  };

  const sellerMux = {
    // Seller sends, buyer receives
    sendAuthAck(payload: AuthAckPayload) {
      buyerHandlers['authAck']?.(payload);
    },
    sendSellerReceipt(payload: SellerReceiptPayload) {
      buyerHandlers['sellerReceipt']?.(payload);
    },
    sendTopUpRequest(payload: TopUpRequestPayload) {
      buyerHandlers['topUpRequest']?.(payload);
    },
    // Seller receives
    onSpendingAuth(handler: (p: SpendingAuthPayload) => void) {
      sellerHandlers['spendingAuth'] = handler as (...args: unknown[]) => void;
    },
    onBuyerAck(handler: (p: BuyerAckPayload) => void) {
      sellerHandlers['buyerAck'] = handler as (...args: unknown[]) => void;
    },
    // Unused on seller side
    onAuthAck() {},
    onSellerReceipt() {},
    onTopUpRequest() {},
    sendSpendingAuth() {},
    sendBuyerAck() {},
    handleFrame: vi.fn(),
  };

  return {
    buyerMux: buyerMux as unknown as PaymentMux,
    sellerMux: sellerMux as unknown as PaymentMux,
    sellerHandlers,
    buyerHandlers,
  };
}

describe('Proof Chain Integration', () => {
  let buyerTempDir: string;
  let sellerTempDir: string;
  let buyerIdentity: Identity;
  let sellerIdentity: Identity;
  let buyerManager: BuyerPaymentManager;
  let sellerStore: SessionStore;
  let sellerManager: SellerPaymentManager;

  beforeEach(async () => {
    buyerTempDir = mkdtempSync(join(tmpdir(), 'proof-buyer-'));
    sellerTempDir = mkdtempSync(join(tmpdir(), 'proof-seller-'));
    buyerIdentity = await createTestIdentity();
    sellerIdentity = await createTestIdentity();

    const buyerConfig: BuyerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: CONTRACT_ADDR,
      sessionsContractAddress: CONTRACT_ADDR,
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityAddress: '0x' + 'ff'.repeat(20),
      chainId: CHAIN_ID,
      defaultMaxAmountUsdc: 1_000_000n,
      defaultAuthDurationSecs: 3600,
      autoAck: true,
      dataDir: buyerTempDir,
    };
    const buyerStore = new SessionStore(buyerTempDir);
    buyerManager = new BuyerPaymentManager(buyerIdentity, buyerConfig, buyerStore);
    // Use a deterministic wallet derived from the identity so EIP-712 sigs are valid
    const { identityToEvmWallet } = await import('../src/payments/evm/keypair.js');
    buyerManager.setSigner(identityToEvmWallet(buyerIdentity));

    sellerStore = new SessionStore(sellerTempDir);
    const sellerConfig: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      sessionsContractAddress: CONTRACT_ADDR,
      stakingContractAddress: '0x' + 'cc'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      chainId: CHAIN_ID,
      dataDir: sellerTempDir,
      settleTimeoutSecs: 60,
    };
    sellerManager = new SellerPaymentManager(sellerIdentity, sellerConfig, sellerStore);

    // Mock sessions and staking clients
    vi.spyOn(sellerManager.sessionsClient, 'reserve').mockResolvedValue('0xreserve');
    vi.spyOn(sellerManager.sessionsClient, 'settle').mockResolvedValue('0xsettle');
    vi.spyOn(sellerManager.sessionsClient, 'settleTimeout').mockResolvedValue('0xtimeout');
    vi.spyOn(sellerManager.stakingClient, 'getSellerAccount').mockResolvedValue({
      stake: 100000000n,
      stakedAt: BigInt(Date.now()),
      tokenRate: 1n,
    });
  });

  afterEach(() => {
    sellerStore.close();
    rmSync(buyerTempDir, { recursive: true, force: true });
    rmSync(sellerTempDir, { recursive: true, force: true });
  });

  it('full 3-session proof chain flow', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const sellerEvmAddr = identityToEvmAddress(sellerIdentity);

    // Helper: run one session cycle
    async function runSession(sessionNumber: number, expectedPrevConsumption: string, expectedPrevSessionId: string) {
      // Create fresh muxes for this "connection"
      // We won't use cross-wired muxes since buyer and seller managers handle
      // messages independently — we manually relay messages between them.
      const buyerSentAuths: SpendingAuthPayload[] = [];
      const buyerSentAcks: BuyerAckPayload[] = [];
      const sellerSentAuthAcks: AuthAckPayload[] = [];
      const sellerSentReceipts: SellerReceiptPayload[] = [];

      const buyerMux = {
        sendSpendingAuth(p: SpendingAuthPayload) { buyerSentAuths.push(p); },
        sendBuyerAck(p: BuyerAckPayload) { buyerSentAcks.push(p); },
        sendAuthAck() {},
        sendSellerReceipt() {},
        sendTopUpRequest() {},
        onSpendingAuth() {}, onAuthAck() {}, onSellerReceipt() {},
        onBuyerAck() {}, onTopUpRequest() {},
        handleFrame: vi.fn(),
      } as unknown as PaymentMux;

      const sellerMux = {
        sendAuthAck(p: AuthAckPayload) { sellerSentAuthAcks.push(p); },
        sendSellerReceipt(p: SellerReceiptPayload) { sellerSentReceipts.push(p); },
        sendTopUpRequest() {},
        sendSpendingAuth() {},
        sendBuyerAck() {},
        onSpendingAuth() {}, onAuthAck() {}, onSellerReceipt() {},
        onBuyerAck() {}, onTopUpRequest() {},
        handleFrame: vi.fn(),
      } as unknown as PaymentMux;

      // Step 1: Buyer creates SpendingAuth
      const sessionId = await buyerManager.authorizeSpending(
        sellerIdentity.peerId,
        sellerEvmAddr,
        buyerMux,
      );

      // Verify proof chain linkage
      const sentAuth = buyerSentAuths[0];
      expect(sentAuth.previousConsumption).toBe(expectedPrevConsumption);
      expect(sentAuth.previousSessionId).toBe(expectedPrevSessionId);

      // Step 2: Seller receives SpendingAuth, sends AuthAck
      await sellerManager.handleSpendingAuth(
        buyerIdentity.peerId,
        buyerEvmAddr,
        sentAuth,
        sellerMux,
      );
      expect(sellerSentAuthAcks.length).toBe(1);
      expect(sellerSentAuthAcks[0].sessionId).toBe(sessionId);

      // Step 3: Buyer receives AuthAck
      buyerManager.handleAuthAck(sellerIdentity.peerId, sellerSentAuthAcks[0]);
      expect(buyerManager.isAuthorized(sellerIdentity.peerId)).toBe(true);

      // Step 4: Seller sends 3 receipts, buyer acks each
      let totalTokens = 0n;
      for (let i = 1; i <= 3; i++) {
        const responseBody = new TextEncoder().encode(`response-${sessionNumber}-${i}`);
        const tokens = BigInt(100 * i); // 100, 200, 300
        totalTokens += tokens;

        await sellerManager.sendReceipt(
          buyerIdentity.peerId,
          sellerMux,
          responseBody,
          tokens,
        );

        expect(sellerSentReceipts.length).toBe(i);
        const receipt = sellerSentReceipts[i - 1];
        expect(receipt.requestCount).toBe(i);

        // Buyer processes receipt (auto-ack=true sends BuyerAck)
        await buyerManager.handleSellerReceipt(
          sellerIdentity.peerId,
          receipt,
          buyerMux,
        );
        expect(buyerSentAcks.length).toBe(i);

        // Seller processes ack
        await sellerManager.handleBuyerAck(buyerIdentity.peerId, buyerSentAcks[i - 1]);
      }

      return { sessionId, totalTokens: totalTokens.toString() };
    }

    // === Session 1: first session (no prior) ===
    const s1 = await runSession(1, '0', ZERO_SESSION_ID);

    // Buyer disconnects
    sellerManager.onBuyerDisconnect(buyerIdentity.peerId);
    expect(sellerManager.hasSession(buyerIdentity.peerId)).toBe(false);

    // === Session 2: references session 1 ===
    const s2 = await runSession(2, s1.totalTokens, s1.sessionId);

    // Verify session 1 was settled by seller during session 2 auth
    const session1 = sellerStore.getSession(s1.sessionId);
    expect(session1!.status).toBe('settled');

    // Buyer disconnects again
    sellerManager.onBuyerDisconnect(buyerIdentity.peerId);

    // === Session 3: references session 2 ===
    const s3 = await runSession(3, s2.totalTokens, s2.sessionId);

    // Verify session 2 was settled during session 3 auth
    const session2 = sellerStore.getSession(s2.sessionId);
    expect(session2!.status).toBe('settled');

    // Session 3 still active
    const session3 = sellerStore.getSession(s3.sessionId);
    expect(session3!.status).toBe('active');

    // === Verify full proof chain on buyer side ===
    const history = buyerManager.getSessionHistory(sellerIdentity.peerId);
    expect(history.length).toBe(3);
    expect(history[0].sessionId).toBe(s1.sessionId);
    expect(history[0].previousSessionId).toBe(ZERO_SESSION_ID);
    expect(history[1].sessionId).toBe(s2.sessionId);
    expect(history[1].previousSessionId).toBe(s1.sessionId);
    expect(history[2].sessionId).toBe(s3.sessionId);
    expect(history[2].previousSessionId).toBe(s2.sessionId);

    // Verify correct consumption chain
    expect(history[0].previousConsumption).toBe('0');
    expect(history[1].previousConsumption).toBe(s1.totalTokens);
    expect(history[2].previousConsumption).toBe(s2.totalTokens);

    // Verify on-chain interactions
    // reserve called 3 times (once per session)
    expect(sellerManager.sessionsClient.reserve).toHaveBeenCalledTimes(3);
    // settle called 2 times (session 1 settled before session 2, session 2 before session 3)
    expect(sellerManager.sessionsClient.settle).toHaveBeenCalledTimes(2);
  });
});

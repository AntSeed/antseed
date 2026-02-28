import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type {
  AuthAckPayload,
  SellerReceiptPayload,
  TopUpRequestPayload,
} from '../src/types/protocol.js';
import * as ed from '@noble/ed25519';

// --- Helpers ---

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey  = await ed.getPublicKeyAsync(privateKey);
  const peerId     = Array.from(publicKey)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { peerId: peerId as any, privateKey, publicKey };
}

function createMockPaymentMux(): PaymentMux & {
  _sentSpendingAuths: any[];
  _sentBuyerAcks: any[];
} {
  const mux = {
    _sentSpendingAuths: [] as any[],
    _sentBuyerAcks:     [] as any[],
    sendSpendingAuth: vi.fn(function (this: any, payload: any) {
      this._sentSpendingAuths.push(payload);
    }),
    sendBuyerAck: vi.fn(function (this: any, payload: any) {
      this._sentBuyerAcks.push(payload);
    }),
    // Unused send methods required by type
    sendAuthAck:      vi.fn(),
    sendSellerReceipt: vi.fn(),
    sendTopUpRequest: vi.fn(),
    // Handler registrations
    onSpendingAuth:  vi.fn(),
    onAuthAck:       vi.fn(),
    onSellerReceipt: vi.fn(),
    onBuyerAck:      vi.fn(),
    onTopUpRequest:  vi.fn(),
    handleFrame: vi.fn(),
  } as unknown as PaymentMux & {
    _sentSpendingAuths: any[];
    _sentBuyerAcks: any[];
  };
  return mux;
}

const DEFAULT_CONFIG: BuyerPaymentConfig = {
  chainId:              31337,
  defaultAuthAmountUsdc: 1_000_000n,
  rpcUrl:               'http://127.0.0.1:8545',
  contractAddress:      '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  usdcAddress:          '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  autoAck:              true,
  maxSessionBudgetUsdc: 10_000_000n,
};

const SELLER_PEER_ID    = 'seller-peer-0123456789abcdef';
const SELLER_EVM_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// --- Tests ---

describe('BuyerPaymentManager', () => {
  let identity: Identity;
  let manager:  BuyerPaymentManager;
  let mux:      ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    identity = await createTestIdentity();
    manager  = new BuyerPaymentManager(identity, DEFAULT_CONFIG);
    mux      = createMockPaymentMux();
  });

  describe('authorizeSpending', () => {
    it('sends SpendingAuth with correct session ID and amount', async () => {
      const sessionId = await manager.authorizeSpending(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(mux.sendSpendingAuth).toHaveBeenCalledTimes(1);

      const sentPayload = mux._sentSpendingAuths[0]!;
      expect(sentPayload.sessionId).toBe(sessionId);
      expect(sentPayload.maxAmountUsdc).toBe('1000000');
      expect(sentPayload.nonce).toBe(1);
      expect(typeof sentPayload.buyerSig).toBe('string');
      expect(sentPayload.buyerSig.length).toBeGreaterThan(0);

      // Session should start unauthorized
      const session = manager.getSession(SELLER_PEER_ID);
      expect(session).toBeDefined();
      expect(session!.authorized).toBe(false);
      expect(session!.authMax).toBe(1_000_000n);
    });

    it('uses custom auth amount when specified', async () => {
      await manager.authorizeSpending(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
        5_000_000n,
      );

      const sentPayload = mux._sentSpendingAuths[0]!;
      expect(sentPayload.maxAmountUsdc).toBe('5000000');

      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.authMax).toBe(5_000_000n);
    });
  });

  describe('handleAuthAck', () => {
    it('marks session as authorized', async () => {
      const sessionId = await manager.authorizeSpending(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      const payload: AuthAckPayload = { sessionId, nonce: 1 };
      manager.handleAuthAck(SELLER_PEER_ID, payload);

      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.authorized).toBe(true);
      expect(manager.isAuthorized(SELLER_PEER_ID)).toBe(true);
    });

    it('ignores ack for unknown seller', () => {
      // Should not throw
      manager.handleAuthAck('unknown-peer', {
        sessionId: '0x' + 'a'.repeat(64),
        nonce: 1,
      });
    });

    it('ignores ack with mismatched nonce', async () => {
      const sessionId = await manager.authorizeSpending(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      // Send ack with wrong nonce
      manager.handleAuthAck(SELLER_PEER_ID, { sessionId, nonce: 99 });

      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.authorized).toBe(false);
      expect(manager.isAuthorized(SELLER_PEER_ID)).toBe(false);
    });
  });

  describe('handleSellerReceipt (auto-ack)', () => {
    it('auto-acknowledges receipt with Ed25519 signature', async () => {
      const sessionId = await manager.authorizeSpending(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      manager.handleAuthAck(SELLER_PEER_ID, { sessionId, nonce: 1 });

      const receipt: SellerReceiptPayload = {
        sessionId,
        runningTotal: '50000',
        requestCount: 1,
        responseHash: 'c'.repeat(64),
        sellerSig:    'd'.repeat(128),
      };

      await manager.handleSellerReceipt(SELLER_PEER_ID, receipt, mux);

      expect(mux.sendBuyerAck).toHaveBeenCalledTimes(1);
      const ackPayload = mux._sentBuyerAcks[0]!;
      expect(ackPayload.sessionId).toBe(sessionId);
      expect(ackPayload.runningTotal).toBe('50000');
      expect(ackPayload.requestCount).toBe(1);
      expect(typeof ackPayload.buyerSig).toBe('string');
      expect(ackPayload.buyerSig.length).toBeGreaterThan(0);

      // Session should update spend counters
      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.totalSpend).toBe(50_000n);
      expect(session!.requestCount).toBe(1);
    });

    it('does not auto-ack when autoAck is false', async () => {
      const noAckManager = new BuyerPaymentManager(identity, {
        ...DEFAULT_CONFIG,
        autoAck: false,
      });

      const sessionId = await noAckManager.authorizeSpending(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      noAckManager.handleAuthAck(SELLER_PEER_ID, { sessionId, nonce: 1 });

      await noAckManager.handleSellerReceipt(SELLER_PEER_ID, {
        sessionId,
        runningTotal: '50000',
        requestCount: 1,
        responseHash: 'c'.repeat(64),
        sellerSig:    'd'.repeat(128),
      }, mux);

      expect(mux.sendBuyerAck).not.toHaveBeenCalled();
    });
  });

  describe('handleTopUpRequest (sufficient balance)', () => {
    it('sends new SpendingAuth with nonce+1 when budget allows', async () => {
      const sessionId = await manager.authorizeSpending(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      manager.handleAuthAck(SELLER_PEER_ID, { sessionId, nonce: 1 });

      // Mock the escrow client to return sufficient balance
      const mockGetBuyerBalance = vi.fn().mockResolvedValue({
        available:          19_000_000n,
        pendingWithdrawal:  0n,
        withdrawalReadyAt:  0,
      });
      (manager as any)._escrow = {
        ...manager.escrowClient,
        getBuyerBalance: mockGetBuyerBalance,
      };

      const request: TopUpRequestPayload = {
        sessionId,
        currentUsed:         '800000',
        currentMax:          '1000000',
        requestedAdditional: '2000000',
      };

      await manager.handleTopUpRequest(SELLER_PEER_ID, request, mux);

      // Should send a second SpendingAuth (top-up)
      expect(mux.sendSpendingAuth).toHaveBeenCalledTimes(2);
      const topUpPayload = mux._sentSpendingAuths[1]!;
      expect(topUpPayload.sessionId).toBe(sessionId);
      expect(topUpPayload.maxAmountUsdc).toBe('2000000');
      expect(topUpPayload.nonce).toBe(2); // nonce incremented
      expect(typeof topUpPayload.buyerSig).toBe('string');

      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.nonce).toBe(2);
      expect(session!.authMax).toBe(2_000_000n);
    });
  });

  describe('handleTopUpRequest (insufficient balance)', () => {
    it('does not send SpendingAuth when balance is insufficient', async () => {
      const sessionId = await manager.authorizeSpending(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      manager.handleAuthAck(SELLER_PEER_ID, { sessionId, nonce: 1 });

      // Mock insufficient balance
      const mockGetBuyerBalance = vi.fn().mockResolvedValue({
        available:         0n,
        pendingWithdrawal: 0n,
        withdrawalReadyAt: 0,
      });
      (manager as any)._escrow = {
        ...manager.escrowClient,
        getBuyerBalance: mockGetBuyerBalance,
      };

      const request: TopUpRequestPayload = {
        sessionId,
        currentUsed:         '800000',
        currentMax:          '1000000',
        requestedAdditional: '2000000',
      };

      await manager.handleTopUpRequest(SELLER_PEER_ID, request, mux);

      // Should NOT send a second SpendingAuth
      expect(mux.sendSpendingAuth).toHaveBeenCalledTimes(1); // only the original auth
    });
  });

  describe('onPeerDisconnect', () => {
    it('removes session on disconnect', async () => {
      await manager.authorizeSpending(SELLER_PEER_ID, SELLER_EVM_ADDRESS, mux);

      manager.onPeerDisconnect(SELLER_PEER_ID);

      expect(manager.getSession(SELLER_PEER_ID)).toBeUndefined();
      expect(manager.isAuthorized(SELLER_PEER_ID)).toBe(false);
    });
  });
});

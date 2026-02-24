import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type {
  SessionLockConfirmPayload,
  SessionLockRejectPayload,
  SellerReceiptPayload,
  TopUpRequestPayload,
} from '../src/types/protocol.js';
import * as ed from '@noble/ed25519';

// --- Helpers ---

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = Array.from(publicKey)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { peerId: peerId as any, privateKey, publicKey };
}

function createMockPaymentMux(): PaymentMux & {
  _sentLockAuths: any[];
  _sentBuyerAcks: any[];
  _sentSessionEnds: any[];
  _sentTopUpAuths: any[];
} {
  const mux = {
    _sentLockAuths: [] as any[],
    _sentBuyerAcks: [] as any[],
    _sentSessionEnds: [] as any[],
    _sentTopUpAuths: [] as any[],
    sendSessionLockAuth: vi.fn(function (this: any, payload: any) {
      this._sentLockAuths.push(payload);
    }),
    sendBuyerAck: vi.fn(function (this: any, payload: any) {
      this._sentBuyerAcks.push(payload);
    }),
    sendSessionEnd: vi.fn(function (this: any, payload: any) {
      this._sentSessionEnds.push(payload);
    }),
    sendTopUpAuth: vi.fn(function (this: any, payload: any) {
      this._sentTopUpAuths.push(payload);
    }),
    // Unused but required by type
    sendSessionLockConfirm: vi.fn(),
    sendSessionLockReject: vi.fn(),
    sendSellerReceipt: vi.fn(),
    sendTopUpRequest: vi.fn(),
    sendDisputeNotify: vi.fn(),
    onSessionLockAuth: vi.fn(),
    onSessionLockConfirm: vi.fn(),
    onSessionLockReject: vi.fn(),
    onSellerReceipt: vi.fn(),
    onBuyerAck: vi.fn(),
    onSessionEnd: vi.fn(),
    onTopUpRequest: vi.fn(),
    onTopUpAuth: vi.fn(),
    onDisputeNotify: vi.fn(),
    handleFrame: vi.fn(),
  } as unknown as PaymentMux & {
    _sentLockAuths: any[];
    _sentBuyerAcks: any[];
    _sentSessionEnds: any[];
    _sentTopUpAuths: any[];
  };
  return mux;
}

const DEFAULT_CONFIG: BuyerPaymentConfig = {
  defaultLockAmountUSDC: '1000000',
  rpcUrl: 'http://127.0.0.1:8545',
  contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  usdcAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  autoAck: true,
  autoTopUp: true,
  maxSessionBudgetUSDC: '10000000',
};

const SELLER_PEER_ID = 'seller-peer-0123456789abcdef';
const SELLER_EVM_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// --- Tests ---

describe('BuyerPaymentManager', () => {
  let identity: Identity;
  let manager: BuyerPaymentManager;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    identity = await createTestIdentity();
    manager = new BuyerPaymentManager(identity, DEFAULT_CONFIG);
    mux = createMockPaymentMux();
  });

  describe('initiateLock', () => {
    it('sends SessionLockAuth with correct session ID and amount', async () => {
      const sessionId = await manager.initiateLock(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(mux.sendSessionLockAuth).toHaveBeenCalledTimes(1);

      const sentPayload = mux._sentLockAuths[0]!;
      expect(sentPayload.sessionId).toBe(sessionId);
      expect(sentPayload.lockedAmount).toBe('1000000');
      expect(typeof sentPayload.buyerSig).toBe('string');
      expect(sentPayload.buyerSig.length).toBeGreaterThan(0);

      // Session should be in pending state
      const session = manager.getSession(SELLER_PEER_ID);
      expect(session).toBeDefined();
      expect(session!.status).toBe('pending');
      expect(session!.lockedAmount).toBe(1000000n);
    });

    it('uses custom lock amount when specified', async () => {
      await manager.initiateLock(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
        '5000000',
      );

      const sentPayload = mux._sentLockAuths[0]!;
      expect(sentPayload.lockedAmount).toBe('5000000');

      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.lockedAmount).toBe(5000000n);
    });
  });

  describe('handleLockConfirm', () => {
    it('marks session as confirmed with tx signature', async () => {
      const sessionId = await manager.initiateLock(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      const payload: SessionLockConfirmPayload = {
        sessionId,
        txSignature: '0xabc123def456',
      };

      manager.handleLockConfirm(SELLER_PEER_ID, payload);

      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.status).toBe('confirmed');
      expect(session!.txSignature).toBe('0xabc123def456');
      expect(manager.isLockConfirmed(SELLER_PEER_ID)).toBe(true);
    });

    it('ignores confirmation for unknown seller', () => {
      // Should not throw
      manager.handleLockConfirm('unknown-peer', {
        sessionId: '0x' + 'a'.repeat(64),
        txSignature: '0xabc',
      });
    });
  });

  describe('handleLockReject', () => {
    it('removes session on rejection', async () => {
      const sessionId = await manager.initiateLock(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      const payload: SessionLockRejectPayload = {
        sessionId,
        reason: 'Insufficient buyer balance',
      };

      manager.handleLockReject(SELLER_PEER_ID, payload);

      expect(manager.getSession(SELLER_PEER_ID)).toBeUndefined();
      expect(manager.isLockRejected(SELLER_PEER_ID)).toBe(true);
    });
  });

  describe('handleSellerReceipt (auto-ack)', () => {
    it('auto-acknowledges receipt with Ed25519 signature', async () => {
      const sessionId = await manager.initiateLock(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      // Confirm the lock first
      manager.handleLockConfirm(SELLER_PEER_ID, {
        sessionId,
        txSignature: '0xabc',
      });

      const receipt: SellerReceiptPayload = {
        sessionId,
        runningTotal: '50000',
        requestCount: 1,
        responseHash: 'c'.repeat(64),
        sellerSig: 'd'.repeat(128),
      };

      await manager.handleSellerReceipt(SELLER_PEER_ID, receipt, mux);

      expect(mux.sendBuyerAck).toHaveBeenCalledTimes(1);
      const ackPayload = mux._sentBuyerAcks[0]!;
      expect(ackPayload.sessionId).toBe(sessionId);
      expect(ackPayload.runningTotal).toBe('50000');
      expect(ackPayload.requestCount).toBe(1);
      expect(typeof ackPayload.buyerSig).toBe('string');
      expect(ackPayload.buyerSig.length).toBeGreaterThan(0);

      // Session should update running total
      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.lastRunningTotal).toBe(50000n);
      expect(session!.lastRequestCount).toBe(1);
      expect(session!.status).toBe('active');
    });
  });

  describe('endSession', () => {
    it('sends SessionEnd with ECDSA settlement signature', async () => {
      const sessionId = await manager.initiateLock(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      // Confirm and process a receipt
      manager.handleLockConfirm(SELLER_PEER_ID, {
        sessionId,
        txSignature: '0xabc',
      });

      await manager.handleSellerReceipt(SELLER_PEER_ID, {
        sessionId,
        runningTotal: '100000',
        requestCount: 3,
        responseHash: 'c'.repeat(64),
        sellerSig: 'd'.repeat(128),
      }, mux);

      await manager.endSession(SELLER_PEER_ID, mux, 90);

      expect(mux.sendSessionEnd).toHaveBeenCalledTimes(1);
      const endPayload = mux._sentSessionEnds[0]!;
      expect(endPayload.sessionId).toBe(sessionId);
      expect(endPayload.runningTotal).toBe('100000');
      expect(endPayload.requestCount).toBe(3);
      expect(endPayload.score).toBe(90);
      expect(typeof endPayload.buyerSig).toBe('string');
      expect(endPayload.buyerSig.length).toBeGreaterThan(0);

      // Session should be ended
      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.status).toBe('ended');
    });
  });

  describe('handleTopUpRequest (sufficient balance)', () => {
    it('auto-approves top-up when budget allows and balance sufficient', async () => {
      const sessionId = await manager.initiateLock(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      manager.handleLockConfirm(SELLER_PEER_ID, {
        sessionId,
        txSignature: '0xabc',
      });

      // Mock the escrow client to return sufficient balance
      const mockGetBuyerAccount = vi.fn().mockResolvedValue({
        deposited: 20000000n,
        committed: 1000000n,
        available: 19000000n,
      });
      (manager as any)._escrowClient = {
        ...manager.escrowClient,
        getBuyerAccount: mockGetBuyerAccount,
      };

      const request: TopUpRequestPayload = {
        sessionId,
        additionalAmount: '2000000',
        currentRunningTotal: '800000',
        currentLockedAmount: '1000000',
      };

      await manager.handleTopUpRequest(SELLER_PEER_ID, request, mux);

      expect(mux.sendTopUpAuth).toHaveBeenCalledTimes(1);
      const authPayload = mux._sentTopUpAuths[0]!;
      expect(authPayload.sessionId).toBe(sessionId);
      expect(authPayload.additionalAmount).toBe('2000000');
      expect(typeof authPayload.buyerSig).toBe('string');

      // Session locked amount should be updated
      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.lockedAmount).toBe(3000000n); // 1M + 2M
    });
  });

  describe('handleTopUpRequest (insufficient balance)', () => {
    it('ends session when balance is insufficient for top-up', async () => {
      const sessionId = await manager.initiateLock(
        SELLER_PEER_ID,
        SELLER_EVM_ADDRESS,
        mux,
      );

      manager.handleLockConfirm(SELLER_PEER_ID, {
        sessionId,
        txSignature: '0xabc',
      });

      // Mock the escrow client to return insufficient balance
      const mockGetBuyerAccount = vi.fn().mockResolvedValue({
        deposited: 1000000n,
        committed: 1000000n,
        available: 0n,
      });
      (manager as any)._escrowClient = {
        ...manager.escrowClient,
        getBuyerAccount: mockGetBuyerAccount,
      };

      const request: TopUpRequestPayload = {
        sessionId,
        additionalAmount: '2000000',
        currentRunningTotal: '800000',
        currentLockedAmount: '1000000',
      };

      await manager.handleTopUpRequest(SELLER_PEER_ID, request, mux);

      // Should NOT send top-up auth
      expect(mux.sendTopUpAuth).not.toHaveBeenCalled();

      // Should end the session instead
      expect(mux.sendSessionEnd).toHaveBeenCalledTimes(1);
      const endPayload = mux._sentSessionEnds[0]!;
      expect(endPayload.sessionId).toBe(sessionId);
      expect(endPayload.score).toBe(80); // default score

      const session = manager.getSession(SELLER_PEER_ID);
      expect(session!.status).toBe('ended');
    });
  });
});

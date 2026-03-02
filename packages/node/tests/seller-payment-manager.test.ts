import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ed from '@noble/ed25519';
import { Wallet, type AbstractSigner } from 'ethers';
import type { Identity } from '../src/p2p/identity.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { SpendingAuthPayload } from '../src/types/protocol.js';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { makeEscrowDomain, signSpendingAuth } from '../src/payments/evm/signatures.js';

const CONFIG: SellerPaymentConfig = {
  chainId: 31337,
  rpcUrl: 'http://127.0.0.1:8545',
  contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  usdcAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
};

const BUYER_PEER_ID = 'buyer-peer-0123456789abcdef';

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = Array.from(publicKey).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { peerId: peerId as any, privateKey, publicKey };
}

function createMockMux(): PaymentMux & { _acks: any[] } {
  const mux = {
    _acks: [] as any[],
    sendAuthAck: vi.fn(function (this: any, payload: any) {
      this._acks.push(payload);
    }),
    sendSpendingAuth: vi.fn(),
    sendSellerReceipt: vi.fn(),
    sendBuyerAck: vi.fn(),
    sendTopUpRequest: vi.fn(),
    onSpendingAuth: vi.fn(),
    onAuthAck: vi.fn(),
    onSellerReceipt: vi.fn(),
    onBuyerAck: vi.fn(),
    onTopUpRequest: vi.fn(),
    handleFrame: vi.fn(),
  } as unknown as PaymentMux & { _acks: any[] };
  return mux;
}

async function buildAuthPayload(
  sellerAddress: string,
  buyerWallet: AbstractSigner & { address: string },
  params: {
    sessionId: string;
    maxAmount: bigint;
    nonce: number;
    deadline: number;
  },
): Promise<SpendingAuthPayload> {
  const buyerSig = await signSpendingAuth(
    buyerWallet,
    makeEscrowDomain(CONFIG.chainId, CONFIG.contractAddress),
    {
      seller: sellerAddress,
      sessionId: params.sessionId,
      maxAmount: params.maxAmount,
      nonce: params.nonce,
      deadline: params.deadline,
    },
  );

  return {
    sessionId: params.sessionId,
    maxAmountUsdc: params.maxAmount.toString(),
    nonce: params.nonce,
    deadline: params.deadline,
    buyerSig,
    buyerEvmAddr: buyerWallet.address,
  };
}

describe('SellerPaymentManager', () => {
  let manager: SellerPaymentManager;
  let mux: ReturnType<typeof createMockMux>;
  let buyerWallet: AbstractSigner & { address: string };
  let sellerAddress: string;

  beforeEach(async () => {
    manager = new SellerPaymentManager(await createTestIdentity(), CONFIG);
    mux = createMockMux();
    buyerWallet = Wallet.createRandom();
    sellerAddress = await manager.signer.getAddress();

    (manager as any)._escrow = {
      getBuyerBalance: vi.fn().mockResolvedValue({
        available: 20_000_000n,
        pendingWithdrawal: 0n,
        withdrawalReadyAt: 0,
      }),
      charge: vi.fn().mockResolvedValue('0xabc'),
    };
  });

  it('rejects expired spending auth', async () => {
    const payload = await buildAuthPayload(sellerAddress, buyerWallet, {
      sessionId: '0x' + '11'.repeat(32),
      maxAmount: 1_000_000n,
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) - 1,
    });

    await manager.handleSpendingAuth(BUYER_PEER_ID, buyerWallet.address, payload, mux);

    expect(manager.hasAuth(BUYER_PEER_ID)).toBe(false);
    expect(mux.sendAuthAck).not.toHaveBeenCalled();
  });

  it('rejects initial auth when nonce is not 1', async () => {
    const payload = await buildAuthPayload(sellerAddress, buyerWallet, {
      sessionId: '0x' + '22'.repeat(32),
      maxAmount: 1_000_000n,
      nonce: 2,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });

    await manager.handleSpendingAuth(BUYER_PEER_ID, buyerWallet.address, payload, mux);

    expect(manager.hasAuth(BUYER_PEER_ID)).toBe(false);
    expect(mux.sendAuthAck).not.toHaveBeenCalled();
  });

  it('rejects new-session auth when nonce is not 1', async () => {
    const initial = await buildAuthPayload(sellerAddress, buyerWallet, {
      sessionId: '0x' + '33'.repeat(32),
      maxAmount: 1_000_000n,
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    await manager.handleSpendingAuth(BUYER_PEER_ID, buyerWallet.address, initial, mux);

    const topUpWrongSession = await buildAuthPayload(sellerAddress, buyerWallet, {
      sessionId: '0x' + '44'.repeat(32),
      maxAmount: 2_000_000n,
      nonce: 2,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    await manager.handleSpendingAuth(BUYER_PEER_ID, buyerWallet.address, topUpWrongSession, mux);

    const sessions = (manager as any)._auths.get(BUYER_PEER_ID) as Map<string, any>;
    const auth = sessions.get(initial.sessionId);
    expect(auth.sessionId).toBe(initial.sessionId);
    expect(auth.nonce).toBe(1);
    expect(mux.sendAuthAck).toHaveBeenCalledTimes(1);
  });

  it('does not advance top-up nonce when pending flush fails', async () => {
    const initial = await buildAuthPayload(sellerAddress, buyerWallet, {
      sessionId: '0x' + '55'.repeat(32),
      maxAmount: 1_000_000n,
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    await manager.handleSpendingAuth(BUYER_PEER_ID, buyerWallet.address, initial, mux);

    const sessions = (manager as any)._auths.get(BUYER_PEER_ID) as Map<string, any>;
    const auth = sessions.get(initial.sessionId);
    auth.pendingCharge = 123_000n;
    vi.spyOn(manager as any, '_submitCharge').mockRejectedValue(new Error('flush failed'));

    const topUp = await buildAuthPayload(sellerAddress, buyerWallet, {
      sessionId: initial.sessionId,
      maxAmount: 2_000_000n,
      nonce: 2,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
    await manager.handleSpendingAuth(BUYER_PEER_ID, buyerWallet.address, topUp, mux);

    expect(auth.nonce).toBe(1);
    expect(auth.pendingCharge).toBe(123_000n);
    expect(mux.sendAuthAck).toHaveBeenCalledTimes(1);
  });

  it('supports multiple concurrent sessions for the same buyer peer', async () => {
    const sessionA = '0x' + '66'.repeat(32);
    const sessionB = '0x' + '77'.repeat(32);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const payloadA = await buildAuthPayload(sellerAddress, buyerWallet, {
      sessionId: sessionA,
      maxAmount: 1_000_000n,
      nonce: 1,
      deadline,
    });
    const payloadB = await buildAuthPayload(sellerAddress, buyerWallet, {
      sessionId: sessionB,
      maxAmount: 2_000_000n,
      nonce: 1,
      deadline,
    });

    await manager.handleSpendingAuth(BUYER_PEER_ID, buyerWallet.address, payloadA, mux);
    await manager.handleSpendingAuth(BUYER_PEER_ID, buyerWallet.address, payloadB, mux);

    expect(manager.hasAuth(BUYER_PEER_ID, sessionA)).toBe(true);
    expect(manager.hasAuth(BUYER_PEER_ID, sessionB)).toBe(true);
    expect(mux.sendAuthAck).toHaveBeenCalledTimes(2);

    const chargeMock = vi.fn().mockResolvedValue('0xabc');
    (manager as any)._escrow = {
      ...(manager as any)._escrow,
      charge: chargeMock,
    };

    await manager.chargeForRequest(BUYER_PEER_ID, sessionA, 150_000n, mux);
    await manager.chargeForRequest(BUYER_PEER_ID, sessionB, 200_000n, mux);

    expect(chargeMock).toHaveBeenCalledTimes(2);
    expect(chargeMock.mock.calls[0]?.[3]).toBe(sessionA);
    expect(chargeMock.mock.calls[1]?.[3]).toBe(sessionB);
  });
});

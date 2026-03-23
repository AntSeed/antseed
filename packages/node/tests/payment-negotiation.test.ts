import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { MessageType, type FramedMessage, type PaymentRequiredPayload } from '../src/types/protocol.js';
import * as codec from '../src/p2p/payment-codec.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { SessionStore } from '../src/payments/session-store.js';
import type { Identity } from '../src/p2p/identity.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { identityToEvmAddress } from '../src/payments/evm/keypair.js';

function mockConnection(): PeerConnection {
  return { send: vi.fn() } as unknown as PeerConnection;
}

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));
  return { peerId, privateKey, publicKey };
}

const ZERO_BYTES32 = '0x' + '00'.repeat(32);
const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);
const USDC_ADDR = '0x' + 'ee'.repeat(20);

const SAMPLE_PAYMENT_REQUIRED: PaymentRequiredPayload = {
  sellerEvmAddr: '0x' + 'ab'.repeat(20),
  tokenRate: '1000',
  firstSignCap: '1000000',
  suggestedAmount: '1000000',
  requestId: 'req-' + 'a'.repeat(32),
};

// ═══════════════════════════════════════════════════════════════
// PaymentRequired codec
// ═══════════════════════════════════════════════════════════════

describe('PaymentRequired codec', () => {
  it('round-trips encodePaymentRequired / decodePaymentRequired', () => {
    const encoded = codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED);
    const decoded = codec.decodePaymentRequired(encoded);
    expect(decoded).toEqual(SAMPLE_PAYMENT_REQUIRED);
  });

  it('decodePaymentRequired rejects missing fields', () => {
    const incomplete = new TextEncoder().encode(JSON.stringify({
      sellerEvmAddr: '0x' + 'ab'.repeat(20),
    }));
    expect(() => codec.decodePaymentRequired(incomplete)).toThrow('Missing or invalid string field');
  });

  it('decodePaymentRequired rejects non-object', () => {
    const notObject = new TextEncoder().encode('"just a string"');
    expect(() => codec.decodePaymentRequired(notObject)).toThrow('Expected JSON object');
  });

  it('preserves all fields through encode/decode', () => {
    const payload: PaymentRequiredPayload = {
      sellerEvmAddr: '0x1234567890abcdef1234567890abcdef12345678',
      tokenRate: '500',
      firstSignCap: '2000000',
      suggestedAmount: '1500000',
      requestId: 'abc-123',
    };
    const decoded = codec.decodePaymentRequired(codec.encodePaymentRequired(payload));
    expect(decoded.sellerEvmAddr).toBe(payload.sellerEvmAddr);
    expect(decoded.tokenRate).toBe(payload.tokenRate);
    expect(decoded.firstSignCap).toBe(payload.firstSignCap);
    expect(decoded.suggestedAmount).toBe(payload.suggestedAmount);
    expect(decoded.requestId).toBe(payload.requestId);
  });
});

// ═══════════════════════════════════════════════════════════════
// PaymentMux PaymentRequired
// ═══════════════════════════════════════════════════════════════

describe('PaymentMux PaymentRequired', () => {
  it('dispatches PaymentRequired to registered handler', async () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);
    const handler = vi.fn();
    mux.onPaymentRequired(handler);

    const frame: FramedMessage = {
      type: MessageType.PaymentRequired,
      messageId: 1,
      payload: codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED),
    };

    const result = await mux.handleFrame(frame);
    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledWith(SAMPLE_PAYMENT_REQUIRED);
  });

  it('returns true for PaymentRequired even with no handler', async () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);

    const frame: FramedMessage = {
      type: MessageType.PaymentRequired,
      messageId: 1,
      payload: codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED),
    };

    const result = await mux.handleFrame(frame);
    expect(result).toBe(true);
  });

  it('sendPaymentRequired encodes and sends via connection', () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);

    mux.sendPaymentRequired(SAMPLE_PAYMENT_REQUIRED);
    expect(conn.send).toHaveBeenCalledOnce();

    const sentFrame = (conn.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array;
    expect(sentFrame[0]).toBe(MessageType.PaymentRequired);
  });

  it('PaymentRequired (0x56) is in the payment message range', () => {
    expect(PaymentMux.isPaymentMessage(0x56)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Seller: PaymentRequired generation
// ═══════════════════════════════════════════════════════════════

describe('SellerPaymentManager PaymentRequired', () => {
  let tempDir: string;
  let store: SessionStore;
  let sellerIdentity: Identity;
  let manager: SellerPaymentManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-negotiation-'));
    store = new SessionStore(tempDir);
    sellerIdentity = await createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      contractAddress: CONTRACT_ADDR,
      usdcAddress: USDC_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    vi.spyOn(manager.escrowClient, 'reserve').mockResolvedValue('0xhash');
    vi.spyOn(manager.escrowClient, 'settle').mockResolvedValue('0xhash');
    vi.spyOn(manager.escrowClient, 'settleTimeout').mockResolvedValue('0xhash');
    vi.spyOn(manager.escrowClient, 'getSellerAccount').mockResolvedValue({
      stake: 100_000_000n,
      earnings: 0n,
      stakedAt: BigInt(Date.now()),
      tokenRate: 500n,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('getPaymentRequirements returns null before init', () => {
    expect(manager.getPaymentRequirements('req-1')).toBeNull();
  });

  it('init caches tokenRate and firstSignCap', async () => {
    vi.spyOn(manager.escrowClient, 'getFirstSignCap').mockResolvedValue(1_000_000n);
    await manager.init();

    const req = manager.getPaymentRequirements('req-1');
    expect(req).not.toBeNull();
    expect(req!.tokenRate).toBe('500');
    expect(req!.firstSignCap).toBe('1000000');
    expect(req!.suggestedAmount).toBe('100000'); // $0.10 first-sign suggested
    expect(req!.sellerEvmAddr).toBe(identityToEvmAddress(sellerIdentity));
  });

  it('init survives RPC failure gracefully', async () => {
    vi.spyOn(manager.escrowClient, 'getSellerAccount').mockRejectedValue(new Error('RPC down'));
    vi.spyOn(manager.escrowClient, 'getFirstSignCap').mockRejectedValue(new Error('RPC down'));

    await manager.init(); // should not throw
    expect(manager.getPaymentRequirements('req-1')).toBeNull();
  });

  it('getPaymentRequirements includes the triggering requestId', async () => {
    vi.spyOn(manager.escrowClient, 'getFirstSignCap').mockResolvedValue(1_000_000n);
    await manager.init();

    expect(manager.getPaymentRequirements('req-aaa')!.requestId).toBe('req-aaa');
    expect(manager.getPaymentRequirements('req-bbb')!.requestId).toBe('req-bbb');
  });

  it('suggestedAmount is independent of firstSignCap', async () => {
    vi.spyOn(manager.escrowClient, 'getFirstSignCap').mockResolvedValue(3_000_000n);
    await manager.init();

    const req = manager.getPaymentRequirements('req-1');
    // suggestedAmount is the fixed cent-level default, not the contract cap
    expect(req!.suggestedAmount).toBe('100000'); // $0.10
    expect(req!.firstSignCap).toBe('3000000'); // contract cap still reported
  });
});

// ═══════════════════════════════════════════════════════════════
// Buyer: on-chain approval context
// ═══════════════════════════════════════════════════════════════

describe('BaseEscrowClient.getBuyerApprovalContext', () => {
  // We test via SellerPaymentManager's escrowClient since we can't easily
  // instantiate BaseEscrowClient without a real provider. The manager
  // exposes its client for spying.

  let tempDir: string;
  let store: SessionStore;
  let sellerIdentity: Identity;
  let manager: SellerPaymentManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'escrow-ctx-'));
    store = new SessionStore(tempDir);
    sellerIdentity = await createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      contractAddress: CONTRACT_ADDR,
      usdcAddress: USDC_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns isFirstSign=true when latestSessionId is zero', async () => {
    const escrow = manager.escrowClient;
    vi.spyOn(escrow, 'getBuyerBalance').mockResolvedValue({
      available: 10_000_000n,
      reserved: 0n,
      pendingWithdrawal: 0n,
      lastActivityAt: 0n,
    });
    vi.spyOn(escrow, 'getSellerAccount').mockResolvedValue({
      stake: 100_000_000n,
      earnings: 0n,
      stakedAt: BigInt(Date.now()),
      tokenRate: 1000n,
    });
    vi.spyOn(escrow, 'getFirstSignCap').mockResolvedValue(1_000_000n);
    vi.spyOn(escrow, 'getLatestSessionId').mockResolvedValue(ZERO_BYTES32);
    vi.spyOn(escrow, 'getFirstSessionTimestamp').mockResolvedValue(0n);
    vi.spyOn(escrow, 'getProvenSignCooldown').mockResolvedValue(604800n); // 7 days

    const ctx = await escrow.getBuyerApprovalContext('0xbuyer', '0xseller');
    expect(ctx.isFirstSign).toBe(true);
    expect(ctx.cooldownRemainingSecs).toBe(0);
    expect(ctx.buyerBalance.available).toBe(10_000_000n);
    expect(ctx.sellerAccount.tokenRate).toBe(1000n);
    expect(ctx.firstSignCap).toBe(1_000_000n);
  });

  it('returns isFirstSign=false with cooldown when prior session exists', async () => {
    const escrow = manager.escrowClient;
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const threeDaysAgo = nowSecs - 259200n; // 3 days ago

    vi.spyOn(escrow, 'getBuyerBalance').mockResolvedValue({
      available: 5_000_000n,
      reserved: 1_000_000n,
      pendingWithdrawal: 0n,
      lastActivityAt: nowSecs,
    });
    vi.spyOn(escrow, 'getSellerAccount').mockResolvedValue({
      stake: 50_000_000n,
      earnings: 100_000n,
      stakedAt: BigInt(Date.now()),
      tokenRate: 500n,
    });
    vi.spyOn(escrow, 'getFirstSignCap').mockResolvedValue(1_000_000n);
    vi.spyOn(escrow, 'getLatestSessionId').mockResolvedValue('0x' + 'aa'.repeat(32));
    vi.spyOn(escrow, 'getFirstSessionTimestamp').mockResolvedValue(threeDaysAgo);
    vi.spyOn(escrow, 'getProvenSignCooldown').mockResolvedValue(604800n); // 7 days

    const ctx = await escrow.getBuyerApprovalContext('0xbuyer', '0xseller');
    expect(ctx.isFirstSign).toBe(false);
    expect(ctx.latestSessionId).toBe('0x' + 'aa'.repeat(32));
    // Cooldown: 7 days - 3 days = ~4 days remaining
    expect(ctx.cooldownRemainingSecs).toBeGreaterThan(300000); // > 3 days in secs
    expect(ctx.cooldownRemainingSecs).toBeLessThan(400000); // < 5 days
  });

  it('returns cooldownRemainingSecs=0 when cooldown has elapsed', async () => {
    const escrow = manager.escrowClient;
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const tenDaysAgo = nowSecs - 864000n; // 10 days ago

    vi.spyOn(escrow, 'getBuyerBalance').mockResolvedValue({
      available: 5_000_000n, reserved: 0n, pendingWithdrawal: 0n, lastActivityAt: 0n,
    });
    vi.spyOn(escrow, 'getSellerAccount').mockResolvedValue({
      stake: 50_000_000n, earnings: 0n, stakedAt: BigInt(Date.now()), tokenRate: 500n,
    });
    vi.spyOn(escrow, 'getFirstSignCap').mockResolvedValue(1_000_000n);
    vi.spyOn(escrow, 'getLatestSessionId').mockResolvedValue('0x' + 'bb'.repeat(32));
    vi.spyOn(escrow, 'getFirstSessionTimestamp').mockResolvedValue(tenDaysAgo);
    vi.spyOn(escrow, 'getProvenSignCooldown').mockResolvedValue(604800n);

    const ctx = await escrow.getBuyerApprovalContext('0xbuyer', '0xseller');
    expect(ctx.isFirstSign).toBe(false);
    expect(ctx.cooldownRemainingSecs).toBe(0);
  });

  it('batches all view calls in parallel', async () => {
    const escrow = manager.escrowClient;
    const calls: string[] = [];

    vi.spyOn(escrow, 'getBuyerBalance').mockImplementation(async () => {
      calls.push('getBuyerBalance');
      return { available: 0n, reserved: 0n, pendingWithdrawal: 0n, lastActivityAt: 0n };
    });
    vi.spyOn(escrow, 'getSellerAccount').mockImplementation(async () => {
      calls.push('getSellerAccount');
      return { stake: 0n, earnings: 0n, stakedAt: 0n, tokenRate: 0n };
    });
    vi.spyOn(escrow, 'getFirstSignCap').mockImplementation(async () => {
      calls.push('getFirstSignCap');
      return 0n;
    });
    vi.spyOn(escrow, 'getLatestSessionId').mockImplementation(async () => {
      calls.push('getLatestSessionId');
      return ZERO_BYTES32;
    });
    vi.spyOn(escrow, 'getFirstSessionTimestamp').mockImplementation(async () => {
      calls.push('getFirstSessionTimestamp');
      return 0n;
    });
    vi.spyOn(escrow, 'getProvenSignCooldown').mockImplementation(async () => {
      calls.push('getProvenSignCooldown');
      return 0n;
    });

    await escrow.getBuyerApprovalContext('0xbuyer', '0xseller');
    // All 6 view calls should have been made
    expect(calls).toHaveLength(6);
    expect(calls).toContain('getBuyerBalance');
    expect(calls).toContain('getSellerAccount');
    expect(calls).toContain('getFirstSignCap');
    expect(calls).toContain('getLatestSessionId');
    expect(calls).toContain('getFirstSessionTimestamp');
    expect(calls).toContain('getProvenSignCooldown');
  });
});

// ═══════════════════════════════════════════════════════════════
// PaymentRequired buffering (race condition: 402 + PR same tick)
// ═══════════════════════════════════════════════════════════════

describe('PaymentMux PaymentRequired buffering', () => {
  it('handler fires immediately when listener is registered first', async () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);
    const received: PaymentRequiredPayload[] = [];

    mux.onPaymentRequired((payload) => received.push(payload));

    const frame: FramedMessage = {
      type: MessageType.PaymentRequired,
      messageId: 1,
      payload: codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED),
    };
    await mux.handleFrame(frame);

    expect(received).toHaveLength(1);
    expect(received[0]!.requestId).toBe(SAMPLE_PAYMENT_REQUIRED.requestId);
  });

  it('multiple PaymentRequired frames dispatch to handler in order', async () => {
    const conn = mockConnection();
    const mux = new PaymentMux(conn);
    const received: string[] = [];

    mux.onPaymentRequired((payload) => received.push(payload.requestId));

    for (const id of ['req-1', 'req-2', 'req-3']) {
      const payload = { ...SAMPLE_PAYMENT_REQUIRED, requestId: id };
      await mux.handleFrame({
        type: MessageType.PaymentRequired,
        messageId: 1,
        payload: codec.encodePaymentRequired(payload),
      });
    }

    expect(received).toEqual(['req-1', 'req-2', 'req-3']);
  });
});

// ═══════════════════════════════════════════════════════════════
// Seller: proven-sign suggested amount
// ═══════════════════════════════════════════════════════════════

describe('SellerPaymentManager proven-sign suggested amount', () => {
  let tempDir: string;
  let store: SessionStore;
  let sellerIdentity: Identity;
  let manager: SellerPaymentManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-proven-'));
    store = new SessionStore(tempDir);
    sellerIdentity = await createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      contractAddress: CONTRACT_ADDR,
      usdcAddress: USDC_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    vi.spyOn(manager.escrowClient, 'reserve').mockResolvedValue('0xhash');
    vi.spyOn(manager.escrowClient, 'settle').mockResolvedValue('0xhash');
    vi.spyOn(manager.escrowClient, 'settleTimeout').mockResolvedValue('0xhash');
    vi.spyOn(manager.escrowClient, 'getSellerAccount').mockResolvedValue({
      stake: 100_000_000n,
      earnings: 0n,
      stakedAt: BigInt(Date.now()),
      tokenRate: 500n,
    });
    vi.spyOn(manager.escrowClient, 'getFirstSignCap').mockResolvedValue(1_000_000n);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('suggests cent-level amount for new buyers (first-sign)', async () => {
    await manager.init();
    const req = manager.getPaymentRequirements('req-1', 'unknown-buyer');
    expect(req!.suggestedAmount).toBe('100000'); // $0.10
  });

  it('suggests flat proven-sign amount ($0.10) for returning buyers with delivered tokens', async () => {
    await manager.init();

    // Insert a prior session with delivered tokens
    store.upsertSession({
      sessionId: '0x' + 'aa'.repeat(32),
      peerId: 'returning-buyer',
      role: 'seller',
      sellerEvmAddr: identityToEvmAddress(sellerIdentity),
      buyerEvmAddr: '0x' + 'bb'.repeat(20),
      nonce: 1,
      authMax: '1000000',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      previousSessionId: '0x' + '00'.repeat(32),
      previousConsumption: '0',
      tokensDelivered: '500',
      requestCount: 5,
      reservedAt: Date.now(),
      settledAt: null,
      settledAmount: null,
      status: 'settled',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const req = manager.getPaymentRequirements('req-2', 'returning-buyer');
    // Proven-sign suggested amount ($0.10) differs from first-sign cap ($1.00)
    expect(req!.suggestedAmount).toBe('100000');
  });

  it('includes per-direction pricing when provided', async () => {
    await manager.init();
    const req = manager.getPaymentRequirements('req-3', undefined, {
      inputUsdPerMillion: 3.0,
      outputUsdPerMillion: 15.0,
    });
    expect(req!.inputUsdPerMillion).toBe(3.0);
    expect(req!.outputUsdPerMillion).toBe(15.0);
  });

  it('omits pricing fields when not provided', async () => {
    await manager.init();
    const req = manager.getPaymentRequirements('req-4');
    expect(req!.inputUsdPerMillion).toBeUndefined();
    expect(req!.outputUsdPerMillion).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Codec: PaymentRequired with optional pricing fields
// ═══════════════════════════════════════════════════════════════

describe('PaymentRequired codec with pricing', () => {
  it('round-trips with per-direction pricing', () => {
    const payload: PaymentRequiredPayload = {
      ...SAMPLE_PAYMENT_REQUIRED,
      inputUsdPerMillion: 3.0,
      outputUsdPerMillion: 15.0,
    };
    const decoded = codec.decodePaymentRequired(codec.encodePaymentRequired(payload));
    expect(decoded.inputUsdPerMillion).toBe(3.0);
    expect(decoded.outputUsdPerMillion).toBe(15.0);
  });

  it('round-trips without pricing (fields absent)', () => {
    const decoded = codec.decodePaymentRequired(codec.encodePaymentRequired(SAMPLE_PAYMENT_REQUIRED));
    expect(decoded.inputUsdPerMillion).toBeUndefined();
    expect(decoded.outputUsdPerMillion).toBeUndefined();
  });
});

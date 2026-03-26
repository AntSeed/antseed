import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { SessionStore } from '../src/payments/session-store.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { SpendingAuthPayload } from '../src/types/protocol.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';
import { identityToEvmWallet, identityToEvmAddress } from '../src/payments/evm/keypair.js';
import { signMetadataAuth, makeSessionsDomain, computeMetadataHash, encodeMetadata, ZERO_METADATA_HASH } from '../src/payments/evm/signatures.js';
import type { MetadataAuthMessage, SpendingAuthMetadata } from '../src/payments/evm/signatures.js';

const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

async function createTestIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));
  return { peerId, privateKey, publicKey };
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
  } = {},
): Promise<SpendingAuthPayload> {
  const cumulativeAmount = opts.cumulativeAmount ?? 1_000_000n;
  const cumulativeInputTokens = opts.cumulativeInputTokens ?? 0n;
  const cumulativeOutputTokens = opts.cumulativeOutputTokens ?? 0n;
  const salt = opts.salt ?? '0x' + '01'.repeat(32);
  const deadline = opts.deadline ?? Math.floor(Date.now() / 1000) + 3600;

  const meta: SpendingAuthMetadata = {
    cumulativeInputTokens,
    cumulativeOutputTokens,
    cumulativeLatencyMs: 0n,
    cumulativeRequestCount: 0n,
  };
  const metadataHashHex = computeMetadataHash(meta);
  const encodedMetadata = encodeMetadata(meta);

  const buyerWallet = identityToEvmWallet(buyerIdentity);
  const buyerEvmAddr = buyerWallet.address;

  const sessionsDomain = makeSessionsDomain(CHAIN_ID, CONTRACT_ADDR);
  const metadataMsg: MetadataAuthMessage = { channelId, cumulativeAmount, metadataHash: metadataHashHex };
  const metadataAuthSig = await signMetadataAuth(buyerWallet, sessionsDomain, metadataMsg);

  return {
    channelId,
    cumulativeAmount: cumulativeAmount.toString(),
    metadataHash: metadataHashHex,
    metadata: encodedMetadata,
    metadataAuthSig,
    buyerEvmAddr,
    reserveSalt: salt,
    reserveMaxAmount: '10000000',
    reserveDeadline: deadline,
  };
}

function makeChannelId(n: number): string {
  return '0x' + n.toString(16).padStart(2, '0').repeat(32);
}

describe('SellerPaymentManager', () => {
  let tempDir: string;
  let store: SessionStore;
  let sellerIdentity: Identity;
  let buyerIdentity: Identity;
  let manager: SellerPaymentManager;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-pm-test-'));
    store = new SessionStore(tempDir);
    sellerIdentity = await createTestIdentity();
    buyerIdentity = await createTestIdentity();

    const config: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      sessionsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
    };
    manager = new SellerPaymentManager(sellerIdentity, config, store);

    vi.spyOn(manager.sessionsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager.sessionsClient, 'close').mockResolvedValue('0xclose-hash');
    vi.spyOn(manager.sessionsClient, 'requestTimeout').mockResolvedValue('0xrequesttimeout-hash');
    vi.spyOn(manager.sessionsClient, 'withdraw').mockResolvedValue('0xwithdraw-hash');

    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('test_handleSpendingAuth_firstSign: calls reserve, sends AuthAck', async () => {
    const channelId = makeChannelId(1);
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId);

    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    expect(manager.sessionsClient.reserve).toHaveBeenCalledOnce();
    expect(mux.sentAuthAcks.length).toBe(1);
    const ack = mux.sentAuthAcks[0] as Record<string, unknown>;
    expect(ack.channelId).toBe(channelId);

    const session = store.getSession(channelId);
    expect(session).not.toBeNull();
    expect(session!.role).toBe('seller');
    expect(session!.status).toBe('active');
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
  });

  it('test_handleSpendingAuth_subsequent: validates monotonic increase', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const channelId = makeChannelId(2);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 100_000n });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload1, mux);

    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload2, mux);

    expect(mux.sentAuthAcks.length).toBe(1);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });

  it('test_recordSpend: tracks cumulative spend', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const channelId = makeChannelId(3);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    manager.recordSpend(channelId, 50_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(50_000n);

    manager.recordSpend(channelId, 30_000n);
    expect(manager.getCumulativeSpend(channelId)).toBe(80_000n);
  });

  it('test_getSessionByPeer: returns active session', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const channelId = makeChannelId(4);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    const session = manager.getSessionByPeer(buyerIdentity.peerId);
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe(channelId);
  });

  it('test_onBuyerDisconnect: session persisted, not closed when settleOnDisconnect=false', async () => {
    const config2: SellerPaymentConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      sessionsContractAddress: CONTRACT_ADDR,
      chainId: CHAIN_ID,
      dataDir: tempDir,
      settleOnDisconnect: false,
    };
    const manager2 = new SellerPaymentManager(sellerIdentity, config2, store);
    vi.spyOn(manager2.sessionsClient, 'reserve').mockResolvedValue('0xreserve-hash');
    vi.spyOn(manager2.sessionsClient, 'close').mockResolvedValue('0xclose-hash');

    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const channelId = makeChannelId(5);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId);
    await manager2.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    expect(manager2.hasSession(buyerIdentity.peerId)).toBe(true);
    manager2.onBuyerDisconnect(buyerIdentity.peerId);
    expect(manager2.hasSession(buyerIdentity.peerId)).toBe(false);

    const session = store.getSession(channelId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    expect(manager2.sessionsClient.close).not.toHaveBeenCalled();
  });

  it('test_hasSession: returns true/false correctly', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);

    const channelId = makeChannelId(7);
    const payload = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId);
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload, mux);

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
    expect(manager.hasSession('nonexistent-peer')).toBe(false);
  });

  it('test_getPaymentRequirements: returns payment requirements payload', () => {
    const req = manager.getPaymentRequirements('test-req-1');
    expect(req).not.toBeNull();
    expect(req.suggestedAmount).toBe('100000');
    expect(req.requestId).toBe('test-req-1');
    expect(req.sellerEvmAddr).toBe(identityToEvmAddress(sellerIdentity));
    expect(req.minBudgetPerRequest).toBeDefined();
  });

  it('test_getPaymentRequirements_includes_requestId: correlates with the triggering request', () => {
    const req1 = manager.getPaymentRequirements('req-aaa');
    const req2 = manager.getPaymentRequirements('req-bbb');
    expect(req1.requestId).toBe('req-aaa');
    expect(req2.requestId).toBe('req-bbb');
  });

  it('test_validateAndAcceptAuth: accepts monotonic increase', async () => {
    const buyerEvmAddr = identityToEvmAddress(buyerIdentity);
    const channelId = makeChannelId(8);

    const payload1 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 100_000n });
    await manager.handleSpendingAuth(buyerIdentity.peerId, buyerEvmAddr, payload1, mux);

    const payload2 = await buildSpendingAuth(buyerIdentity, sellerIdentity, channelId, { cumulativeAmount: 200_000n });
    const accepted = await manager.validateAndAcceptAuth(buyerIdentity.peerId, payload2);
    expect(accepted).toBe(true);
    expect(manager.getAcceptedCumulative(channelId)).toBe(200_000n);
  });
});

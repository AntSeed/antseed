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
import {
  signSpendingAuth,
  signReserveAuth,
  makeChannelsDomain,
  computeMetadataHash,
  encodeMetadata,
  ZERO_METADATA,
} from '../src/payments/evm/signatures.js';
import type { SpendingAuthMessage, ReserveAuthMessage, SpendingAuthMetadata } from '../src/payments/evm/signatures.js';

const CHAIN_ID = 31337;
const CONTRACT_ADDR = '0x' + 'dd'.repeat(20);

function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

function createMockPaymentMux(): PaymentMux & { sentAuthAcks: unknown[] } {
  const mux = {
    sentAuthAcks: [] as unknown[],
    sendSpendingAuth() {},
    sendAuthAck(payload: unknown) { mux.sentAuthAcks.push(payload); },
    sendPaymentRequired() {},
    sendNeedAuth() {},
    onSpendingAuth() {},
    onAuthAck() {},
    onPaymentRequired() {},
    onNeedAuth() {},
    handleFrame: vi.fn(),
  };
  return mux as unknown as PaymentMux & { sentAuthAcks: unknown[] };
}

function makeChannelId(n: number): string {
  return '0x' + n.toString(16).padStart(2, '0').repeat(32);
}

async function buildSpendingAuth(
  buyerIdentity: Identity,
  channelId: string,
  opts: {
    cumulativeAmount?: bigint;
    isReserve?: boolean;
    salt?: string;
    deadline?: number;
    reserveMaxAmount?: string;
  } = {},
): Promise<SpendingAuthPayload> {
  const cumulativeAmount = opts.isReserve ? 0n : (opts.cumulativeAmount ?? 1_000_000n);
  const salt = opts.salt ?? '0x' + '01'.repeat(32);
  const deadline = opts.deadline ?? Math.floor(Date.now() / 1000) + 3600;
  const reserveMaxAmount = BigInt(opts.reserveMaxAmount ?? '10000000');

  const meta: SpendingAuthMetadata = {
    cumulativeInputTokens: 0n,
    cumulativeOutputTokens: 0n,
    cumulativeRequestCount: 0n,
  };
  const metadataHashHex = computeMetadataHash(meta);
  const encodedMetadata = encodeMetadata(meta);
  const sessionsDomain = makeChannelsDomain(CHAIN_ID, CONTRACT_ADDR);

  const isReserve = opts.isReserve ?? false;
  let spendingAuthSig: string;
  if (isReserve) {
    const reserveMsg: ReserveAuthMessage = { channelId, maxAmount: reserveMaxAmount, deadline: BigInt(deadline) };
    spendingAuthSig = await signReserveAuth(buyerIdentity.wallet, sessionsDomain, reserveMsg);
  } else {
    const metadataMsg: SpendingAuthMessage = { channelId, cumulativeAmount, metadataHash: metadataHashHex };
    spendingAuthSig = await signSpendingAuth(buyerIdentity.wallet, sessionsDomain, metadataMsg);
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

/** Set up a fully reserved channel with a SpendingAuth and recorded spend. */
async function setupActiveChannel(
  manager: SellerPaymentManager,
  buyerIdentity: Identity,
  mux: PaymentMux,
  channelId: string,
  cumulativeAmount: bigint,
  spendAmount: bigint,
): Promise<void> {
  const reserve = await buildSpendingAuth(buyerIdentity, channelId, { isReserve: true });
  await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);

  const auth = await buildSpendingAuth(buyerIdentity, channelId, { cumulativeAmount });
  await manager.handleSpendingAuth(buyerIdentity.peerId, auth, mux);

  if (spendAmount > 0n) {
    manager.recordSpend(channelId, spendAmount);
  }
}

describe('SellerPaymentManager — CloseRequested handling', () => {
  let tempDir: string;
  let store: ChannelStore;
  let sellerIdentity: Identity;
  let buyerIdentity: Identity;
  let manager: SellerPaymentManager;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-close-req-'));
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
    vi.spyOn(manager.channelsClient, 'settle').mockResolvedValue('0xsettle-hash');

    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('closes channel on-chain when CloseRequested and SpendingAuth exists', async () => {
    const channelId = makeChannelId(1);
    await setupActiveChannel(manager, buyerIdentity, mux, channelId, 200_000n, 50_000n);

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);

    await manager.handleCloseRequested(channelId);

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    const closeArgs = (manager.channelsClient.close as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(closeArgs[1]).toBe(channelId); // channelId arg
    expect(closeArgs[2]).toBe(200_000n); // cumulativeAmount

    // Channel should be settled
    const session = store.getChannel(channelId);
    expect(session!.status).toBe('settled');

    // In-memory state cleaned up
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
    expect(manager.getAcceptedCumulative(channelId)).toBe(0n);
    expect(manager.getCumulativeSpend(channelId)).toBe(0n);
  });

  it('cleans up locally when CloseRequested but no SpendingAuth (zero-cumulative)', async () => {
    const channelId = makeChannelId(2);

    // Only reserve, no subsequent SpendingAuth with actual amount
    const reserve = await buildSpendingAuth(buyerIdentity, channelId, { isReserve: true });
    await manager.handleSpendingAuth(buyerIdentity.peerId, reserve, mux);

    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);

    await manager.handleCloseRequested(channelId);

    // Should NOT call close() — no voucher to claim
    expect(manager.channelsClient.close).not.toHaveBeenCalled();

    // Channel should be marked as timeout
    const session = store.getChannel(channelId);
    expect(session!.status).toBe('timeout');

    // In-memory state cleaned up
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
  });

  it('retries on next poll when close() fails', async () => {
    const channelId = makeChannelId(3);
    await setupActiveChannel(manager, buyerIdentity, mux, channelId, 300_000n, 100_000n);

    (manager.channelsClient.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('tx reverted'));

    await manager.handleCloseRequested(channelId);

    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    // State should NOT be cleaned up on failure — will retry
    expect(manager.getAcceptedCumulative(channelId)).toBe(300_000n);
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
  });

  it('ignores CloseRequested for unknown channels', async () => {
    const unknownChannelId = makeChannelId(99);

    // Should not throw
    await manager.handleCloseRequested(unknownChannelId);

    expect(manager.channelsClient.close).not.toHaveBeenCalled();
  });
});

describe('SellerPaymentManager — pollCloseRequested', () => {
  let tempDir: string;
  let store: ChannelStore;
  let sellerIdentity: Identity;
  let buyerIdentity: Identity;
  let manager: SellerPaymentManager;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'seller-poll-close-'));
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

    mux = createMockPaymentMux();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects and handles CloseRequested for tracked channels', async () => {
    const channelId = makeChannelId(10);
    await setupActiveChannel(manager, buyerIdentity, mux, channelId, 500_000n, 100_000n);

    vi.spyOn(manager.channelsClient, 'getCloseRequestedEvents').mockResolvedValue([
      { channelId, buyer: buyerIdentity.wallet.address },
    ]);
    vi.spyOn(manager.channelsClient, 'getBlockNumber').mockResolvedValue(42);

    const nextBlock = await manager.pollCloseRequested(0);

    expect(nextBlock).toBe(43);
    expect(manager.channelsClient.close).toHaveBeenCalledOnce();
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(false);
  });

  it('skips CloseRequested events for untracked channels', async () => {
    const trackedChannelId = makeChannelId(11);
    const untrackedChannelId = makeChannelId(99);
    await setupActiveChannel(manager, buyerIdentity, mux, trackedChannelId, 500_000n, 100_000n);

    vi.spyOn(manager.channelsClient, 'getCloseRequestedEvents').mockResolvedValue([
      { channelId: untrackedChannelId, buyer: '0x' + 'aa'.repeat(20) },
    ]);
    vi.spyOn(manager.channelsClient, 'getBlockNumber').mockResolvedValue(50);

    const nextBlock = await manager.pollCloseRequested(0);

    expect(nextBlock).toBe(51);
    expect(manager.channelsClient.close).not.toHaveBeenCalled();
    // Tracked channel should still be active
    expect(manager.hasSession(buyerIdentity.peerId)).toBe(true);
  });

  it('returns same fromBlock on RPC failure', async () => {
    vi.spyOn(manager.channelsClient, 'getCloseRequestedEvents').mockRejectedValue(new Error('RPC unavailable'));

    const nextBlock = await manager.pollCloseRequested(10);

    expect(nextBlock).toBe(10); // Same as input — will retry from here
  });
});

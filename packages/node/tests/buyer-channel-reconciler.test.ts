import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TypedDataEncoder, Wallet } from 'ethers';
import { makeChannelsDomain, signReserveAuth } from '@antseed/protocol/signatures';
import { BuyerPaymentManager } from '../../buyer-core/src/buyer-payment-manager.js';
import type { PaymentMux } from '../../buyer-core/src/payment-mux.js';
import { AntseedNode } from '../src/node.js';
import { BuyerChannelReconciler } from '../src/payments/buyer-channel-reconciler.js';
import { ChannelStore, type StoredChannel } from '../src/payments/channel-store.js';
import { ChannelsClient, type ChannelInfo } from '../src/payments/evm/channels-client.js';
import type { Identity } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';

const CONTRACT = `0x${'cc'.repeat(20)}`;
const EMPTY_CHANNEL: ChannelInfo = {
  buyer: `0x${'00'.repeat(20)}`, seller: `0x${'00'.repeat(20)}`,
  status: 0, deposit: 0n, settled: 0n, metadataHash: `0x${'00'.repeat(32)}`,
  deadline: 0n, settledAt: 0n, closeRequestedAt: 0n,
};

describe('BuyerChannelReconciler', () => {
  let directory: string;
  let store: ChannelStore;
  let identity: Identity;
  let manager: BuyerPaymentManager;
  let node: AntseedNode;
  let reconciler: BuyerChannelReconciler;
  let states: Map<string, ChannelInfo>;
  let getBlock: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let onRetired: ReturnType<typeof vi.fn>;
  let domainSeparator: ReturnType<typeof vi.fn>;

  function expireOpenings() {
    vi.setSystemTime(Date.now() + 3_600_000);
  }

  async function opening(index: number): Promise<StoredChannel> {
    const peerId = toPeerId(index.toString(16).padStart(40, '0'));
    const mux = { sendSpendingAuth: vi.fn() } as unknown as PaymentMux;
    const channelId = await manager.authorizeSpending(peerId, mux, 10_000n);
    expect(manager.isLockConfirmed(peerId)).toBe(false);
    return store.getChannel(channelId)!;
  }

  function setState(channel: StoredChannel, status: number, settled = 0n) {
    states.set(channel.sessionId, {
      ...EMPTY_CHANNEL, status, settled, deposit: 1_000_000n,
      buyer: channel.buyerEvmAddr, seller: channel.sellerEvmAddr,
    });
  }

  function reopenStore() {
    store.close();
    store = new ChannelStore(directory);
    Object.assign(node, { _channelStore: store });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    directory = mkdtempSync(join(tmpdir(), 'antseed-channel-reconcile-'));
    const privateKey = randomBytes(32);
    const wallet = new Wallet(`0x${privateKey.toString('hex')}`);
    identity = { privateKey, wallet, peerId: toPeerId(wallet.address.slice(2).toLowerCase()) };
    store = new ChannelStore(directory);
    manager = new BuyerPaymentManager(identity, {
      rpcUrl: 'http://127.0.0.1:1', depositsContractAddress: `0x${'dd'.repeat(20)}`,
      channelsContractAddress: CONTRACT, usdcAddress: `0x${'ee'.repeat(20)}`,
      identityRegistryAddress: `0x${'ff'.repeat(20)}`, chainId: 31337,
      defaultAuthDurationSecs: 900, maxPerRequestUsdc: 100_000n,
      maxReserveAmountUsdc: 1_000_000n, dataDir: directory,
    }, store);
    node = new AntseedNode({ role: 'buyer' });
    Object.assign(node, { _identity: identity, _channelStore: store });
    states = new Map();
    getBlock = vi.fn(async () => ({ number: 100, timestamp: Math.floor(Date.now() / 1000) - 30 }));
    getSession = vi.fn(async (channelId: string) => states.get(channelId) ?? EMPTY_CHANNEL);
    vi.spyOn(ChannelsClient.prototype, 'getSession').mockResolvedValue(EMPTY_CHANNEL);
    onRetired = vi.fn();
    domainSeparator = vi.fn(async () => TypedDataEncoder.hashDomain(makeChannelsDomain(31337, CONTRACT)));
    reconciler = new BuyerChannelReconciler({
      store, buyerAddress: wallet.address, chainId: 31337, rpcUrl: 'http://127.0.0.1:1',
      maxReserveAmountUsdc: 1_000_000n,
      client: { contractAddress: CONTRACT, getSession, domainSeparator, provider: { getBlock } } as unknown as ChannelsClient,
      onCurrentChannelRetired: onRetired,
    });
  });

  afterEach(() => {
    reconciler.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retires an expired opening that never received an acknowledgement, durably', async () => {
    const channel = await opening(1);
    expireOpenings();
    await reconciler.reconcile();
    expect(getBlock).toHaveBeenCalledWith('finalized');
    expect(getSession).toHaveBeenCalledWith(channel.sessionId, 100);
    expect(onRetired).toHaveBeenCalledWith(channel.peerId);
    reopenStore();
    expect(store.getChannel(channel.sessionId)).toMatchObject({ status: 'ghost', requestCount: 0, authMax: '0' });
    expect(node.getBuyerUsageTotals().activeChannels).toBe(0);
    expect(node.getAllBuyerChannels()).toHaveLength(1);
  });

  it('cleans up a persisted opening after the send itself failed', async () => {
    const mux = { sendSpendingAuth: () => { throw new Error('Transport disconnected'); } } as unknown as PaymentMux;
    await expect(manager.authorizeSpending(toPeerId('a'.repeat(40)), mux, 10_000n)).rejects.toThrow('Transport disconnected');
    expect(node.getBuyerUsageTotals().activeChannels).toBe(1);
    expireOpenings();
    await reconciler.reconcile();
    expect(node.getBuyerUsageTotals().activeChannels).toBe(0);
    expect(node.getAllBuyerChannels()).toHaveLength(1);
  });

  it('retains the negotiated initial reserve amount for expiry checks after a restart', async () => {
    const mux = { sendSpendingAuth: vi.fn() } as unknown as PaymentMux;
    const channelId = await manager.authorizeSpending(toPeerId('a'.repeat(40)), mux, 10_000n, 123_456n);
    expect(store.getChannel(channelId)!.initialReserveAmount).toBe('123456');
    expireOpenings();
    await reconciler.reconcile();
    reopenStore();
    expect(store.getChannel(channelId)).toMatchObject({ status: 'ghost', initialReserveAmount: '123456' });
  });

  it('reconciles the 33-channel reproduction to two active channels without deleting history', async () => {
    for (let index = 1; index <= 33; index++) {
      const channel = await opening(index);
      if (index <= 28) setState(channel, index <= 26 ? 2 : 1);
      if (index === 1) store.updateTokensDelivered(channel.sessionId, '123', 1);
    }
    const before = node.getBuyerUsageTotals();
    expect(before.activeChannels).toBe(33);
    expireOpenings();
    await reconciler.reconcile();
    reopenStore();
    const after = node.getBuyerUsageTotals();
    expect(after.activeChannels).toBe(2);
    expect(after.totalSettlements).toBe(26);
    expect(after.totalRequests).toBe(before.totalRequests);
    expect(after.totalInputTokens).toBe(before.totalInputTokens);
    expect(node.getAllBuyerChannels()).toHaveLength(33);
    expect(node.getAllBuyerChannels().filter((channel) => channel.status === 'ghost')).toHaveLength(5);
  });

  it('preserves an opening until its authorization has expired on the finalized chain', async () => {
    const channel = await opening(1);
    expireOpenings();
    getBlock.mockResolvedValue({ number: 100, timestamp: channel.deadline });
    await reconciler.reconcile();
    expect(store.getChannel(channel.sessionId)!.status).toBe('active');
  });

  it.each([
    { requestCount: 1 }, { authMax: '1' }, { tokensDelivered: '1' }, { previousConsumption: '1' },
    { latestBuyerSig: null }, { latestSpendingAuthSig: '0x1234' },
  ])('preserves missing records with usage or unprovable authorizations: %j', async (overrides) => {
    const channel = await opening(1);
    store.upsertChannel({ ...channel, ...overrides });
    expireOpenings();
    await reconciler.reconcile();
    expect(store.getChannel(channel.sessionId)!.status).toBe('active');
  });

  it.each([
    { chainId: 1, contract: CONTRACT, amount: 1_000_000n },
    { chainId: 31337, contract: `0x${'bb'.repeat(20)}`, amount: 1_000_000n },
    { chainId: 31337, contract: CONTRACT, amount: 2_000_000n },
  ])('does not retire an opening signed for another chain, deployment, or unknown reserve ceiling: $chainId / $contract / $amount', async ({ chainId, contract, amount }) => {
    const channel = await opening(1);
    const signature = await signReserveAuth(identity.wallet, makeChannelsDomain(chainId, contract), {
      channelId: channel.sessionId, maxAmount: amount, deadline: BigInt(channel.deadline),
    });
    store.upsertChannel({ ...channel, latestBuyerSig: signature });
    expireOpenings();
    await reconciler.reconcile();
    expect(store.getChannel(channel.sessionId)!.status).toBe('active');
  });

  it('keeps records unchanged when RPC or the finalized-block lookup fails', async () => {
    const channel = await opening(1);
    expireOpenings();
    getBlock.mockRejectedValueOnce(new Error('RPC unavailable'));
    await reconciler.reconcile();
    expect(getSession).not.toHaveBeenCalled();
    getSession.mockRejectedValueOnce(new Error('RPC unavailable'));
    await reconciler.reconcile();
    expect(store.getChannel(channel.sessionId)!.status).toBe('active');
  });

  it('does not reconcile against an RPC serving the wrong chain or deployment', async () => {
    const channel = await opening(1);
    expireOpenings();
    domainSeparator.mockResolvedValue(TypedDataEncoder.hashDomain(makeChannelsDomain(1, CONTRACT)));
    await reconciler.reconcile();
    expect(getSession).not.toHaveBeenCalled();
    expect(store.getChannel(channel.sessionId)!.status).toBe('active');
  });

  it('does not retire a row changed while the on-chain read was in flight', async () => {
    const channel = await opening(1);
    expireOpenings();
    getSession.mockImplementationOnce(async () => {
      store.updateTokensDelivered(channel.sessionId, '10', 1);
      return EMPTY_CHANNEL;
    });
    await reconciler.reconcile();
    expect(store.getChannel(channel.sessionId)!.status).toBe('active');
    expect(onRetired).not.toHaveBeenCalled();
  });

  it('reconciles an older channel without invalidating the current channel for the same seller', async () => {
    const previous = await opening(1);
    vi.setSystemTime(Date.now() + 1_000);
    const current = await opening(1);
    setState(previous, 2, 123n);
    setState(current, 1);
    await reconciler.reconcile();
    expect(store.getChannel(previous.sessionId)).toMatchObject({ status: 'settled', settledAmount: '123' });
    expect(store.getChannel(current.sessionId)!.status).toBe('active');
    expect(onRetired).not.toHaveBeenCalled();
  });

  it('requires matching buyer and seller even for a positive terminal result', async () => {
    const channel = await opening(1);
    setState(channel, 2);
    states.get(channel.sessionId)!.buyer = `0x${'aa'.repeat(20)}`;
    await reconciler.reconcile();
    expect(store.getChannel(channel.sessionId)!.status).toBe('active');
  });

  it('resolves terminal channels through seller facades when the canonical record is absent', async () => {
    const channel = await opening(1);
    const info = { ...EMPTY_CHANNEL, buyer: channel.buyerEvmAddr, seller: channel.sellerEvmAddr, status: 3, settled: 50n };
    vi.mocked(ChannelsClient.prototype.getSession).mockResolvedValueOnce(info);
    await reconciler.reconcile();
    expect(store.getChannel(channel.sessionId)).toMatchObject({ status: 'timeout', settledAmount: '50' });
  });

  it('does not write after stop while an on-chain read is in flight', async () => {
    const channel = await opening(1);
    setState(channel, 2);
    getSession.mockImplementationOnce(async () => {
      reconciler.stop();
      return states.get(channel.sessionId)!;
    });
    await reconciler.reconcile();
    expect(store.getChannel(channel.sessionId)!.status).toBe('active');
  });

  it('starts immediately, polls without overlapping, and stops its timer', async () => {
    await opening(1);
    reconciler.start();
    const pending = reconciler.reconcile();
    expect(reconciler.reconcile()).toBe(pending);
    await pending;
    expect(getBlock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getBlock).toHaveBeenCalledTimes(2);
    reconciler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getBlock).toHaveBeenCalledTimes(2);
  });
});

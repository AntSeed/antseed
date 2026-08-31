import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet, verifyTypedData } from 'ethers';
import {
  RESERVE_AUTH_TYPES,
  SPENDING_AUTH_TYPES,
  computeChannelId,
  computeFreeUsageChannelId,
  makeChannelsDomain,
  peerIdToAddress,
} from '@antseed/protocol';
import type { BuyerSigner, BuyerIdentity } from '@antseed/buyer-core';

// Only the two network entry points are stubbed, and only so that `node.start()`
// reaches the buyer payment wiring without opening a socket: `DHTNode.start()`
// binds a UDP port and dials the bootstrap list, and `ConnectionManager.init()`
// prepares outbound transports. Everything downstream of them — _initializePayments,
// the ChannelStore, BuyerPaymentManager, BuyerPaymentNegotiator and
// BuyerFreeUsageManager — is the real code under test and is left alone. Every other
// export of both modules is passed through untouched.
vi.mock('../src/discovery/dht-node.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/discovery/dht-node.js')>();
  return {
    ...actual,
    DHTNode: class StubDHTNode {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      getPort(): number { return 0; }
      on(): void {}
      off(): void {}
    },
  };
});
vi.mock('../src/p2p/connection-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/p2p/connection-manager.js')>();
  return {
    ...actual,
    ConnectionManager: {
      init: async () => ({
        setLocalIdentity(): void {},
        on(): void {},
        off(): void {},
        closeAll(): void {},
      }),
    },
  };
});

import { AntseedNode } from '../src/node.js';
import { BuyerPaymentManager, type BuyerPaymentConfig } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator, type NegotiationEmitter } from '../src/payments/buyer-payment-negotiator.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import type { DepositsClient } from '../src/payments/evm/deposits-client.js';
import type { ChannelsClient } from '../src/payments/evm/channels-client.js';
import type { PaymentMux } from '../src/p2p/payment-mux.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerInfo, PeerId } from '../src/types/peer.js';
import type { SerializedHttpResponse, SerializedHttpRequest } from '../src/types/http.js';
import { bytesToHex } from '../src/utils/hex.js';
import { toPeerId } from '../src/types/peer.js';

const enc = new TextEncoder();

const CHANNELS_ADDRESS = '0x' + 'cc'.repeat(20);
const CHAIN_ID = 31337;
const RESERVE_MAX = 10_000_000n;
const CHANNELS_DOMAIN = makeChannelsDomain(CHAIN_ID, CHANNELS_ADDRESS);
/** Unreachable on purpose — nothing in this file performs an on-chain read. */
const DEAD_RPC_URL = 'http://127.0.0.1:8545';

/** Same helper as buyer-payment-manager.test.ts: an Identity from random bytes. */
function createTestIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

/** Generate a fake but valid-format peerId (40 hex chars) from a label. */
function fakePeerId(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(40, '0').slice(0, 40);
}

function createMockPaymentMux(): PaymentMux & { sentSpendingAuths: unknown[] } {
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
    rpcUrl: DEAD_RPC_URL,
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    channelsContractAddress: CHANNELS_ADDRESS,
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
    chainId: CHAIN_ID,
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 100_000n,
    maxReserveAmountUsdc: RESERVE_MAX,
    dataDir,
  };
}

const TEST_PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
const SAMPLE_INPUT = enc.encode('What is the capital of France?');
const SAMPLE_OUTPUT = enc.encode('The capital of France is Paris, on the Seine in northern France.');

/**
 * Build the payment identity exactly the way `AntseedNode._startBuyer` does:
 * the libp2p peerId, paired with either the identity wallet (default) or the
 * external `payments.buyerSigner`.
 *
 * Used only by the tests that need a real `BuyerPaymentManager` to sign. That the
 * node itself builds this same pairing is not assumed here — it is asserted against
 * the real construction path in section 0.
 */
function paymentIdentityFor(identity: Identity, buyerSigner?: BuyerSigner) {
  return buyerSigner
    ? { peerId: identity.peerId, wallet: buyerSigner }
    : identity;
}

/**
 * The ReserveAuth the seller actually receives. ChannelStore does not hydrate
 * the reserve fields back out (rowToChannel drops salt/deadline/sig), so read
 * them from the SpendingAuth frame the mux captured — that is the wire payload
 * the seller replays into `AntseedChannels.reserve()`.
 */
function reserveAuthFrame(mux: { sentSpendingAuths: unknown[] }, index = 0) {
  const sent = mux.sentSpendingAuths[index] as {
    channelId: string;
    spendingAuthSig: string;
    reserveSalt: string;
    reserveMaxAmount: string;
    reserveDeadline: number;
  };
  return sent;
}

/** Recover the signer of the ReserveAuth exactly as the contract does. */
function recoverReserveAuthSigner(frame: ReturnType<typeof reserveAuthFrame>): string {
  return verifyTypedData(
    CHANNELS_DOMAIN,
    RESERVE_AUTH_TYPES,
    {
      channelId: frame.channelId,
      maxAmount: BigInt(frame.reserveMaxAmount),
      deadline: BigInt(frame.reserveDeadline),
    },
    frame.spendingAuthSig,
  );
}

/**
 * Wire up just enough of a started buyer node to exercise the buyer-address
 * read paths, without starting a DHT or dialing any peer. Mirrors the
 * internals-injection style already used by cooperative-close-capability.test.ts.
 */
function makeBuyerNode(opts: {
  identity: Identity;
  buyerSigner?: BuyerSigner;
  channelStore?: ChannelStore;
  buyerPaymentManager?: BuyerPaymentManager;
}): AntseedNode {
  const node = new AntseedNode({ role: 'buyer' });
  const internals = node as unknown as {
    _identity: Identity | null;
    _buyerSigner: BuyerSigner | null;
    _channelStore: ChannelStore | null;
    _buyerPaymentManager: BuyerPaymentManager | null;
  };
  internals._identity = opts.identity;
  internals._buyerSigner = opts.buyerSigner ?? null;
  internals._channelStore = opts.channelStore ?? null;
  internals._buyerPaymentManager = opts.buyerPaymentManager ?? null;
  return node;
}

/**
 * Persist a channel row the way the managers do, without constructing a
 * `BuyerPaymentManager`: paid rows as `buyer-payment-manager.authorizeSpending`
 * writes them, free rows as `BuyerFreeUsageManager._persistSession` does.
 *
 * The read-path tests care about which buyer address a row is keyed under, not
 * about how it got written — that is section 2's job — so they seed directly.
 * It also keeps the whole read-path suite free of a `BuyerPaymentManager`, which
 * would otherwise build a JsonRpcProvider against the dead test RPC.
 */
function seedChannel(opts: {
  store: ChannelStore;
  buyerEvmAddr: string;
  sellerPeerId: string;
  kind: 'paid' | 'free';
  requestCount?: number;
  /** Buyer rows overload tokensDelivered as cumulative INPUT tokens. */
  inputTokens?: string;
  /** Buyer rows overload previousConsumption as cumulative OUTPUT tokens. */
  outputTokens?: string;
}): string {
  const { store, buyerEvmAddr, sellerPeerId, kind } = opts;
  const now = Date.now();
  const salt = '0x' + '11'.repeat(32);
  const sellerEvmAddr = peerIdToAddress(sellerPeerId);
  const sessionId = kind === 'free'
    ? computeFreeUsageChannelId(buyerEvmAddr, sellerEvmAddr, salt)
    : computeChannelId(buyerEvmAddr, sellerEvmAddr, salt);
  store.upsertChannel({
    sessionId,
    peerId: sellerPeerId,
    role: 'buyer',
    channelKind: kind,
    sellerEvmAddr,
    buyerEvmAddr,
    nonce: 0,
    authMax: kind === 'free' ? '0' : '50000',
    deadline: Math.floor(now / 1000) + 3600,
    previousSessionId: '0x' + '00'.repeat(32),
    previousConsumption: opts.outputTokens ?? '7',
    tokensDelivered: opts.inputTokens ?? '13',
    requestCount: opts.requestCount ?? 2,
    reservedAt: now,
    settledAt: null,
    settledAmount: null,
    status: 'active',
    latestBuyerSig: null,
    latestSpendingAuthSig: null,
    latestMetadata: null,
    createdAt: now,
    updatedAt: now,
  });
  return sessionId;
}

const createdManagers: BuyerPaymentManager[] = [];

/**
 * Construct a BuyerPaymentManager and remember it, so afterEach can destroy the RPC
 * provider it creates. Use this instead of `new BuyerPaymentManager(...)` in this file.
 */
function newManager(
  identity: BuyerIdentity,
  config: BuyerPaymentConfig,
  channelStore: ChannelStore,
): BuyerPaymentManager {
  const m = new BuyerPaymentManager(identity, config, channelStore);
  createdManagers.push(m);
  return m;
}

describe('external buyer payment signer', () => {
  let tempDir: string;
  let identity: Identity;
  let store: ChannelStore;
  let mux: ReturnType<typeof createMockPaymentMux>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ext-buyer-signer-'));
    identity = createTestIdentity();
    store = new ChannelStore(tempDir);
    mux = createMockPaymentMux();
  });

  afterEach(() => {
    // Each BuyerPaymentManager builds a JsonRpcProvider against the (deliberately
    // dead) test RPC. Release them so no socket or timer outlives the test.
    for (const m of createdManagers.splice(0)) {
      try { m.depositsClient.provider.destroy(); } catch { /* already gone */ }
    }
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 0. The node's own construction path ────────────────────────

  describe('the wiring _startBuyer actually builds', () => {
    // Every other section builds the payment identity itself and hands it to a
    // manager. This one does not: it starts a real buyer node from a NodeConfig
    // and asserts on what `_startBuyer` constructed. That distinction matters,
    // because the first cut of this patch passed the right identity to the
    // payment manager and the libp2p identity to the negotiator, which type-checked
    // perfectly and made every paid request fail `insufficient_deposits`. A test
    // that rebuilds the wiring cannot catch that; only starting the node can.

    let nodeTempDir: string;
    let node: AntseedNode | null;

    beforeEach(() => {
      nodeTempDir = mkdtempSync(join(tmpdir(), 'ext-buyer-signer-node-'));
      node = null;
    });

    afterEach(async () => {
      // stop() closes the ChannelStore, stops the RPC health monitor and releases
      // the stubbed DHT/ConnectionManager.
      if (node) { try { await node.stop(); } catch { /* nothing to unwind */ } }
      rmSync(nodeTempDir, { recursive: true, force: true });
    });

    function startNode(buyerSigner?: BuyerSigner): Promise<void> {
      node = new AntseedNode({
        role: 'buyer',
        dataDir: nodeTempDir,
        // Keep the (stubbed) DHT off the official bootstrap list entirely.
        noOfficialBootstrap: true,
        bootstrapNodes: [],
        payments: {
          enabled: true,
          rpcUrl: DEAD_RPC_URL,
          depositsAddress: '0x' + 'dd'.repeat(20),
          channelsAddress: CHANNELS_ADDRESS,
          usdcAddress: '0x' + 'ee'.repeat(20),
          identityRegistryAddress: '0x' + 'ff'.repeat(20),
          freeUsageAddress: '0x' + 'fa'.repeat(20),
          chainId: CHAIN_ID,
          ...(buyerSigner ? { buyerSigner } : {}),
        },
      });
      return node.start();
    }

    /**
     * The address a money component will actually use. `BuyerPaymentManager` sets
     * `_signer = identity.wallet` and `BuyerPaymentNegotiator.handle402` prechecks
     * `_identity.wallet.address` — so this reads the exact field each one pays from.
     */
    function buyerAddressOf(component: unknown): string {
      return (component as { _identity: BuyerIdentity })._identity.wallet.address;
    }

    it('gives the negotiator the external signer as its buyer, not the libp2p identity', async () => {
      const buyerSigner = Wallet.createRandom();
      await startNode(buyerSigner);

      const libp2pAddress = (node as unknown as { _identity: Identity })._identity.wallet.address;
      expect(libp2pAddress).not.toBe(buyerSigner.address);

      // The regression from round 1 lived exactly here.
      expect(node!.buyerNegotiator).not.toBeNull();
      expect(buyerAddressOf(node!.buyerNegotiator)).toBe(buyerSigner.address);
    });

    it('gives the payment manager, free-usage manager and buyerAddress the same signer', async () => {
      const buyerSigner = Wallet.createRandom();
      await startNode(buyerSigner);

      const freeUsageManager = (node as unknown as { _buyerFreeUsageManager: unknown })._buyerFreeUsageManager;
      expect(node!.buyerPaymentManager).not.toBeNull();
      expect(freeUsageManager).not.toBeNull();

      // All four must name one address. A split between any two of them is the
      // failure mode this patch exists to prevent.
      expect(buyerAddressOf(node!.buyerPaymentManager)).toBe(buyerSigner.address);
      expect(buyerAddressOf(freeUsageManager)).toBe(buyerSigner.address);
      expect(node!.buyerAddress).toBe(buyerSigner.address);
      expect(buyerAddressOf(node!.buyerNegotiator)).toBe(buyerSigner.address);
    });

    it('still pays from the libp2p identity when no buyerSigner is configured', async () => {
      await startNode();

      const libp2pAddress = (node as unknown as { _identity: Identity })._identity.wallet.address;
      const freeUsageManager = (node as unknown as { _buyerFreeUsageManager: unknown })._buyerFreeUsageManager;

      expect(node!.buyerAddress).toBe(libp2pAddress);
      expect(buyerAddressOf(node!.buyerPaymentManager)).toBe(libp2pAddress);
      expect(buyerAddressOf(node!.buyerNegotiator)).toBe(libp2pAddress);
      expect(buyerAddressOf(freeUsageManager)).toBe(libp2pAddress);
    });
  });

  // ── 1. Default path is unchanged ───────────────────────────────

  describe('default path (no payments.buyerSigner)', () => {
    it('the buyer address is still the libp2p identity wallet', () => {
      const node = makeBuyerNode({ identity });
      expect(node.buyerAddress).toBe(identity.wallet.address);
    });

    it('records the identity wallet as the channel buyer and derives the channelId from it', async () => {
      const manager = newManager(
        paymentIdentityFor(identity),
        makeConfig(tempDir),
        store,
      );
      const sellerPeerId = fakePeerId('seller-default');

      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

      const channel = store.getChannel(channelId)!;
      expect(channel.buyerEvmAddr).toBe(identity.wallet.address);
      expect(channelId).toBe(computeChannelId(
        identity.wallet.address,
        peerIdToAddress(sellerPeerId),
        reserveAuthFrame(mux).reserveSalt,
      ));
    });

    it('the ReserveAuth recovers to the identity wallet recorded as buyer', async () => {
      const manager = newManager(
        paymentIdentityFor(identity),
        makeConfig(tempDir),
        store,
      );
      const sellerPeerId = fakePeerId('seller-default-sig');

      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
      const channel = store.getChannel(channelId)!;

      const recovered = recoverReserveAuthSigner(reserveAuthFrame(mux));
      expect(recovered).toBe(channel.buyerEvmAddr);
      expect(recovered).toBe(identity.wallet.address);
    });

    it('finds its own channels through every buyer-address read path', () => {
      const sellerPeerId = fakePeerId('seller-default-read');
      const channelId = seedChannel({
        store, buyerEvmAddr: identity.wallet.address, sellerPeerId, kind: 'paid',
      });

      const node = makeBuyerNode({ identity, channelStore: store });

      expect(node.getActiveBuyerChannels().map((c) => c.channelId)).toEqual([channelId]);
      expect(node.getAllBuyerChannels().map((c) => c.channelId)).toEqual([channelId]);
      expect(node.getBuyerUsageTotals().activeChannels).toBe(1);
      expect(node.getMeteringStatsByPeer(sellerPeerId)?.channelStatus).toBe('active');
    });
  });

  // ── 2. An external signer becomes the on-chain buyer ───────────

  describe('with payments.buyerSigner configured', () => {
    it('the buyer address is the external signer, not the libp2p identity', () => {
      const buyerSigner = Wallet.createRandom();
      const node = makeBuyerNode({ identity, buyerSigner });

      expect(node.buyerAddress).toBe(buyerSigner.address);
      expect(node.buyerAddress).not.toBe(identity.wallet.address);
    });

    it('records the external signer as the channel buyer and derives the channelId from it', async () => {
      const buyerSigner = Wallet.createRandom();
      const manager = newManager(
        paymentIdentityFor(identity, buyerSigner),
        makeConfig(tempDir),
        store,
      );
      const sellerPeerId = fakePeerId('seller-external');

      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

      const channel = store.getChannel(channelId)!;
      expect(channel.buyerEvmAddr).toBe(buyerSigner.address);
      expect(channel.buyerEvmAddr).not.toBe(identity.wallet.address);
      expect(channelId).toBe(computeChannelId(
        buyerSigner.address,
        peerIdToAddress(sellerPeerId),
        reserveAuthFrame(mux).reserveSalt,
      ));
      // The libp2p identity keeps peer identity — the channel is still with this peer.
      expect(channel.peerId).toBe(sellerPeerId);
    });
  });

  // ── 3. Signer and buyer address cannot diverge ─────────────────

  describe('signature/buyer-address invariant', () => {
    // AntseedChannels._verifySignature does a strict
    // `ECDSA.recover(digest, sig) == channel.buyer` with no ERC-1271 fallback,
    // so a signature that does not recover to the recorded buyer is rejected
    // on-chain by reserve(). Assert recovery rather than trusting construction.

    it('the ReserveAuth recovers to the external signer recorded as buyer', async () => {
      const buyerSigner = Wallet.createRandom();
      const manager = newManager(
        paymentIdentityFor(identity, buyerSigner),
        makeConfig(tempDir),
        store,
      );
      const sellerPeerId = fakePeerId('seller-reserve-recover');

      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
      const channel = store.getChannel(channelId)!;

      const recovered = recoverReserveAuthSigner(reserveAuthFrame(mux));
      expect(recovered).toBe(channel.buyerEvmAddr);
      expect(recovered).toBe(buyerSigner.address);
      expect(recovered).not.toBe(identity.wallet.address);
    });

    it('the per-request SpendingAuth recovers to the external signer recorded as buyer', async () => {
      const buyerSigner = Wallet.createRandom();
      const manager = newManager(
        paymentIdentityFor(identity, buyerSigner),
        makeConfig(tempDir),
        store,
      );
      const sellerPeerId = fakePeerId('seller-spending-recover');

      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);
      await manager.handleAuthAck(sellerPeerId, { channelId });

      const { payload } = await manager.signPerRequestAuth(sellerPeerId, {
        inputBytes: SAMPLE_INPUT,
        outputBytes: SAMPLE_OUTPUT,
        sellerClaimedCost: 1_000n,
      });

      const recovered = verifyTypedData(
        CHANNELS_DOMAIN,
        SPENDING_AUTH_TYPES,
        {
          channelId: payload.channelId,
          cumulativeAmount: BigInt(payload.cumulativeAmount),
          metadataHash: payload.metadataHash,
        },
        payload.spendingAuthSig,
      );
      expect(recovered).toBe(store.getChannel(channelId)!.buyerEvmAddr);
      expect(recovered).toBe(buyerSigner.address);
    });

    it('the channelId the seller reserves against is derived from the signing address', async () => {
      // reserve() recomputes keccak256(abi.encode(buyer, seller, salt)) on-chain
      // from the recovered buyer. If the channelId were derived from the libp2p
      // identity while the external signer signed, the seller's reserve() would
      // compute a different channelId and the ReserveAuth would not match.
      const buyerSigner = Wallet.createRandom();
      const manager = newManager(
        paymentIdentityFor(identity, buyerSigner),
        makeConfig(tempDir),
        store,
      );
      const sellerPeerId = fakePeerId('seller-channelid');

      const channelId = await manager.authorizeSpending(sellerPeerId, mux, 50_000n, TEST_PRICING);

      const recovered = recoverReserveAuthSigner(reserveAuthFrame(mux));
      const recomputed = computeChannelId(
        recovered,
        peerIdToAddress(sellerPeerId),
        reserveAuthFrame(mux).reserveSalt,
      );
      expect(recomputed).toBe(channelId);
    });
  });

  // ── 4. Buyer-address read paths follow the signer ──────────────

  describe('buyer-address read paths', () => {
    // These seed the channel row directly (see seedChannel). That the row is
    // written under the signer address in the first place is section 2's
    // assertion; what is under test here is which address the node reads back.
    const SELLER = fakePeerId('seller-read-paths');

    it('getActiveBuyerChannels returns the external signer\'s channels, attributed to it', () => {
      const buyerSigner = Wallet.createRandom();
      const channelId = seedChannel({
        store, buyerEvmAddr: buyerSigner.address, sellerPeerId: SELLER, kind: 'paid',
      });
      const node = makeBuyerNode({ identity, buyerSigner, channelStore: store });

      const active = node.getActiveBuyerChannels();
      expect(active.map((c) => c.channelId)).toEqual([channelId]);
      expect(active[0]!.buyer).toBe(buyerSigner.address);
    });

    it('getAllBuyerChannels returns the external signer\'s channels', () => {
      const buyerSigner = Wallet.createRandom();
      const channelId = seedChannel({
        store, buyerEvmAddr: buyerSigner.address, sellerPeerId: SELLER, kind: 'paid',
      });
      const node = makeBuyerNode({ identity, buyerSigner, channelStore: store });

      expect(node.getAllBuyerChannels().map((c) => c.channelId)).toEqual([channelId]);
    });

    it('getBuyerUsageTotals counts the external signer\'s channels', () => {
      const buyerSigner = Wallet.createRandom();
      seedChannel({ store, buyerEvmAddr: buyerSigner.address, sellerPeerId: SELLER, kind: 'paid' });
      const node = makeBuyerNode({ identity, buyerSigner, channelStore: store });

      expect(node.getBuyerUsageTotals().activeChannels).toBe(1);
      expect(node.getBuyerUsageTotals().uniqueSellers).toBe(1);
    });

    it('getMeteringStatsByPeer finds the external signer\'s channel for that seller', () => {
      const buyerSigner = Wallet.createRandom();
      seedChannel({ store, buyerEvmAddr: buyerSigner.address, sellerPeerId: SELLER, kind: 'paid' });
      const node = makeBuyerNode({ identity, buyerSigner, channelStore: store });

      expect(node.getMeteringStatsByPeer(SELLER)?.channelStatus).toBe('active');
    });

    it('the read paths are actually keyed on the signer: an identity-keyed node sees nothing', () => {
      // The regression this guards: if any read path still resolved the buyer
      // address from _identity.wallet.address, a node with an external signer
      // would query under the wrong address and silently return empty. Dropping
      // the signer here reproduces exactly that lookup, and it must come back
      // empty — which is what makes the four assertions above meaningful.
      const buyerSigner = Wallet.createRandom();
      seedChannel({ store, buyerEvmAddr: buyerSigner.address, sellerPeerId: SELLER, kind: 'paid' });
      const identityKeyedNode = makeBuyerNode({ identity, channelStore: store });

      expect(identityKeyedNode.buyerAddress).toBe(identity.wallet.address);
      expect(identityKeyedNode.getActiveBuyerChannels()).toEqual([]);
      expect(identityKeyedNode.getAllBuyerChannels()).toEqual([]);
      expect(identityKeyedNode.getBuyerUsageTotals().activeChannels).toBe(0);
      expect(identityKeyedNode.getMeteringStatsByPeer(SELLER)?.channelStatus).toBeNull();
    });
  });

  // ── 5. A signer with no synchronous address ────────────────────

  describe('a signer without a synchronous address', () => {
    // `BuyerSigner` is `AbstractSigner & { readonly address: string }`, so tsc
    // rejects this at the call site. These cover the JS caller, and the
    // AbstractSigner subclass whose `address` is only populated asynchronously.
    function addresslessSigner(): BuyerSigner {
      const w = Wallet.createRandom();
      return new Proxy(w, {
        get(target, prop, receiver) {
          if (prop === 'address') return undefined;
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as BuyerSigner;
    }

    it('does not mis-address a channel: authorizeSpending fails and persists nothing', async () => {
      const manager = newManager(
        paymentIdentityFor(identity, addresslessSigner()),
        makeConfig(tempDir),
        store,
      );

      // computeChannelId cannot ABI-encode an undefined address, so this dies
      // before any ReserveAuth is signed or any row is written.
      await expect(
        manager.authorizeSpending(fakePeerId('seller-addressless'), mux, 50_000n, TEST_PRICING),
      ).rejects.toThrow(/invalid address/);
      expect(mux.sentSpendingAuths).toHaveLength(0);
      expect(store.getActiveChannelsByBuyer('buyer', identity.wallet.address)).toEqual([]);
    });

    it('node.buyerAddress reports null rather than naming an address that can never pay', () => {
      // `_buyerEvmAddress` deliberately does NOT use
      // `this._buyerSigner?.address ?? this._identity?.wallet.address`: that would make an
      // addressless signer indistinguishable from "no signer configured" and fall through to
      // the libp2p identity.
      //
      // No payment is mis-addressed either way — no channel can be opened in this state, see
      // the test above. But `buyerAddress` exists to tell an operator which address to fund,
      // and naming the identity wallet there would name an address that will never be the
      // buyer. Null is the honest answer for an unusable configuration.
      const node = makeBuyerNode({ identity, buyerSigner: addresslessSigner() });

      expect(node.buyerAddress).toBeNull();
      expect(node.buyerAddress).not.toBe(identity.wallet.address);
    });
  });

  // ── 6. Free usage follows the payment identity too ─────────────

  describe('free-usage sessions (also keyed on payments.buyerSigner)', () => {
    // BuyerFreeUsageManager is constructed with the same payment identity as the
    // paid path, so free channels are opened and recorded under the external
    // signer when one is configured. That has to match `getBuyerUsageTotals`,
    // which reads free channels under the *paid* buyer address — if the free
    // manager kept the libp2p identity, free traffic would silently stop being
    // counted. Section 0 asserts the construction; these assert the consequence.

    it('counts free usage on the default path', () => {
      seedChannel({
        store, buyerEvmAddr: identity.wallet.address,
        sellerPeerId: fakePeerId('seller-free-default'), kind: 'free',
      });
      const node = makeBuyerNode({ identity, channelStore: store });

      const totals = node.getBuyerUsageTotals();
      expect(totals.totalRequests).toBe(2);
      expect(totals.totalInputTokens).toBe('13');
      expect(totals.totalOutputTokens).toBe('7');
    });

    it('counts free usage under the external signer, so the totals do not silently drop it', () => {
      // An earlier revision gave the free manager the raw libp2p identity while the
      // totals query used the signer address, and free traffic vanished from the
      // usage tiles. This is the regression guard for that.
      const buyerSigner = Wallet.createRandom();
      seedChannel({
        store, buyerEvmAddr: buyerSigner.address,
        sellerPeerId: fakePeerId('seller-free-ext'), kind: 'free',
      });
      const node = makeBuyerNode({ identity, buyerSigner, channelStore: store });

      const totals = node.getBuyerUsageTotals();
      expect(totals.totalRequests).toBe(2);
      expect(totals.totalInputTokens).toBe('13');
      expect(totals.totalOutputTokens).toBe('7');
    });

    it('free channels left under the old identity address are not counted for an external signer', () => {
      // The flip side of the above, pinned so the address the totals key on stays explicit:
      // a row written under the libp2p identity is not attributed to an external buyer.
      const buyerSigner = Wallet.createRandom();
      seedChannel({
        store, buyerEvmAddr: identity.wallet.address,
        sellerPeerId: fakePeerId('seller-free-stale'), kind: 'free',
      });
      const node = makeBuyerNode({ identity, buyerSigner, channelStore: store });

      expect(node.getBuyerUsageTotals().totalRequests).toBe(0);
    });
  });

  // ── 7. The negotiator's deposit precheck ───────────────────────

  describe('handle402 deposit-balance precheck', () => {
    // This is the line that made the feature inert in the first cut: handle402
    // reads the deposit balance of `_identity.wallet.address` before signing
    // anything, so a negotiator holding the libp2p identity looks up an address
    // with no deposits and returns `insufficient_deposits` on every paid request.
    // Mocks follow buyer-payment-negotiator.test.ts, so nothing here builds a
    // ChannelStore or an RPC provider.

    const SELLER_PEER_ID = 'b'.repeat(40) as PeerId;

    function mockBpm(): BuyerPaymentManager {
      return {
        authorizeSpending: vi.fn().mockResolvedValue(undefined),
        isLockConfirmed: vi.fn().mockReturnValue(true),
        isLockRejected: vi.fn().mockReturnValue(false),
        getActiveSession: vi.fn().mockReturnValue(null),
        hasPendingReserveAuth: vi.fn().mockReturnValue(false),
        canReplayReserveAuth: vi.fn().mockReturnValue(false),
        clearLockConfirmation: vi.fn(),
        cleanupSession: vi.fn(),
        getCumulativeAmount: vi.fn().mockReturnValue(0n),
        getSessionPricing: vi.fn().mockReturnValue(null),
        maxPerRequestUsdc: 100_000n,
        maxReserveAmountUsdc: RESERVE_MAX,
      } as unknown as BuyerPaymentManager;
    }

    /** Records which address the precheck asked about, and funds it. */
    function recordingDepositsClient(queried: string[]): DepositsClient {
      return {
        getBuyerBalance: vi.fn(async (addr: string) => {
          queried.push(addr);
          return { available: 1_000_000n, reserved: 0n, lastActivityAt: 0n };
        }),
      } as unknown as DepositsClient;
    }

    function make402Response(): SerializedHttpResponse {
      return {
        requestId: 'req-1',
        statusCode: 402,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({})),
      };
    }

    function makeRequest(): SerializedHttpRequest {
      return {
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({ model: 'gpt-4', messages: [] })),
      };
    }

    function makeNegotiator(paymentIdentity: BuyerIdentity, deposits: DepositsClient) {
      const negotiator = new BuyerPaymentNegotiator(
        paymentIdentity as unknown as Identity,
        mockBpm(),
        deposits,
        { getSession: vi.fn().mockResolvedValue(null) } as unknown as ChannelsClient,
        { upsertChannel: vi.fn(), getActiveChannelByPeer: vi.fn().mockReturnValue(null) } as never,
        {},
        { emit: vi.fn() } as NegotiationEmitter,
      );
      const conn = { send: vi.fn() } as unknown as PeerConnection;
      // Pre-buffer the seller's requirements so handle402 does not wait 2s for a frame.
      (negotiator as unknown as { _bufferedPaymentRequired: Map<string, unknown> })
        ._bufferedPaymentRequired.set(SELLER_PEER_ID, {
          minBudgetPerRequest: '10000',
          suggestedAmount: '100000',
          requestId: 'req-1',
        });
      return { negotiator, conn };
    }

    const peer = {
      peerId: SELLER_PEER_ID,
      lastSeen: Date.now(),
      providers: ['openai'],
      defaultInputUsdPerMillion: 3,
      defaultOutputUsdPerMillion: 15,
    } as PeerInfo;

    it('prechecks the external signer\'s balance, not the libp2p identity\'s', async () => {
      const buyerSigner = Wallet.createRandom();
      const queried: string[] = [];
      const { negotiator, conn } = makeNegotiator(
        paymentIdentityFor(identity, buyerSigner),
        recordingDepositsClient(queried),
      );

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(queried).toEqual([buyerSigner.address]);
      expect(queried).not.toContain(identity.wallet.address);
      // Funded buyer, so negotiation proceeds rather than short-circuiting on deposits.
      expect(result.action).toBe('retry');
    });

    it('an identity-keyed negotiator asks about the wrong address — the round 1 failure', async () => {
      // Reproduces what shipped in the first cut: the negotiator holds the libp2p
      // identity while the external signer holds the money. The lookup goes to an
      // address with no deposits, and every paid request dies before signing.
      const buyerSigner = Wallet.createRandom();
      const queried: string[] = [];
      const deposits = {
        getBuyerBalance: vi.fn(async (addr: string) => {
          queried.push(addr);
          // Only the external signer is funded; the libp2p identity is empty.
          return addr === buyerSigner.address
            ? { available: 1_000_000n, reserved: 0n, lastActivityAt: 0n }
            : { available: 0n, reserved: 0n, lastActivityAt: 0n };
        }),
      } as unknown as DepositsClient;
      const { negotiator, conn } = makeNegotiator(identity, deposits);

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(queried).toEqual([identity.wallet.address]);
      expect(result.action).toBe('return');
      const res = (result as { action: 'return'; response: SerializedHttpResponse }).response;
      expect(JSON.parse(new TextDecoder().decode(res.body))).toMatchObject({
        error: 'payment_required',
        code: 'insufficient_deposits',
      });
    });
  });
});

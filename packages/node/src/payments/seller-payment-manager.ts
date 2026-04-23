import { type AbstractSigner, verifyTypedData } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  PaymentRequiredPayload,
} from '../types/protocol.js';
import { ChannelsClient } from './evm/channels-client.js';
import {
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  makeChannelsDomain,
  encodeMetadata,
  ZERO_METADATA,
} from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { peerIdToAddress } from '../types/peer.js';
import { ChannelStore, type StoredChannel } from './channel-store.js';
import { classifyOnChainChannel, matchesChannelParties } from './channel-session-state.js';

export interface SellerPaymentConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  channelsContractAddress: string;
  chainId: number;
  dataDir: string;
  /** Minimum USDC per request (base units). Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Whether to immediately settle when buyer disconnects. Default: true. */
  settleOnDisconnect?: boolean;
  /**
   * Minimum unsettled delta (base units) required before idle settle will
   * submit a tx. Skips tiny settles whose gas cost exceeds the amount being
   * claimed. Only applied in `settleOnly` mode — final close() always settles
   * the full amount so no dust is left behind. Default: "2000" (~$0.002).
   */
  minSettleDelta?: string;
}

/** Default minimum budget per request: $0.50 USDC (base units). */
const DEFAULT_MIN_BUDGET_PER_REQUEST = '500000';

/** ~200× typical Base settle gas cost at 0.006 gwei. */
export const DEFAULT_MIN_SETTLE_DELTA_STR = '2000';
const DEFAULT_MIN_SETTLE_DELTA = BigInt(DEFAULT_MIN_SETTLE_DELTA_STR);

/** Stored auth entry for buyer's SpendingAuth signature. */
interface LatestAuth {
  spendingAuthSig: string;
  cumulativeAmount: bigint;
  metadataHash: string;
  metadata: string;
}

/**
 * Manages seller-side payment sessions.
 * The buyer sends a single SpendingAuth signature with a monotonically
 * increasing cumulativeAmount on every request.
 * The seller tracks spending locally and settles/closes via the contract at session end.
 */
export class SellerPaymentManager {
  private readonly _signer: AbstractSigner;
  private readonly _channelsClient: ChannelsClient;
  private readonly _config: SellerPaymentConfig;
  private readonly _channelStore: ChannelStore;
  /** Lazily resolved: real AntseedChannels address (for EIP-712 domain +
   *  on-chain seller address detection). If the configured
   *  `channelsContractAddress` is a seller facade (e.g. DiemStakingProxy),
   *  this resolves to the underlying channels contract via the facade's
   *  `channelsAddress()` view. Otherwise equals the configured address. */
  private _resolvedAddresses: Promise<{
    /** Underlying AntseedChannels address — used for the EIP-712 domain. */
    channels: string;
    /** On-chain seller address: proxy when behind a facade, wallet otherwise. */
    seller: string;
  }> | null = null;
  /** In-memory cache of active buyer peerIds for fast has-session checks. */
  private readonly _activeBuyers = new Set<string>();
  /** Per-buyer mutex to prevent concurrent handleSpendingAuth for the same buyer. */
  private readonly _buyerLocks = new Map<string, Promise<void>>();

  /** channelId -> highest accepted cumulativeAmount from buyer's SpendingAuth */
  private readonly _acceptedCumulative = new Map<string, bigint>();

  /** channelId -> total USDC spent so far (sum of recordSpend calls) */
  private readonly _spent = new Map<string, bigint>();

  /** channelId -> on-chain reserveMaxAmount (budget ceiling from ReserveAuth) */
  private readonly _reserveMax = new Map<string, bigint>();

  /** channelId -> latest buyer-signed auth (both sigs + cumulative values + metadata) for settle/close */
  private readonly _latestAuth = new Map<string, LatestAuth>();

  /**
   * channelId -> waiters blocked on acceptedCumulative reaching a target.
   * Used to hide the NeedAuth → SpendingAuth round-trip latency from the next
   * request: if a new request arrives while the prior response's NeedAuth is
   * still on the wire, the request handler parks on this waiter instead of
   * 402ing immediately.
   */
  private readonly _acceptedWaiters = new Map<string, Array<{ target: bigint; resolve: () => void }>>();

  /** channelId -> number of failed close() attempts. In-memory only; resets on node restart. */
  private readonly _closeRetryCount = new Map<string, number>();

  /** channelId -> cumulative amount last successfully settled on-chain by this
   *  process. Lets the idle-settle loop skip the `getSession` RPC when the
   *  local accepted cumulative hasn't moved since our last settle. */
  private readonly _lastSettledCumulative = new Map<string, bigint>();

  private readonly _minSettleDelta: bigint;

  /** Max close() retries before giving up (buyer must requestClose on-chain) */
  private static readonly MAX_CLOSE_RETRIES = 3;

  constructor(identity: Identity, config: SellerPaymentConfig, channelStore: ChannelStore) {
    this._config = config;
    this._signer = identity.wallet;
    const channelsClient = new ChannelsClient({
      rpcUrl: config.rpcUrl,
      ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
      contractAddress: config.channelsContractAddress,
      evmChainId: config.chainId,
    });
    this._channelsClient = channelsClient;
    // Kick off address resolution in the background; every async call site
    // awaits `_resolvedAddresses` before using the EIP-712 domain or the
    // on-chain seller address.
    const identityAddress = identity.wallet.address;
    this._resolvedAddresses = (async () => {
      const channels = await channelsClient.readAddress;
      const configured = channelsClient.contractAddress;
      const seller = channels.toLowerCase() !== configured.toLowerCase()
        ? configured      // facade mode: seller on-chain = proxy = configured addr
        : identityAddress; // no facade: seller = peer wallet
      return { channels, seller };
    })();
    this._channelStore = channelStore;
    this._minSettleDelta = config.minSettleDelta !== undefined
      ? BigInt(config.minSettleDelta)
      : DEFAULT_MIN_SETTLE_DELTA;

    // Hydrate from persisted channels
    const activeChannels = this._channelStore.getActiveChannels('seller');
    for (const channel of activeChannels) {
      this._activeBuyers.add(channel.peerId);
      this._acceptedCumulative.set(channel.sessionId, BigInt(channel.authMax));
      this._spent.set(channel.sessionId, BigInt(channel.tokensDelivered));
      // Hydrate reserveMax from previousConsumption (repurposed field)
      const storedReserveMax = BigInt(channel.previousConsumption || '0');
      if (storedReserveMax > 0n) {
        this._reserveMax.set(channel.sessionId, storedReserveMax);
      }
      // Hydrate latest auth sigs so close() works after restart
      if (channel.latestSpendingAuthSig) {
        this._latestAuth.set(channel.sessionId, {
          spendingAuthSig: channel.latestSpendingAuthSig,
          cumulativeAmount: BigInt(channel.authMax),
          metadataHash: '',
          metadata: channel.latestMetadata ?? '',
        });
      }
    }
  }

  /**
   * Validate hydrated channels against on-chain state.
   * Evicts channels that no longer exist or are no longer active on-chain.
   * Must be called after construction (async, cannot run in constructor).
   */
  async validateHydratedChannels(): Promise<void> {
    const activeChannels = this._channelStore.getActiveChannels('seller');
    if (activeChannels.length === 0) return;

    const { seller: sellerEvmAddr } = await this._resolvedAddresses!;
    let evicted = 0;

    for (const channel of activeChannels) {
      try {
        const onChainState = classifyOnChainChannel(
          await this._channelsClient.getSession(channel.sessionId),
        );

        if (!onChainState.exists || (onChainState.status !== 'active' && onChainState.status !== 'unknown')) {
          this._evictStaleChannel(channel.sessionId, channel.peerId, `on-chain status=${onChainState.exists ? onChainState.status : 'missing'}`);
          evicted++;
          continue;
        }

        if (!matchesChannelParties(onChainState.channel, channel.buyerEvmAddr, sellerEvmAddr)) {
          this._evictStaleChannel(channel.sessionId, channel.peerId, 'on-chain parties mismatch');
          evicted++;
          continue;
        }

        // Reconcile: if on-chain settled > local spent, update local to avoid double-charging
        const onChainSettled = onChainState.channel.settled;
        const localSpent = this._spent.get(channel.sessionId) ?? 0n;
        if (onChainSettled > localSpent) {
          this._spent.set(channel.sessionId, onChainSettled);
          // Clear auth only if its cumulative would revert settle() with InvalidAmount
          // (cumulativeAmount must be > on-chain settled). If auth is still valid
          // (cumulative > settled), keep it so the seller can close if buyer disconnects.
          const existingAuth = this._latestAuth.get(channel.sessionId);
          if (existingAuth && existingAuth.cumulativeAmount <= onChainSettled) {
            this._latestAuth.delete(channel.sessionId);
            debugLog(`[SellerPayment] Reconciled spent for ${channel.sessionId.slice(0, 18)}...: local=${localSpent} → on-chain=${onChainSettled} (cleared stale auth, authCumulative=${existingAuth.cumulativeAmount})`);
          } else {
            debugLog(`[SellerPayment] Reconciled spent for ${channel.sessionId.slice(0, 18)}...: local=${localSpent} → on-chain=${onChainSettled}`);
          }
        }
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to validate channel ${channel.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
        // Keep channel hydrated on RPC failure — periodic check will retry
      }
    }

    if (evicted > 0) {
      debugLog(`[SellerPayment] Startup validation: evicted ${evicted}/${activeChannels.length} stale channel(s)`);
    }
  }

  private _evictStaleChannel(channelId: string, peerId: string, reason: string, status: 'settled' | 'timeout' = 'settled'): void {
    this._channelStore.updateChannelStatus(channelId, status);
    this._acceptedCumulative.delete(channelId);
    this._spent.delete(channelId);
    this._latestAuth.delete(channelId);
    this._closeRetryCount.delete(channelId);
    this._reserveMax.delete(channelId);
    this._lastSettledCumulative.delete(channelId);
    this._releaseAcceptedWaiters(channelId);
    this._activeBuyers.delete(peerId);
    debugLog(`[SellerPayment] Evicted stale channel ${channelId.slice(0, 18)}... — ${reason}`);
  }

  /**
   * Block until `acceptedCumulative(channelId)` reaches `target`, or `timeoutMs`
   * elapses. Returns true if the target was reached, false on timeout. Used by
   * the request handler to wait out the buyer's NeedAuth → SpendingAuth round
   * trip when a follow-up request arrives before the catch-up auth has landed.
   */
  awaitAcceptedAtLeast(channelId: string, target: bigint, timeoutMs: number): Promise<boolean> {
    const current = this._acceptedCumulative.get(channelId) ?? 0n;
    if (current >= target) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const waiter = {
        target,
        resolve: () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true);
        },
      };
      const waiters = this._acceptedWaiters.get(channelId) ?? [];
      waiters.push(waiter);
      this._acceptedWaiters.set(channelId, waiters);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const current = this._acceptedWaiters.get(channelId);
        if (current) {
          const filtered = current.filter((w) => w !== waiter);
          if (filtered.length > 0) this._acceptedWaiters.set(channelId, filtered);
          else this._acceptedWaiters.delete(channelId);
        }
        resolve(false);
      }, timeoutMs);
    });
  }

  private _notifyAcceptedUpdate(channelId: string, newAccepted: bigint): void {
    const waiters = this._acceptedWaiters.get(channelId);
    if (!waiters || waiters.length === 0) return;
    const remaining: typeof waiters = [];
    for (const w of waiters) {
      if (newAccepted >= w.target) w.resolve();
      else remaining.push(w);
    }
    if (remaining.length > 0) this._acceptedWaiters.set(channelId, remaining);
    else this._acceptedWaiters.delete(channelId);
  }

  private _releaseAcceptedWaiters(channelId: string): void {
    const waiters = this._acceptedWaiters.get(channelId);
    if (!waiters) return;
    for (const w of waiters) w.resolve();
    this._acceptedWaiters.delete(channelId);
  }

  get channelsClient(): ChannelsClient {
    return this._channelsClient;
  }

  // ── SpendingAuth handler ─────────────────────────────────────

  /**
   * Handle incoming SpendingAuth from a buyer.
   * First auth: verify SpendingAuth, reserve on-chain, send AuthAck.
   * Subsequent: verify SpendingAuth signature, validate monotonic increase, persist.
   */
  async handleSpendingAuth(
    buyerPeerId: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<'accepted' | 'reserved' | 'rejected'> {
    // Per-buyer mutex: serialize concurrent auths for the same buyer
    const existing = this._buyerLocks.get(buyerPeerId);
    let result: 'accepted' | 'reserved' | 'rejected' = 'rejected';
    const lock = (existing ?? Promise.resolve()).then(async () => {
      result = await this._handleSpendingAuthInner(buyerPeerId, payload, paymentMux);
    });
    this._buyerLocks.set(buyerPeerId, lock.catch(() => {}));
    await lock;
    return result;
  }

  /**
   * Wait for any in-flight SpendingAuth processing for this buyer to complete.
   * Used by the request handler so a budget check doesn't race an on-chain top-up
   * (whose follow-up auths are queued behind the per-buyer mutex).
   */
  async waitForPendingAuths(buyerPeerId: string): Promise<void> {
    const pending = this._buyerLocks.get(buyerPeerId);
    if (pending) {
      await pending;
    }
  }

  private async _handleSpendingAuthInner(
    buyerPeerId: string,
    payload: SpendingAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<'accepted' | 'reserved' | 'rejected'> {
    const buyerEvmAddr = peerIdToAddress(buyerPeerId);
    try {
      const channelId = payload.channelId;
      const cumulativeAmount = BigInt(payload.cumulativeAmount);
      const existingCumulative = this._acceptedCumulative.get(channelId);

      const { channels: channelsAddr } = await this._resolvedAddresses!;
      const channelsDomain = makeChannelsDomain(this._config.chainId, channelsAddr);

      if (existingCumulative === undefined) {
        const hasReserveFields = payload.reserveSalt != null
          || payload.reserveMaxAmount != null
          || payload.reserveDeadline != null;

        if (!hasReserveFields) {
          const recovered = await this._recoverOnChainSession(
            buyerPeerId,
            buyerEvmAddr,
            payload,
            cumulativeAmount,
            paymentMux,
            channelsDomain,
          );
          if (recovered) {
            return 'accepted';
          }
        }

        // ── First SpendingAuth: verify ReserveAuth and reserve on-chain ──
        // The buyer signs ReserveAuth(channelId, maxAmount, deadline) to bind escrow terms.
        const reserveMaxAmount = payload.reserveMaxAmount ? BigInt(payload.reserveMaxAmount) : cumulativeAmount;
        const reserveDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
        const reserveMsg = {
          channelId,
          maxAmount: reserveMaxAmount,
          deadline: BigInt(reserveDeadline),
        };
        const reserveRecovered = verifyTypedData(channelsDomain, RESERVE_AUTH_TYPES, reserveMsg, payload.spendingAuthSig);
        if (reserveRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid ReserveAuth signature: recovered=${reserveRecovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }
        debugLog(`[SellerPayment] ReserveAuth verified for buyer ${buyerPeerId.slice(0, 12)}...`);
        debugLog(`[SellerPayment] Reserving channel ${channelId.slice(0, 18)}... on-chain`);
        const reserveSalt = payload.reserveSalt ?? channelId;
        await this._channelsClient.reserve(
          this._signer,
          buyerEvmAddr,
          reserveSalt,
          reserveMaxAmount,
          BigInt(reserveDeadline),
          payload.spendingAuthSig,
        );

        // Store new session (sessionId field stores channelId for backward compat)
        const now = Date.now();
        const { seller: sellerEvmAddr } = await this._resolvedAddresses!;
        const session: StoredChannel = {
          sessionId: channelId,
          peerId: buyerPeerId,
          role: 'seller',
          sellerEvmAddr,
          buyerEvmAddr,
          nonce: 0,
          authMax: payload.cumulativeAmount,
          previousConsumption: reserveMaxAmount.toString(), // repurposed: stores reserveMax
          deadline: reserveDeadline,
          previousSessionId: '',
          tokensDelivered: '0',
          requestCount: 0,
          reservedAt: now,
          settledAt: null,
          settledAmount: null,
          status: 'active',
          latestBuyerSig: payload.spendingAuthSig,
          latestSpendingAuthSig: payload.spendingAuthSig,
          latestMetadata: payload.metadata,
          createdAt: now,
          updatedAt: now,
        };
        // Note: do NOT store the ReserveAuth sig as spendingAuthSig in _latestAuth.
        // The ReserveAuth uses a different EIP-712 type and will fail
        // _verifySpendingAuth in close(). A real SpendingAuth will arrive
        // via the NeedAuth flow after the first request is served.
        // Start accepted at 0 — the buyer's _cumulativeAmount also starts at 0.
        // The reserve ceiling (reserveMaxAmount) bounds what can be spent;
        // accepted grows from NeedAuth-driven SpendingAuths.
        this._activateSession(
          session,
          buyerPeerId,
          0n,
          reserveMaxAmount,
          0n,
          {
          spendingAuthSig: '',
          cumulativeAmount: 0n,
          metadataHash: payload.metadataHash,
          metadata: payload.metadata,
          },
        );

        // Send AuthAck
        paymentMux.sendAuthAck({
          channelId,
        });

        debugLog(`[SellerPayment] AuthAck sent for channel ${channelId.slice(0, 18)}...`);
        return 'reserved';
      } else if (
        payload.reserveMaxAmount
        && BigInt(payload.reserveMaxAmount) > (this._reserveMax.get(channelId) ?? 0n)
      ) {
        // ── Top-up: buyer is extending the reserve ceiling ──
        const newMaxAmount = BigInt(payload.reserveMaxAmount);
        const topUpDeadline = payload.reserveDeadline ?? (Math.floor(Date.now() / 1000) + 3600);
        const currentReserveMax = this._reserveMax.get(channelId) ?? 0n;

        // Verify as ReserveAuth (not SpendingAuth)
        const reserveMsg = {
          channelId,
          maxAmount: newMaxAmount,
          deadline: BigInt(topUpDeadline),
        };
        const recovered = verifyTypedData(channelsDomain, RESERVE_AUTH_TYPES, reserveMsg, payload.spendingAuthSig);
        if (recovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid top-up ReserveAuth signature: recovered=${recovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }

        // Call topUp() on-chain — includes settle of current cumulative spend
        const { amount: settleAmount, metadata: settleMetadata, sig: settleSig } = this._getSettleParams(channelId);
        debugLog(`[SellerPayment] Top-up verified: channel=${channelId.slice(0, 18)}... ceiling ${currentReserveMax} → ${newMaxAmount} (settling cumulative=${settleAmount})`);
        await this._channelsClient.topUp(
          this._signer,
          channelId,
          settleAmount,
          settleMetadata,
          settleSig,
          newMaxAmount,
          BigInt(topUpDeadline),
          payload.spendingAuthSig,
        );

        // Update tracking
        this._reserveMax.set(channelId, newMaxAmount);
        const session = this._channelStore.getChannel(channelId);
        if (session) {
          session.previousConsumption = newMaxAmount.toString(); // repurposed: stores reserveMax
          session.deadline = topUpDeadline;
          session.updatedAt = Date.now();
          this._channelStore.upsertChannel(session);
        }

        debugLog(`[SellerPayment] Top-up completed: channel=${channelId.slice(0, 18)}... new ceiling=${newMaxAmount}`);
        return 'accepted';
      } else {
        // ── Subsequent SpendingAuth: verify SpendingAuth signature ──
        const metadataMsg = {
          channelId,
          cumulativeAmount,
          metadataHash: payload.metadataHash,
        };
        const metadataRecovered = verifyTypedData(channelsDomain, SPENDING_AUTH_TYPES, metadataMsg, payload.spendingAuthSig);
        if (metadataRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
          debugWarn(`[SellerPayment] Invalid SpendingAuth signature: recovered=${metadataRecovered} expected=${buyerEvmAddr}`);
          return 'rejected';
        }

        // Validate monotonic (equal = idempotent retransmit)
        if (cumulativeAmount < existingCumulative) {
          debugWarn(
            `[SellerPayment] Rejecting non-monotonic SpendingAuth: ` +
            `new=${cumulativeAmount} existing=${existingCumulative} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }
        if (cumulativeAmount === existingCumulative) {
          debugLog(`[SellerPayment] Idempotent SpendingAuth (same cumulative=${cumulativeAmount}) — accepted`);
          return 'accepted';
        }

        // Reject if buyer's cumulative doesn't cover what the seller has already spent
        const spent = this._spent.get(channelId) ?? 0n;
        if (cumulativeAmount < spent) {
          debugWarn(
            `[SellerPayment] Rejecting underfunded SpendingAuth: ` +
            `cumulative=${cumulativeAmount} < spent=${spent} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }

        // Reject if cumulative exceeds on-chain deposit — the contract would revert
        // and we'd lose the last valid auth signature that close() could use.
        const currentReserveMax = this._reserveMax.get(channelId) ?? 0n;
        if (currentReserveMax > 0n && cumulativeAmount > currentReserveMax) {
          debugWarn(
            `[SellerPayment] Rejecting SpendingAuth exceeding deposit ceiling: ` +
            `cumulative=${cumulativeAmount} > reserveMax=${currentReserveMax} channel=${channelId.slice(0, 18)}...`,
          );
          return 'rejected';
        }

        // Update tracking
        this._acceptedCumulative.set(channelId, cumulativeAmount);
        this._latestAuth.set(channelId, {
          spendingAuthSig: payload.spendingAuthSig,
          cumulativeAmount,
          metadataHash: payload.metadataHash,
          metadata: payload.metadata,
        });
        this._notifyAcceptedUpdate(channelId, cumulativeAmount);

        // Persist latest auth + sigs to ChannelStore
        const session = this._channelStore.getChannel(channelId);
        if (session) {
          session.authMax = payload.cumulativeAmount;
          session.latestBuyerSig = payload.spendingAuthSig;
          session.latestSpendingAuthSig = payload.spendingAuthSig;
          session.latestMetadata = payload.metadata;
          session.updatedAt = Date.now();
          this._channelStore.upsertChannel(session);
        }

        debugLog(`[SellerPayment] Budget updated: channel=${channelId.slice(0, 18)}... cumulative=${cumulativeAmount}`);
        return 'accepted';
      }
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to process SpendingAuth: ${err instanceof Error ? err.message : err}`);
      return 'rejected';
    }
  }

  private async _recoverOnChainSession(
    buyerPeerId: string,
    buyerEvmAddr: string,
    payload: SpendingAuthPayload,
    cumulativeAmount: bigint,
    paymentMux: PaymentMux,
    channelsDomain: ReturnType<typeof makeChannelsDomain>,
  ): Promise<boolean> {
    const channelId = payload.channelId;
    const onChainState = classifyOnChainChannel(await this._channelsClient.getSession(channelId));
    const { seller: sellerEvmAddr } = await this._resolvedAddresses!;

    if (!onChainState.exists || onChainState.status !== 'active') return false;
    if (!matchesChannelParties(onChainState.channel, buyerEvmAddr, sellerEvmAddr)) return false;
    const onChain = onChainState.channel;

    const metadataMsg = {
      channelId,
      cumulativeAmount,
      metadataHash: payload.metadataHash,
    };
    const metadataRecovered = verifyTypedData(channelsDomain, SPENDING_AUTH_TYPES, metadataMsg, payload.spendingAuthSig);
    if (metadataRecovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
      debugWarn(`[SellerPayment] Invalid recovered SpendingAuth during channel recovery: recovered=${metadataRecovered} expected=${buyerEvmAddr}`);
      return false;
    }

    if (cumulativeAmount < onChain.settled) {
      debugWarn(
        `[SellerPayment] Rejecting recovered SpendingAuth below on-chain settled amount: ` +
        `cumulative=${cumulativeAmount} settled=${onChain.settled} channel=${channelId.slice(0, 18)}...`,
      );
      return false;
    }

    const now = Date.now();
    const session: StoredChannel = {
      sessionId: channelId,
      peerId: buyerPeerId,
      role: 'seller',
      sellerEvmAddr,
      buyerEvmAddr,
      nonce: 0,
      authMax: payload.cumulativeAmount,
      previousConsumption: onChain.deposit.toString(),
      deadline: Number(onChain.deadline),
      previousSessionId: '',
      tokensDelivered: onChain.settled.toString(),
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: onChain.settled > 0n ? onChain.settled.toString() : null,
      status: 'active',
      latestBuyerSig: payload.spendingAuthSig,
      latestSpendingAuthSig: payload.spendingAuthSig,
      latestMetadata: payload.metadata,
      createdAt: now,
      updatedAt: now,
    };
    this._activateSession(
      session,
      buyerPeerId,
      cumulativeAmount,
      onChain.deposit,
      onChain.settled,
      {
        spendingAuthSig: payload.spendingAuthSig,
        cumulativeAmount,
        metadataHash: payload.metadataHash,
        metadata: payload.metadata,
      },
    );

    paymentMux.sendAuthAck({ channelId });
    debugLog(`[SellerPayment] Recovered active on-chain channel ${channelId.slice(0, 18)}... for buyer ${buyerPeerId.slice(0, 12)}...`);
    return true;
  }

  private _activateSession(
    session: StoredChannel,
    buyerPeerId: string,
    cumulativeAmount: bigint,
    reserveMaxAmount: bigint,
    spent: bigint,
    latestAuth: LatestAuth,
  ): void {
    this._channelStore.upsertChannel(session);
    this._acceptedCumulative.set(session.sessionId, cumulativeAmount);
    this._reserveMax.set(session.sessionId, reserveMaxAmount);
    this._spent.set(session.sessionId, spent);
    this._latestAuth.set(session.sessionId, latestAuth);
    this._activeBuyers.add(buyerPeerId);
  }

  // ── Per-request validation ──────────────────────────────────

  /**
   * Validate and accept a SpendingAuth attached to an incoming request.
   * Returns true if the buyer has sufficient budget to serve this request.
   */
  async validateAndAcceptAuth(
    buyerPeerId: string,
    auth: SpendingAuthPayload,
  ): Promise<boolean> {
    // Look up active session for this buyer
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, 'seller');
    if (!session) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: no active session for buyer ${buyerPeerId.slice(0, 12)}...`);
      return false;
    }

    const channelId = session.sessionId; // sessionId field stores channelId
    const existingCumulative = this._acceptedCumulative.get(channelId);
    if (existingCumulative === undefined) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: no tracked cumulative for channel ${channelId.slice(0, 18)}...`);
      return false;
    }

    // Verify AntSeed SpendingAuth signature
    const { channels: channelsAddr } = await this._resolvedAddresses!;
    const channelsDomain = makeChannelsDomain(this._config.chainId, channelsAddr);
    const metadataMsg = {
      channelId: auth.channelId,
      cumulativeAmount: BigInt(auth.cumulativeAmount),
      metadataHash: auth.metadataHash,
    };

    const buyerEvmAddr = peerIdToAddress(buyerPeerId);
    try {
      const recovered = verifyTypedData(channelsDomain, SPENDING_AUTH_TYPES, metadataMsg, auth.spendingAuthSig);
      if (recovered.toLowerCase() !== buyerEvmAddr.toLowerCase()) {
        debugWarn(`[SellerPayment] validateAndAcceptAuth: invalid SpendingAuth signature`);
        return false;
      }
    } catch {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: SpendingAuth verification failed`);
      return false;
    }

    // Check monotonic: strictly greater, or equal (idempotent retransmit)
    const newCumulative = BigInt(auth.cumulativeAmount);
    if (newCumulative < existingCumulative) {
      debugWarn(`[SellerPayment] validateAndAcceptAuth: cumulative decreased from ${existingCumulative} to ${newCumulative}`);
      return false;
    }

    // Update if strictly greater
    if (newCumulative > existingCumulative) {
      this._acceptedCumulative.set(channelId, newCumulative);
      this._latestAuth.set(channelId, {
        spendingAuthSig: auth.spendingAuthSig,
        cumulativeAmount: newCumulative,
        metadataHash: auth.metadataHash,
        metadata: auth.metadata,
      });
      this._notifyAcceptedUpdate(channelId, newCumulative);

      // Persist latest auth + sigs to ChannelStore
      const storedSession = this._channelStore.getChannel(channelId);
      if (storedSession) {
        storedSession.authMax = auth.cumulativeAmount;
        storedSession.latestBuyerSig = auth.spendingAuthSig;
        storedSession.latestSpendingAuthSig = auth.spendingAuthSig;
        storedSession.latestMetadata = auth.metadata;
        storedSession.updatedAt = Date.now();
        this._channelStore.upsertChannel(storedSession);
      }
    }

    // Check available budget
    const accepted = this._acceptedCumulative.get(channelId)!;
    const spent = this._spent.get(channelId) ?? 0n;
    return accepted >= spent;
  }

  // ── Spend tracking ──────────────────────────────────────────

  /**
   * Record USDC consumption after serving a request.
   */
  recordSpend(sessionId: string, costUsdc: bigint): void {
    const current = this._spent.get(sessionId);
    if (current === undefined) {
      debugWarn(`[SellerPayment] recordSpend: unknown channelId ${sessionId.slice(0, 18)}...`);
      return;
    }

    const newSpent = current + costUsdc;
    this._spent.set(sessionId, newSpent);

    // Persist spent amount to ChannelStore (using tokensDelivered field)
    this._channelStore.updateTokensDelivered(sessionId, newSpent.toString(), 0);
  }

  // ── Settlement ──────────────────────────────────────────────

  /**
   * Close a completed session on-chain using the latest buyer-signed dual signatures.
   * Uses close() for final settlement (releases remaining deposit to buyer).
   */
  /** Get the latest SpendingAuth params for a channel, or zero-auth if none exists. */
  private _getSettleParams(channelId: string): { amount: bigint; metadata: string; sig: string } {
    const latestAuth = this._latestAuth.get(channelId);
    if (latestAuth && latestAuth.spendingAuthSig.length > 0) {
      return {
        amount: latestAuth.cumulativeAmount,
        metadata: latestAuth.metadata || encodeMetadata(ZERO_METADATA),
        sig: latestAuth.spendingAuthSig,
      };
    }
    return { amount: 0n, metadata: encodeMetadata(ZERO_METADATA), sig: '0x' };
  }

  /**
   * Settle or close a session's payment channel on-chain.
   *
   * - settleOnly=false (default): calls close() — charges buyer, credits seller, ends channel.
   * - settleOnly=true: calls settle() — charges buyer, credits seller, keeps channel open
   *   for future requests. No cleanup is performed so the session can resume.
   */
  async settleSession(buyerPeerId: string, { cleanupOnFailure = false, settleOnly = false } = {}): Promise<void> {
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, 'seller');
    if (!session) {
      debugWarn(`[SellerPayment] settleSession: no active session for buyer ${buyerPeerId.slice(0, 12)}...`);
      return;
    }

    const channelId = session.sessionId;
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;
    const { amount, metadata, sig } = this._getSettleParams(channelId);

    if (accepted === 0n) {
      if (settleOnly) return;
      debugLog(`[SellerPayment] Zero-cumulative channel ${channelId.slice(0, 18)}... — deferring to timeout checker`);
    } else if (settleOnly) {
      if (amount === 0n) return;

      // Skip the getSession RPC entirely when our local cumulative hasn't
      // moved since we last settled this channel — the contract would revert
      // with InvalidAmount (strict `>` check) and we'd waste an RPC round-trip.
      const lastSettled = this._lastSettledCumulative.get(channelId);
      if (lastSettled !== undefined && amount <= lastSettled) {
        debugLog(`[SellerPayment] Skip settle ${channelId.slice(0, 18)}... — cumulative unchanged since last settle (${amount})`);
        return;
      }

      // Cache miss (e.g. after restart) or local cumulative has advanced —
      // confirm against on-chain state in case another process settled.
      let onChainSettled: bigint;
      try {
        const onChain = await this._channelsClient.getSession(channelId);
        onChainSettled = onChain.settled;
      } catch (err) {
        debugWarn(`[SellerPayment] getSession failed for ${channelId.slice(0, 18)}...: ${err instanceof Error ? err.message : err} — attempting settle anyway`);
        onChainSettled = 0n;
      }
      const delta = amount - onChainSettled;
      if (delta <= 0n) {
        // Resync the cache so we stop hitting the RPC on every idle tick.
        this._lastSettledCumulative.set(channelId, onChainSettled);
        debugLog(`[SellerPayment] Skip settle ${channelId.slice(0, 18)}... — already settled on-chain (local=${amount}, onChain=${onChainSettled})`);
        return;
      }
      if (delta < this._minSettleDelta) {
        // Mark this cumulative as a no-op so the next tick short-circuits
        // without re-querying getSession until amount actually advances.
        this._lastSettledCumulative.set(channelId, amount);
        debugLog(`[SellerPayment] Skip settle ${channelId.slice(0, 18)}... — delta=${delta} below minSettleDelta=${this._minSettleDelta}`);
        return;
      }

      debugLog(`[SellerPayment] Settling channel ${channelId.slice(0, 18)}... cumulative=${amount} delta=${delta} (keeping open)`);
      try {
        await this._channelsClient.settle(this._signer, channelId, amount, metadata, sig);
        this._lastSettledCumulative.set(channelId, amount);
        debugLog(`[SellerPayment] Settled channel ${channelId.slice(0, 18)}... — channel remains open`);
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to settle channel: ${err instanceof Error ? err.message : err}`);
      }
      return;
    } else {
      const retries = this._closeRetryCount.get(channelId) ?? 0;
      if (retries >= SellerPaymentManager.MAX_CLOSE_RETRIES) {
        debugWarn(`[SellerPayment] close() failed ${retries} times for ${channelId.slice(0, 18)}... — falling back to timeout path`);
      } else {
        debugLog(`[SellerPayment] Closing channel ${channelId.slice(0, 18)}... cumulative=${amount} (attempt ${retries + 1}/${SellerPaymentManager.MAX_CLOSE_RETRIES})`);
        try {
          await this._channelsClient.close(this._signer, channelId, amount, metadata, sig);
          this._channelStore.updateChannelStatus(channelId, 'settled', amount.toString());
          this._closeRetryCount.delete(channelId);
        } catch (err) {
          debugWarn(`[SellerPayment] Failed to close channel (attempt ${retries + 1}): ${err instanceof Error ? err.message : err}`);
          this._closeRetryCount.set(channelId, retries + 1);
          if (!cleanupOnFailure) return;
        }
      }
    }

    // Clean up maps after successful close, zero-cumulative deferral, or exhausted retries
    this._acceptedCumulative.delete(channelId);
    this._spent.delete(channelId);
    this._latestAuth.delete(channelId);
    this._closeRetryCount.delete(channelId);
    this._lastSettledCumulative.delete(channelId);
    this._activeBuyers.delete(buyerPeerId);
  }

  // ── Disconnect handling ───────────────────────────────────────

  onBuyerDisconnect(buyerPeerId: string): void {
    const session = this._channelStore.getActiveChannelByPeer(buyerPeerId, 'seller');
    if (!session) return;

    const settleOnDisconnect = this._config.settleOnDisconnect ?? true;

    if (settleOnDisconnect) {
      const accepted = this._acceptedCumulative.get(session.sessionId) ?? 0n;
      if (accepted > 0n) {
        debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — closing channel immediately`);
        // Fire and forget settlement — clean up maps even if close() fails
        this.settleSession(buyerPeerId, { cleanupOnFailure: true }).catch((err) => {
          debugWarn(`[SellerPayment] Failed to close on disconnect: ${err instanceof Error ? err.message : err}`);
        });
        return;
      }
    }

    // Preserve session for reconnect; timeout checker handles ghost scenarios
    this._activeBuyers.delete(buyerPeerId);
    debugLog(`[SellerPayment] Buyer ${buyerPeerId.slice(0, 12)}... disconnected — channel ${session.sessionId.slice(0, 18)}... preserved for reconnect`);
  }

  // ── Stale session cleanup ────────────────────────────────────

  /**
   * Check for stale sessions and attempt to close them.
   * The seller can only close() with a valid SpendingAuth — it cannot
   * requestClose or withdraw (those are buyer-only on-chain).
   * If the seller has no auths, the session remains open until the buyer
   * calls requestClose → withdraw on-chain.
   * Called periodically and on startup for recovery.
   */
  async checkTimeouts(): Promise<void> {
    const nowSecs = Math.floor(Date.now() / 1000);
    const activeChannels = this._channelStore.getActiveChannels('seller');

    for (const channel of activeChannels) {
      const accepted = this._acceptedCumulative.get(channel.sessionId) ?? 0n;

      try {
        // Validate on-chain state — evict if channel no longer exists
        const onChainState = classifyOnChainChannel(
          await this._channelsClient.getSession(channel.sessionId),
        );
        if (!onChainState.exists || (onChainState.status !== 'active' && onChainState.status !== 'unknown')) {
          this._evictStaleChannel(channel.sessionId, channel.peerId, `periodic check: on-chain status=${onChainState.exists ? onChainState.status : 'missing'}`);
          continue;
        }

        // If we have auths and the buyer is disconnected, try to close
        if (accepted > 0n && !this._activeBuyers.has(channel.peerId)) {
          debugLog(`[SellerPayment] Channel ${channel.sessionId.slice(0, 18)}... buyer disconnected — attempting close`);
          await this.settleSession(channel.peerId);
        }
        // If no auths and buyer disconnected, nothing the seller can do on-chain.
        // The buyer must call requestClose → withdraw. We just clean up locally
        // after a reasonable period (e.g. deadline passed).
        if (accepted === 0n && !this._activeBuyers.has(channel.peerId) && nowSecs > channel.deadline) {
          this._evictStaleChannel(channel.sessionId, channel.peerId, 'no auths, past deadline', 'timeout');
        }
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to process channel ${channel.sessionId.slice(0, 18)}...: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── Queries ───────────────────────────────────────────────────

  hasSession(buyerPeerId: string): boolean {
    return this._activeBuyers.has(buyerPeerId);
  }

  /** Get the active session for a buyer peer, or null. */
  getChannelByPeer(buyerPeerId: string): StoredChannel | null {
    return this._channelStore.getActiveChannelByPeer(buyerPeerId, 'seller');
  }

  /** Get total USDC spent for a session (sum of recordSpend calls). */
  getCumulativeSpend(sessionId: string): bigint {
    return this._spent.get(sessionId) ?? 0n;
  }

  /** Get the highest accepted cumulative amount for a session. */
  getAcceptedCumulative(sessionId: string): bigint {
    return this._acceptedCumulative.get(sessionId) ?? 0n;
  }

  /** Get the on-chain reserve budget ceiling for a session. */
  getReserveMax(sessionId: string): bigint {
    return this._reserveMax.get(sessionId) ?? 0n;
  }

  private static readonly DEFAULT_SUGGESTED_AMOUNT = 1_000_000n; // $1.00 — matches contract FIRST_SIGN_CAP and buyer default

  /**
   * Build the PaymentRequired payload for a buyer that doesn't have a session.
   */
  getPaymentRequirements(
    requestId: string,
    buyerPeerId?: string,
    pricing?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number; cachedInputUsdPerMillion?: number },
  ): PaymentRequiredPayload {
    const minBudgetPerRequest = this._config.minBudgetPerRequest ?? DEFAULT_MIN_BUDGET_PER_REQUEST;

    let suggestedAmount = SellerPaymentManager.DEFAULT_SUGGESTED_AMOUNT;
    if (buyerPeerId) {
      const priorSession = this._channelStore.getLatestChannel(buyerPeerId, 'seller');
      if (priorSession && priorSession.status === 'settled') {
        // Returning buyer with proven history — could use a different amount
        // For now, use the same default; config can override later
        suggestedAmount = SellerPaymentManager.DEFAULT_SUGGESTED_AMOUNT;
      }
    }

    return {
      minBudgetPerRequest,
      suggestedAmount: suggestedAmount.toString(),
      requestId,
      ...(pricing?.inputUsdPerMillion != null ? { inputUsdPerMillion: pricing.inputUsdPerMillion } : {}),
      ...(pricing?.outputUsdPerMillion != null ? { outputUsdPerMillion: pricing.outputUsdPerMillion } : {}),
      ...(pricing?.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion } : {}),
    };
  }

  // ── CloseRequested handling ───────────────────────────────────

  /**
   * Handle a CloseRequested event for a channel this seller manages.
   * If the seller has a stored SpendingAuth, immediately close the channel
   * on-chain to claim earnings before the grace period expires.
   */
  async handleCloseRequested(channelId: string): Promise<void> {
    const accepted = this._acceptedCumulative.get(channelId) ?? 0n;

    if (accepted > 0n) {
      const { amount, metadata, sig } = this._getSettleParams(channelId);
      debugLog(`[SellerPayment] CloseRequested for channel ${channelId.slice(0, 18)}... — closing with cumulative=${amount}`);
      try {
        await this._channelsClient.close(this._signer, channelId, amount, metadata, sig);
        this._channelStore.updateChannelStatus(channelId, 'settled', amount.toString());
        debugLog(`[SellerPayment] Channel ${channelId.slice(0, 18)}... closed successfully after CloseRequested`);
      } catch (err) {
        debugWarn(`[SellerPayment] Failed to close channel ${channelId.slice(0, 18)}... after CloseRequested: ${err instanceof Error ? err.message : err}`);
        return;
      }
    } else {
      // No voucher — seller can't claim anything. Clean up locally;
      // buyer will withdraw after grace period.
      debugLog(`[SellerPayment] CloseRequested for channel ${channelId.slice(0, 18)}... — no SpendingAuth, cleaning up locally`);
      this._channelStore.updateChannelStatus(channelId, 'timeout');
    }

    // Clean up in-memory state
    this._acceptedCumulative.delete(channelId);
    this._spent.delete(channelId);
    this._latestAuth.delete(channelId);
    this._closeRetryCount.delete(channelId);
    this._reserveMax.delete(channelId);
    this._lastSettledCumulative.delete(channelId);

    // Find and remove buyer from active set
    const channel = this._channelStore.getChannel(channelId);
    if (channel) {
      this._activeBuyers.delete(channel.peerId);
    }
  }

  /**
   * Poll for CloseRequested events and handle any that match active channels.
   * Returns the block number to use as the next fromBlock cursor.
   */
  async pollCloseRequested(fromBlock: number): Promise<number> {
    try {
      // Fetch block number first and pin as toBlock to avoid race:
      // if blocks are mined between the two calls, events in the gap would be missed.
      const latestBlock = await this._channelsClient.getBlockNumber();
      const events = await this._channelsClient.getCloseRequestedEvents(fromBlock, latestBlock);

      for (const event of events) {
        // Only handle channels this seller is actively tracking
        if (this._acceptedCumulative.has(event.channelId) || this._channelStore.getChannel(event.channelId)?.status === 'active') {
          await this.handleCloseRequested(event.channelId);
        }
      }

      return latestBlock + 1;
    } catch (err) {
      debugWarn(`[SellerPayment] Failed to poll CloseRequested events: ${err instanceof Error ? err.message : err}`);
      return fromBlock; // Retry from same block on next poll
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    // ChannelStore is shared with BuyerPaymentManager, closed from node.ts
  }
}

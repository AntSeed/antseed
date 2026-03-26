import { randomBytes } from 'node:crypto';
import { type AbstractSigner } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { PaymentMux } from '../p2p/payment-mux.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  NeedAuthPayload,
} from '../types/protocol.js';
import { DepositsClient } from './evm/deposits-client.js';
import { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
import {
  signMetadataAuth,
  makeSessionsDomain,
  computeMetadataHash,
  encodeMetadata,
  ZERO_METADATA,
  ZERO_METADATA_HASH,
  computeChannelId,
} from './evm/signatures.js';
import type { MetadataAuthMessage, SpendingAuthMetadata } from './evm/signatures.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import { SessionStore, type StoredSession } from './session-store.js';

// ── Response cost header constants ───────────────────────────────
const HEADER_COST = 'x-antseed-cost';
const HEADER_INPUT_TOKENS = 'x-antseed-input-tokens';
const HEADER_OUTPUT_TOKENS = 'x-antseed-output-tokens';

export interface BuyerPaymentConfig {
  rpcUrl: string;
  depositsContractAddress: string;
  sessionsContractAddress: string;
  usdcAddress: string;
  identityRegistryAddress: string;
  chainId: number;
  defaultAuthDurationSecs: number;
  /** Max USDC to pre-authorize per request increment (base units). Default: 100000 ($0.10). */
  maxPerRequestUsdc: bigint;
  /** Max total USDC to reserve per session (base units). Default: 1000000 ($1.00). */
  maxReserveAmountUsdc: bigint;
  dataDir: string;
}

/**
 * Manages buyer-side payment sessions using EIP-712 SpendingAuth
 * with cumulative authorization and persistent session storage.
 */
export class BuyerPaymentManager {
  private readonly _identity: Identity;
  private _signer: AbstractSigner;
  private readonly _depositsClient: DepositsClient;
  private readonly _config: BuyerPaymentConfig;
  private readonly _sessionStore: SessionStore;
  /** In-memory map of active confirmed sessions by seller peerId for fast lookups. */
  private readonly _confirmedPeers = new Set<string>();
  /** Peers that explicitly rejected our spending auth. */
  private readonly _rejectedPeers = new Set<string>();

  /** sellerPeerId -> cumulative USDC amount in the latest SpendingAuth */
  private readonly _cumulativeAmount = new Map<string, bigint>();

  /** sellerPeerId -> cumulative metadata for SpendingAuth */
  private readonly _metadata = new Map<string, SpendingAuthMetadata>();

  constructor(identity: Identity, config: BuyerPaymentConfig, sessionStore: SessionStore) {
    this._identity = identity;
    this._config = config;
    this._signer = identityToEvmWallet(identity);
    this._depositsClient = new DepositsClient({
      rpcUrl: config.rpcUrl,
      contractAddress: config.depositsContractAddress,
      usdcAddress: config.usdcAddress,
    });
    this._sessionStore = sessionStore;

    // Hydrate cumulative maps from persisted active sessions
    this._hydrateFromStore();
  }

  /** Hydrate cumulative tracking maps from persisted active buyer sessions. */
  private _hydrateFromStore(): void {
    const activeSessions = this._sessionStore.getActiveSessions('buyer');
    for (const session of activeSessions) {
      const peerId = session.peerId;
      // authMax stores the latest cumulativeAmount signed
      this._cumulativeAmount.set(peerId, BigInt(session.authMax));
      // tokensDelivered stores cumulative input tokens (repurposed field)
      // previousConsumption stores cumulative output tokens (repurposed field)
      // For new sessions these will be 0; for hydrated sessions we restore from stored values
      this._metadata.set(peerId, {
        cumulativeInputTokens: BigInt(session.tokensDelivered),
        cumulativeOutputTokens: BigInt(session.previousConsumption),
        cumulativeLatencyMs: 0n,
        cumulativeRequestCount: BigInt(session.requestCount),
      });
    }
  }

  get signer(): AbstractSigner {
    return this._signer;
  }

  setSigner(signer: AbstractSigner): void {
    this._signer = signer;
  }

  get depositsClient(): DepositsClient {
    return this._depositsClient;
  }

  // ── Spending Authorization ────────────────────────────────────

  /**
   * Sign and send an initial EIP-712 SpendingAuth to a seller.
   * The initial cumulativeAmount is set to the seller's minBudgetPerRequest.
   */
  async authorizeSpending(
    sellerPeerId: string,
    sellerEvmAddr: string,
    paymentMux: PaymentMux,
    minBudgetPerRequest: bigint,
  ): Promise<string> {
    // Budget validation: reject if seller demands more than buyer allows per request
    if (minBudgetPerRequest > this._config.maxPerRequestUsdc) {
      debugWarn(
        `[BuyerPayment] Seller ${sellerPeerId.slice(0, 12)}... minBudgetPerRequest=${minBudgetPerRequest} exceeds maxPerRequestUsdc=${this._config.maxPerRequestUsdc} — not authorizing`,
      );
      return '';
    }

    // Clear confirmation state so we wait for a fresh AuthAck on the new session
    this._confirmedPeers.delete(sellerPeerId);

    // Generate random salt and compute deterministic channelId
    // Must match: AntseedSessions.computeChannelId(buyer, seller, salt)
    const salt = '0x' + randomBytes(32).toString('hex');
    const buyerEvmAddr = identityToEvmAddress(this._identity);
    const channelId = computeChannelId(buyerEvmAddr, sellerEvmAddr, salt);
    const deadline = Math.floor(Date.now() / 1000) + this._config.defaultAuthDurationSecs;

    debugLog(`[BuyerPayment] authorizeSpending: channel=${channelId.slice(0, 18)}... seller=${sellerPeerId.slice(0, 12)}... amount=${minBudgetPerRequest}`);

    // Sign MetadataAuth with cumulative=0 for on-chain reserve() verification.
    // For initial reserve, only MetadataAuth is needed.
    const sessionsDomain = makeSessionsDomain(this._config.chainId, this._config.sessionsContractAddress);
    const zeroMetadata = { ...ZERO_METADATA };
    const zeroEncodedMetadata = encodeMetadata(zeroMetadata);
    const metadataMsg: MetadataAuthMessage = {
      channelId,
      cumulativeAmount: 0n,
      metadataHash: ZERO_METADATA_HASH,
    };
    const metadataAuthSig = await signMetadataAuth(this._signer, sessionsDomain, metadataMsg);

    // Initialize cumulative maps at 0 — first per-request auth will increment
    this._cumulativeAmount.set(sellerPeerId, 0n);
    this._metadata.set(sellerPeerId, { ...ZERO_METADATA });

    // Store session (sessionId in store maps to channelId)
    const now = Date.now();
    const session: StoredSession = {
      sessionId: channelId,
      peerId: sellerPeerId,
      role: 'buyer',
      sellerEvmAddr,
      buyerEvmAddr,
      nonce: 0,
      authMax: '0',
      deadline,
      previousSessionId: '0x' + '0'.repeat(64),
      previousConsumption: '0',
      tokensDelivered: '0',
      requestCount: 0,
      reservedAt: now,
      settledAt: null,
      settledAmount: null,
      status: 'active',
      latestBuyerSig: null,
      latestMetadataAuthSig: null,
      latestMetadata: null,
      createdAt: now,
      updatedAt: now,
    };
    this._sessionStore.upsertSession(session);

    // Send SpendingAuth via PaymentMux — initial reserve only needs MetadataAuth sig
    paymentMux.sendSpendingAuth({
      channelId,
      cumulativeAmount: '0',
      metadataHash: ZERO_METADATA_HASH,
      metadata: zeroEncodedMetadata,
      metadataAuthSig,
      buyerEvmAddr,
      reserveSalt: salt,
      reserveMaxAmount: this._config.maxReserveAmountUsdc.toString(),
      reserveDeadline: deadline,
    });

    return channelId;
  }

  // ── AuthAck handler ───────────────────────────────────────────

  handleAuthAck(sellerPeerId: string, payload: AuthAckPayload): void {
    const session = this._sessionStore.getActiveSessionByPeer(sellerPeerId, 'buyer');
    if (!session) {
      debugWarn(`[BuyerPayment] AuthAck for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }
    if (session.sessionId !== payload.channelId) {
      debugWarn(`[BuyerPayment] AuthAck channel mismatch: expected=${session.sessionId.slice(0, 18)}... got=${payload.channelId.slice(0, 18)}...`);
      return;
    }

    this._confirmedPeers.add(sellerPeerId);
    debugLog(`[BuyerPayment] AuthAck confirmed: channel=${session.sessionId.slice(0, 18)}...`);
  }

  // ── Per-request authorization ──────────────────────────────────

  /**
   * Sign an updated SpendingAuth with incremented cumulative values.
   * Called before each request (after the initial one).
   */
  async signPerRequestAuth(
    sellerPeerId: string,
    addedCostUsdc: bigint,
    addedInputTokens: bigint,
    addedOutputTokens: bigint,
    estimatedNextCostUsdc: bigint,
    addedLatencyMs?: bigint,
  ): Promise<SpendingAuthPayload> {
    const session = this._sessionStore.getActiveSessionByPeer(sellerPeerId, 'buyer');
    if (!session) {
      throw new Error(`[BuyerPayment] No active session for seller ${sellerPeerId.slice(0, 12)}... — call authorizeSpending() first`);
    }

    // Update cumulative metadata
    const prev = this._metadata.get(sellerPeerId) ?? { ...ZERO_METADATA };
    const newMeta: SpendingAuthMetadata = {
      cumulativeInputTokens: prev.cumulativeInputTokens + addedInputTokens,
      cumulativeOutputTokens: prev.cumulativeOutputTokens + addedOutputTokens,
      cumulativeLatencyMs: prev.cumulativeLatencyMs + (addedLatencyMs ?? 0n),
      cumulativeRequestCount: prev.cumulativeRequestCount + 1n,
    };
    this._metadata.set(sellerPeerId, newMeta);

    // Calculate amount increment, capping at maxPerRequestUsdc
    let increment = addedCostUsdc + estimatedNextCostUsdc;
    if (increment > this._config.maxPerRequestUsdc) {
      debugLog(`[BuyerPayment] Capping per-request increment from ${increment} to ${this._config.maxPerRequestUsdc}`);
      increment = this._config.maxPerRequestUsdc;
    }

    // Update cumulative amount, capping at maxReserveAmountUsdc
    const prevAmount = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    let newAmount = prevAmount + increment;
    if (newAmount > this._config.maxReserveAmountUsdc) {
      debugLog(`[BuyerPayment] Capping cumulative amount from ${newAmount} to ${this._config.maxReserveAmountUsdc}`);
      newAmount = this._config.maxReserveAmountUsdc;
    }
    this._cumulativeAmount.set(sellerPeerId, newAmount);

    // Compute metadata hash and encode metadata
    const metadataHashHex = computeMetadataHash(newMeta);
    const encodedMetadata = encodeMetadata(newMeta);

    // Sign EIP-712 MetadataAuth (covers amount + metadata for both payment and reputation)
    const sessionsDomain = makeSessionsDomain(this._config.chainId, this._config.sessionsContractAddress);
    const metadataMsg: MetadataAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount: newAmount,
      metadataHash: metadataHashHex,
    };
    const metadataAuthSig = await signMetadataAuth(this._signer, sessionsDomain, metadataMsg);

    // Persist updated cumulative values to SessionStore
    this._sessionStore.upsertSession({
      ...session,
      authMax: newAmount.toString(),
      tokensDelivered: newMeta.cumulativeInputTokens.toString(),
      previousConsumption: newMeta.cumulativeOutputTokens.toString(),
      requestCount: Number(newMeta.cumulativeRequestCount),
      updatedAt: Date.now(),
    });

    const payload: SpendingAuthPayload = {
      channelId: session.sessionId,
      cumulativeAmount: newAmount.toString(),
      metadataHash: metadataHashHex,
      metadata: encodedMetadata,
      metadataAuthSig,
      buyerEvmAddr: session.buyerEvmAddr,
    };

    return payload;
  }

  // ── NeedAuth handler ───────────────────────────────────────────

  /**
   * Handle seller-initiated NeedAuth messages when the seller's budget runs out mid-session.
   */
  async handleNeedAuth(
    sellerPeerId: string,
    payload: NeedAuthPayload,
    paymentMux: PaymentMux,
  ): Promise<void> {
    const session = this._sessionStore.getActiveSessionByPeer(sellerPeerId, 'buyer');
    if (!session) {
      debugWarn(`[BuyerPayment] NeedAuth for unknown seller: ${sellerPeerId.slice(0, 12)}...`);
      return;
    }

    const requiredCumulativeAmount = BigInt(payload.requiredCumulativeAmount);

    // Reject stale/lower NeedAuth (monotonicity guard)
    const currentCumulative = this._cumulativeAmount.get(sellerPeerId) ?? 0n;
    if (requiredCumulativeAmount <= currentCumulative) {
      debugLog(
        `[BuyerPayment] NeedAuth stale: required=${requiredCumulativeAmount} <= current=${currentCumulative} — ignoring`,
      );
      return;
    }

    // Reject if exceeds max reserve
    if (requiredCumulativeAmount > this._config.maxReserveAmountUsdc) {
      debugWarn(
        `[BuyerPayment] NeedAuth requiredCumulativeAmount=${requiredCumulativeAmount} exceeds maxReserveAmountUsdc=${this._config.maxReserveAmountUsdc} — rejecting`,
      );
      return;
    }

    debugLog(`[BuyerPayment] NeedAuth: channel=${session.sessionId.slice(0, 18)}... required=${requiredCumulativeAmount}`);

    // Update cumulative amount
    this._cumulativeAmount.set(sellerPeerId, requiredCumulativeAmount);

    // Sign MetadataAuth with the required cumulative amount and current metadata
    const currentMeta = this._metadata.get(sellerPeerId) ?? { ...ZERO_METADATA };
    const metadataHashHex = computeMetadataHash(currentMeta);
    const encodedMetadata = encodeMetadata(currentMeta);

    const sessionsDomain = makeSessionsDomain(this._config.chainId, this._config.sessionsContractAddress);
    const metadataMsg: MetadataAuthMessage = {
      channelId: session.sessionId,
      cumulativeAmount: requiredCumulativeAmount,
      metadataHash: metadataHashHex,
    };
    const metadataAuthSig = await signMetadataAuth(this._signer, sessionsDomain, metadataMsg);

    // Persist updated values
    this._sessionStore.upsertSession({
      ...session,
      authMax: requiredCumulativeAmount.toString(),
      updatedAt: Date.now(),
    });

    // Send via PaymentMux (connection may have closed between NeedAuth receipt and now)
    try {
      paymentMux.sendSpendingAuth({
        channelId: session.sessionId,
        cumulativeAmount: requiredCumulativeAmount.toString(),
        metadataHash: metadataHashHex,
        metadata: encodedMetadata,
        metadataAuthSig,
        buyerEvmAddr: session.buyerEvmAddr,
      });
      debugLog(`[BuyerPayment] NeedAuth responded: new cumulativeAmount=${requiredCumulativeAmount}`);
    } catch {
      debugLog(`[BuyerPayment] NeedAuth: connection closed before SpendingAuth could be sent`);
    }
  }

  // ── Queries ───────────────────────────────────────────────────

  /** Max USDC per request increment from buyer config. */
  get maxPerRequestUsdc(): bigint {
    return this._config.maxPerRequestUsdc;
  }

  /** Max total USDC to reserve per session from buyer config. */
  get maxReserveAmountUsdc(): bigint {
    return this._config.maxReserveAmountUsdc;
  }

  /** Check if a session has been confirmed via AuthAck. */
  isAuthorized(sellerPeerId: string): boolean {
    return this._confirmedPeers.has(sellerPeerId);
  }

  /** Alias for isAuthorized (used by polling loop). */
  isLockConfirmed(sellerPeerId: string): boolean {
    return this.isAuthorized(sellerPeerId);
  }

  /** Check if the lock was explicitly rejected (not just never-contacted). */
  isLockRejected(sellerPeerId: string): boolean {
    return this._rejectedPeers.has(sellerPeerId);
  }

  /** Mark a peer as having rejected our spending auth. */
  markRejected(sellerPeerId: string): void {
    this._rejectedPeers.add(sellerPeerId);
    debugLog(`[BuyerPayment] Peer ${sellerPeerId.slice(0, 12)}... marked as rejected`);
  }

  getSessionHistory(sellerPeerId: string): StoredSession[] {
    const session = this._sessionStore.getLatestSession(sellerPeerId, 'buyer');
    return session ? [session] : [];
  }

  // ── Deposit operations ──────────────────────────────────────────

  async deposit(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Depositing ${amount} to deposits`);
    return this._depositsClient.deposit(this._signer, amount);
  }

  async withdraw(amount: bigint): Promise<string> {
    debugLog(`[BuyerPayment] Requesting withdrawal of ${amount} from deposits`);
    return this._depositsClient.requestWithdrawal(this._signer, amount);
  }

  async getBalance(): Promise<{ available: bigint; reserved: bigint }> {
    const buyerAddr = identityToEvmAddress(this._identity);
    const info = await this._depositsClient.getBuyerBalance(buyerAddr);
    return { available: info.available, reserved: info.reserved };
  }

  // ── Response cost parsing ──────────────────────────────────────

  /**
   * Parse per-request cost and token usage from seller response headers.
   * Returns null if the cost header is missing or non-numeric.
   */
  static parseResponseCost(
    headers: Record<string, string>,
  ): { cost: bigint; inputTokens: bigint; outputTokens: bigint } | null {
    const costStr = headers[HEADER_COST];
    if (costStr === undefined || costStr === '') return null;

    try {
      const cost = BigInt(costStr);

      const inputStr = headers[HEADER_INPUT_TOKENS];
      const inputTokens = inputStr !== undefined && inputStr !== '' ? BigInt(inputStr) : 0n;

      const outputStr = headers[HEADER_OUTPUT_TOKENS];
      const outputTokens = outputStr !== undefined && outputStr !== '' ? BigInt(outputStr) : 0n;

      return { cost, inputTokens, outputTokens };
    } catch {
      return null;
    }
  }
}

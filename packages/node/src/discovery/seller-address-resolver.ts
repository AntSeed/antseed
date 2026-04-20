import type { PeerId } from "../types/peer.js";
import { peerIdToAddress } from "../types/peer.js";
import type { PeerMetadata } from "./peer-metadata.js";
import { debugWarn } from "../utils/debug.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 1024;
const DEFAULT_RPC_RETRIES = 2;
const DEFAULT_RPC_RETRY_BACKOFF_MS = 150;

/**
 * Called by the resolver to ask the chain whether a peer is an authorized
 * operator of a seller contract. Implementations typically wrap an
 * `isOperator(address) view returns (bool)` call on the proxy.
 */
export type IsOperatorChecker = (
  sellerContract: string,
  peerAddress: string,
) => Promise<boolean>;

export class SellerAuthorizationError extends Error {
  constructor(reason: string) {
    super(`seller authorization failed: ${reason}`);
    this.name = "SellerAuthorizationError";
  }
}

interface CacheEntry {
  sellerContract: string;
  verifiedAt: number;
}

/**
 * Resolves the on-chain seller address for a peer.
 *
 * If the peer's metadata advertises a `sellerContract`, the resolver verifies
 * via a single on-chain call (`proxy.isOperator(peerAddress)`) that the peer is
 * an authorized operator for that contract. Result is cached per peer with a
 * short TTL; cache misses go back to chain. Fail-closed on unknown peers.
 */
export class SellerAddressResolver {
  private readonly _cache = new Map<PeerId, CacheEntry>();
  private readonly _ttlMs: number;
  private readonly _maxEntries: number;
  private readonly _isOperator: IsOperatorChecker;
  private readonly _rpcRetries: number;
  private readonly _rpcRetryBackoffMs: number;

  constructor(opts: {
    isOperator: IsOperatorChecker;
    ttlMs?: number;
    maxEntries?: number;
    rpcRetries?: number;
    rpcRetryBackoffMs?: number;
  }) {
    this._isOperator = opts.isOperator;
    this._ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this._maxEntries = opts.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this._rpcRetries = opts.rpcRetries ?? DEFAULT_RPC_RETRIES;
    this._rpcRetryBackoffMs = opts.rpcRetryBackoffMs ?? DEFAULT_RPC_RETRY_BACKOFF_MS;
  }

  /**
   * - No sellerContract in metadata → return peerIdToAddress(peerId) (default).
   * - sellerContract present and chain says peer is an operator → return sellerContract.
   * - sellerContract present but chain says peer is NOT an operator → throw.
   */
  async resolveSellerAddress(peerId: PeerId, metadata?: PeerMetadata): Promise<string> {
    const raw = metadata?.sellerContract;
    if (!raw) return peerIdToAddress(peerId);

    // Normalize to lowercase `0x`-prefixed form so cache hits are stable
    // regardless of casing upstream (defence in depth; the decoder already
    // emits lowercase hex without the prefix).
    const sellerContract = (raw.startsWith("0x") ? raw : "0x" + raw).toLowerCase();

    const cached = this._cache.get(peerId);
    if (
      cached &&
      cached.sellerContract === sellerContract &&
      Date.now() - cached.verifiedAt < this._ttlMs
    ) {
      // Refresh insertion order so eviction is true LRU, not FIFO.
      this._cache.delete(peerId);
      this._cache.set(peerId, cached);
      return cached.sellerContract;
    }

    const peerAddress = peerIdToAddress(peerId);
    const isAuthorized = await this._callIsOperatorWithRetry(sellerContract, peerAddress);

    if (!isAuthorized) {
      debugWarn(
        `[Resolver] peer ${peerId.slice(0, 12)}... is NOT an operator of ${sellerContract}`,
      );
      throw new SellerAuthorizationError("peer is not an authorized operator");
    }

    this._pruneCache();
    this._cache.set(peerId, { sellerContract, verifiedAt: Date.now() });
    return sellerContract;
  }

  invalidate(peerId: PeerId): void {
    this._cache.delete(peerId);
  }

  /**
   * Retry `isOperator` a small number of times with linear backoff before
   * failing closed. Transient RPC blips (timeout, rate limit, fallback
   * provider churn) would otherwise drop peers from discovery for the full
   * negotiation attempt; a couple of cheap retries absorb the common case.
   */
  private async _callIsOperatorWithRetry(
    sellerContract: string,
    peerAddress: string,
  ): Promise<boolean> {
    const maxAttempts = Math.max(1, this._rpcRetries + 1);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this._isOperator(sellerContract, peerAddress);
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this._rpcRetryBackoffMs * attempt));
          continue;
        }
      }
    }
    debugWarn(
      `[Resolver] isOperator(${sellerContract}, ${peerAddress}) RPC failed after ${maxAttempts} attempt(s): ${
        lastErr instanceof Error ? lastErr.message : lastErr
      }`,
    );
    throw new SellerAuthorizationError("isOperator RPC failed");
  }

  private _pruneCache(): void {
    if (this._cache.size < this._maxEntries) return;
    const now = Date.now();
    for (const [peerId, entry] of this._cache) {
      if (now - entry.verifiedAt >= this._ttlMs) this._cache.delete(peerId);
    }
    if (this._cache.size < this._maxEntries) return;
    const oldestKey = this._cache.keys().next().value;
    if (oldestKey !== undefined) this._cache.delete(oldestKey);
  }
}

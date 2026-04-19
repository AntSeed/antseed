import type { PeerId } from "../types/peer.js";
import { peerIdToAddress } from "../types/peer.js";
import type { PeerMetadata } from "./peer-metadata.js";
import { verifySellerDelegation } from "../payments/evm/signatures.js";
import { debugWarn } from "../utils/debug.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 1024;

export type OperatorLoader = (proxyAddress: string) => Promise<string>;

export class SellerDelegationVerificationError extends Error {
  constructor(reason: string) {
    super(`seller delegation verification failed: ${reason}`);
    this.name = "SellerDelegationVerificationError";
  }
}

interface CacheEntry {
  sellerContract: string;
  verifiedAt: number;
  signature: string;
}

export class SellerAddressResolver {
  private readonly _cache = new Map<PeerId, CacheEntry>();
  private readonly _ttlMs: number;
  private readonly _maxEntries: number;
  private readonly _loadOperator: OperatorLoader;
  private readonly _chainId: number;

  constructor(opts: {
    loadOperator: OperatorLoader;
    chainId: number;
    ttlMs?: number;
    maxEntries?: number;
  }) {
    this._loadOperator = opts.loadOperator;
    this._chainId = opts.chainId;
    this._ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this._maxEntries = opts.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  }

  /**
   * Resolve the on-chain seller address for a peer.
   * - No delegation → return peerIdToAddress(peerId).
   * - Delegation present and verifies → return sellerContract.
   * - Delegation present but verification fails → throw SellerDelegationVerificationError.
   */
  async resolveSellerAddress(peerId: PeerId, metadata?: PeerMetadata): Promise<string> {
    const delegation = metadata?.sellerDelegation;
    if (!delegation) return peerIdToAddress(peerId);

    if (delegation.chainId !== this._chainId) {
      throw new SellerDelegationVerificationError(
        `chainId mismatch: delegation=${delegation.chainId} ours=${this._chainId}`,
      );
    }
    if (delegation.expiresAt * 1000 <= Date.now()) {
      throw new SellerDelegationVerificationError("expired");
    }
    if (delegation.peerAddress.toLowerCase() !== peerId) {
      throw new SellerDelegationVerificationError("peerAddress does not match peerId");
    }

    const cached = this._cache.get(peerId);
    if (cached && cached.signature === delegation.signature && Date.now() - cached.verifiedAt < this._ttlMs) {
      return cached.sellerContract;
    }

    const proxyAddress = "0x" + delegation.sellerContract;
    const operator = await this._loadOperator(proxyAddress);
    const valid = verifySellerDelegation(
      proxyAddress,
      {
        peerAddress: peerIdToAddress(peerId),
        sellerContract: proxyAddress,
        chainId: delegation.chainId,
        expiresAt: delegation.expiresAt,
      },
      delegation.signature,
      operator,
    );
    if (!valid) {
      debugWarn(`[Resolver] delegation sig did not match operator=${operator} for peer ${peerId.slice(0, 12)}...`);
      throw new SellerDelegationVerificationError("signature does not match current operator");
    }

    this._pruneCache();
    this._cache.set(peerId, { sellerContract: proxyAddress, verifiedAt: Date.now(), signature: delegation.signature });
    return proxyAddress;
  }

  invalidate(peerId: PeerId): void {
    this._cache.delete(peerId);
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

import type { MeteringStorage, FreeTierConsumption } from '../metering/storage.js';
import { peerIdToAddress } from '../types/peer.js';

export interface SellerFreeTierConfig {
  /** Maximum zero-priced requests accepted from one buyer address per window. */
  maxRequestsPerAddress: number;
  /** Sliding-window duration in milliseconds. Default: 24 hours. */
  windowMs?: number;
}

export interface FreeTierDecision extends FreeTierConsumption {
  buyerAddress: string;
}

export const DEFAULT_FREE_TIER_WINDOW_MS = 24 * 60 * 60_000;
const MAX_IN_MEMORY_BUYERS = 10_000;

export class SellerFreeTierLimiter {
  readonly maxRequestsPerAddress: number;
  readonly windowMs: number;

  private readonly _storage: MeteringStorage | null;
  private readonly _inMemoryUsage = new Map<string, number[]>();

  constructor(config: SellerFreeTierConfig, storage: MeteringStorage | null = null) {
    if (!Number.isSafeInteger(config.maxRequestsPerAddress) || config.maxRequestsPerAddress < 1) {
      throw new Error('freeTier.maxRequestsPerAddress must be a positive safe integer');
    }
    const windowMs = config.windowMs ?? DEFAULT_FREE_TIER_WINDOW_MS;
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) {
      throw new Error('freeTier.windowMs must be a safe integer of at least 1000');
    }
    this.maxRequestsPerAddress = config.maxRequestsPerAddress;
    this.windowMs = windowMs;
    this._storage = storage;
  }

  consume(buyerPeerId: string, service: string, nowMs = Date.now()): FreeTierDecision {
    const buyerAddress = peerIdToAddress(buyerPeerId).toLowerCase();
    const decision = this._storage
      ? this._storage.consumeFreeTierRequest({
        buyerAddress,
        service,
        maxRequests: this.maxRequestsPerAddress,
        windowMs: this.windowMs,
        nowMs,
      })
      : this._consumeInMemory(buyerAddress, nowMs);
    return { ...decision, buyerAddress };
  }

  private _consumeInMemory(buyerAddress: string, nowMs: number): FreeTierConsumption {
    const windowStart = nowMs - this.windowMs;
    let timestamps = this._inMemoryUsage.get(buyerAddress);
    if (!timestamps) {
      this._pruneExpiredBuyers(windowStart);
      if (this._inMemoryUsage.size >= MAX_IN_MEMORY_BUYERS) {
        throw new Error('free-tier limiter capacity reached while persistent metering is unavailable');
      }
      timestamps = [];
      this._inMemoryUsage.set(buyerAddress, timestamps);
    }

    let firstActive = 0;
    while (firstActive < timestamps.length && timestamps[firstActive]! < windowStart) {
      firstActive += 1;
    }
    if (firstActive > 0) timestamps.splice(0, firstActive);

    if (timestamps.length >= this.maxRequestsPerAddress) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, timestamps[0]! + this.windowMs - nowMs),
      };
    }

    timestamps.push(nowMs);
    return {
      allowed: true,
      remaining: this.maxRequestsPerAddress - timestamps.length,
      retryAfterMs: 0,
    };
  }

  private _pruneExpiredBuyers(windowStart: number): void {
    for (const [buyerAddress, timestamps] of this._inMemoryUsage) {
      if ((timestamps.at(-1) ?? 0) < windowStart) {
        this._inMemoryUsage.delete(buyerAddress);
      }
    }
  }
}

/**
 * In-memory cost-control state for the verifier daemon. Both structures are
 * deliberately NOT persisted: a daemon restart forgets failure history and
 * attempt counts, which at worst allows one extra probe batch per seller —
 * bounded and acceptable against the complexity of durable state.
 */

const DEFAULT_BASE_COOLDOWN_MS = 10 * 60 * 1000
const DEFAULT_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * Exponential per-seller failure backoff. A seller whose audits keep
 * finishing uncredited (probe failures, missing ResponseAuth, reverted or
 * uncredited attestations) would otherwise stay stalest-first forever and
 * receive a full paid probe batch every round. Each consecutive failure
 * doubles its cooldown (base 10min, capped at 24h); one credited audit
 * resets it.
 */
export class SellerBackoff {
  private readonly _baseCooldownMs: number
  private readonly _maxCooldownMs: number
  private readonly _entries = new Map<string, { failures: number; blockedUntil: number }>()

  constructor(options?: { baseCooldownMs?: number; maxCooldownMs?: number }) {
    this._baseCooldownMs = options?.baseCooldownMs ?? DEFAULT_BASE_COOLDOWN_MS
    this._maxCooldownMs = options?.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS
  }

  /** Record one uncredited/failed audit and start (or extend) the cooldown. */
  recordFailure(key: string, now = Date.now()): void {
    const failures = (this._entries.get(key)?.failures ?? 0) + 1
    const cooldownMs = Math.min(this._baseCooldownMs * 2 ** (failures - 1), this._maxCooldownMs)
    this._entries.set(key, { failures, blockedUntil: now + cooldownMs })
  }

  /** A credited audit clears the seller's failure history. */
  recordSuccess(key: string): void {
    this._entries.delete(key)
  }

  /** True while the seller is cooling down and must not be probed. */
  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this._entries.get(key)
    return entry !== undefined && now < entry.blockedUntil
  }

  consecutiveFailures(key: string): number {
    return this._entries.get(key)?.failures ?? 0
  }
}

/**
 * Hard cap on ATTEMPTED seller-audits per epoch, tracked separately from the
 * on-chain credited count. Credits only move for successful attestations, so
 * without this cap a seller that never produces a valid ResponseAuth is
 * probed (and paid for) indefinitely while `epochCredits` stays flat.
 */
export class EpochAttemptBudget {
  private readonly _cap: number
  private _epoch = Number.NaN
  private _attempted = 0

  constructor(capPerEpoch: number) {
    this._cap = capPerEpoch
  }

  /** Attempts still allowed in `epoch`; rolls the counter on epoch change. */
  remaining(epoch: number): number {
    if (epoch !== this._epoch) {
      this._epoch = epoch
      this._attempted = 0
    }
    return Math.max(0, this._cap - this._attempted)
  }

  /** Record seller-audits that probe traffic was (or may have been) sent for. */
  recordAttempts(epoch: number, count: number): void {
    if (epoch !== this._epoch) {
      this._epoch = epoch
      this._attempted = 0
    }
    this._attempted += count
  }
}

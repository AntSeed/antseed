/**
 * Shared per-epoch reward claiming for verifier and delegate ANTS rewards.
 *
 * Two invariants every caller gets for free:
 *
 * 1. **One consistent scan window.** `status`, the daemon's claim pass, and
 *    the claim commands all scan the FULL claimable window
 *    (`effectiveEpoch <= epoch < currentEpoch`, straight from the on-chain
 *    gate) — an old unclaimed epoch can never be reported "no unclaimed" by
 *    one surface while another surface still claims it.
 * 2. **Per-epoch fault isolation.** Every epoch is claimed inside its own
 *    try/catch: one reverting epoch (empty pool, gas hiccup, RPC blip) is
 *    reported and skipped instead of blocking every later epoch forever.
 */

export interface EpochWindow {
  currentEpoch: number
  effectiveEpoch: number
}

/**
 * First epoch a claim/status pass scans. `floor` lets a long-running caller
 * (the verifier daemon) resume past epochs it already proved settled instead
 * of re-reading the whole window every round.
 */
export function firstScanEpoch(window: EpochWindow, floor?: number): number {
  return Math.max(window.effectiveEpoch, floor ?? window.effectiveEpoch)
}

/** Reads/writes for one reward stream (verifier or delegate), pre-bound to an address. */
export interface EpochRewardSource {
  credits(epoch: number): Promise<number>
  claimed(epoch: number): Promise<boolean>
  pending(epoch: number): Promise<bigint>
  /** Submit the claim tx; resolves to the tx hash. */
  claim(epoch: number): Promise<string>
}

export interface ClaimEpochsOptions {
  /** Resume floor from a previous pass's `settledThrough`. */
  fromEpoch?: number
  onClaim?: (epoch: number, amount: bigint, tx: string) => void
  onEpochError?: (epoch: number, err: Error) => void
}

export interface ClaimEpochsResult {
  claimedTotal: bigint
  claimedEpochs: number
  /** Epochs whose reads or claim tx failed this pass (claim retried next pass). */
  failedEpochs: number[]
  /**
   * Every epoch below this is conclusively settled (claimed, zero credits,
   * or claimed in this pass) — safe resume floor for the next pass. Stops
   * advancing at the first epoch that failed or still has an unresolved
   * pending amount.
   */
  settledThrough: number
}

/**
 * Claim rewards for every claimable epoch in the window, isolating failures
 * per epoch. An epoch with credits but zero pending reward is skipped without
 * a tx (nothing to claim) and does NOT advance the settled floor, so later
 * passes re-check it.
 */
export async function claimRewardEpochs(
  window: EpochWindow,
  source: EpochRewardSource,
  options: ClaimEpochsOptions = {},
): Promise<ClaimEpochsResult> {
  const first = firstScanEpoch(window, options.fromEpoch)
  let claimedTotal = 0n
  let claimedEpochs = 0
  const failedEpochs: number[] = []
  let settledThrough = first
  let contiguous = true

  for (let epoch = first; epoch < window.currentEpoch; epoch += 1) {
    let settled = false
    try {
      const [credits, claimed] = await Promise.all([source.credits(epoch), source.claimed(epoch)])
      if (claimed || credits === 0) {
        settled = true
      } else {
        const pending = await source.pending(epoch)
        if (pending > 0n) {
          const tx = await source.claim(epoch)
          claimedTotal += pending
          claimedEpochs += 1
          settled = true
          options.onClaim?.(epoch, pending, tx)
        }
      }
    } catch (err) {
      failedEpochs.push(epoch)
      options.onEpochError?.(epoch, err as Error)
    }
    if (contiguous && settled) settledThrough = epoch + 1
    else contiguous = false
  }

  return { claimedTotal, claimedEpochs, failedEpochs, settledThrough }
}

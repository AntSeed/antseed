import type { AbstractSigner } from 'ethers'
import { delegateTargetKey } from '@antseed/node'
import type { StoredCreditAccrual } from './credit-store.js'

/**
 * Claim-side plumbing for discovered delegate-credit accruals: on-chain
 * accrued/claimed resolution and the per-accrual claim loop used by
 * `antseed delegate credits` / `antseed delegate claim`. Accruals are proven
 * by the seller-signed ResponseAuth payloads the verifier anchored, not by any
 * off-chain voucher — the claim's entire input is the
 * (verifier, probeCommitment, buyer, agentId, serviceHash) tuple.
 */

/** Read side of the on-chain accrual accumulators (target-keyed). */
export interface CreditAccrualReader {
  commitmentDelegateAccrued(
    verifier: string,
    probeCommitment: string,
    targetKey: string,
    buyer: string,
  ): Promise<number>
  commitmentDelegateClaimed(
    verifier: string,
    probeCommitment: string,
    targetKey: string,
    buyer: string,
  ): Promise<number>
}

export type CreditState = 'claimable' | 'claimed' | 'empty'

export interface CreditStatus {
  accrual: StoredCreditAccrual
  /** Total credits accrued to this buyer on (verifier, commitment), on-chain. */
  accrued: number
  /** How much the buyer's operator has already claimed. */
  claimed: number
  /** `accrued - claimed`, the amount the next claim can draw (further clamped on-chain to budget + per-epoch cap). */
  claimable: number
  state: CreditState
}

/**
 * Resolve each discovered accrual's on-chain claim state. With no reader
 * (registry not configured / offline listing) accruals show as claimable with
 * their last-seen event credits — the contract clamps and re-checks at claim
 * time. A failed per-accrual read degrades to the last-seen credits with a
 * warning rather than failing the whole listing.
 */
export async function resolveCreditStatuses(
  accruals: readonly StoredCreditAccrual[],
  reader: CreditAccrualReader | null,
  options: { warn?: (message: string) => void } = {},
): Promise<CreditStatus[]> {
  const statuses: CreditStatus[] = []
  for (const accrual of accruals) {
    let accrued = accrual.credits
    let claimed = 0
    if (reader) {
      try {
        const targetKey = delegateTargetKey(accrual.agentId, accrual.serviceHash)
        ;[accrued, claimed] = await Promise.all([
          reader.commitmentDelegateAccrued(accrual.verifier, accrual.probeCommitment, targetKey, accrual.buyer),
          reader.commitmentDelegateClaimed(accrual.verifier, accrual.probeCommitment, targetKey, accrual.buyer),
        ])
      } catch (err) {
        options.warn?.(
          `accrued-status check failed for ${accrual.probeCommitment.slice(0, 10)}…: ${(err as Error).message}`,
        )
      }
    }
    const claimable = Math.max(0, accrued - claimed)
    const state: CreditState = claimable > 0 ? 'claimable' : accrued > 0 ? 'claimed' : 'empty'
    statuses.push({ accrual, accrued, claimed, claimable, state })
  }
  return statuses
}

/** Write side of the claim (matches VerifierRegistryClient.claimDelegateCredits). */
export interface DelegateCreditsClaimer {
  claimDelegateCredits(
    signer: AbstractSigner,
    input: {
      verifier: string
      probeCommitment: string
      buyer: string
      agentId: number | bigint
      serviceHash: string
    },
  ): Promise<string>
}

export interface ClaimCreditsResult {
  claimedCount: number
  claimedCredits: number
  skippedClaimed: number
  skippedEmpty: number
  failed: number
}

/**
 * Claim every claimable accrual, one tx each, isolating failures per accrual
 * — one reverting claim (budget exhausted, epoch cap, RPC blip) must not
 * strand the rest. The signer must be the operator registered for the
 * accrual's buyer in AntseedDeposits; the contract rejects anyone else.
 */
export async function claimDelegateCredits(options: {
  statuses: readonly CreditStatus[]
  registry: DelegateCreditsClaimer
  signer: AbstractSigner
  onClaim?: (status: CreditStatus, tx: string) => void
  onSkip?: (status: CreditStatus) => void
  onError?: (status: CreditStatus, err: Error) => void
}): Promise<ClaimCreditsResult> {
  const result: ClaimCreditsResult = {
    claimedCount: 0,
    claimedCredits: 0,
    skippedClaimed: 0,
    skippedEmpty: 0,
    failed: 0,
  }
  for (const status of options.statuses) {
    if (status.state !== 'claimable') {
      if (status.state === 'claimed') result.skippedClaimed += 1
      else result.skippedEmpty += 1
      options.onSkip?.(status)
      continue
    }
    try {
      const tx = await options.registry.claimDelegateCredits(options.signer, {
        verifier: status.accrual.verifier,
        probeCommitment: status.accrual.probeCommitment,
        buyer: status.accrual.buyer,
        agentId: status.accrual.agentId,
        serviceHash: status.accrual.serviceHash,
      })
      result.claimedCount += 1
      result.claimedCredits += status.claimable
      options.onClaim?.(status, tx)
    } catch (err) {
      result.failed += 1
      options.onError?.(status, err as Error)
    }
  }
  return result
}

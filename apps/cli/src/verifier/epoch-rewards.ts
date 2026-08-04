import type { AbstractSigner } from 'ethers'

export interface EpochWindow {
  currentEpoch: bigint
  effectiveEpoch: bigint
}

export function firstScanEpoch(window: EpochWindow, floor?: bigint): bigint {
  const requested = floor ?? window.effectiveEpoch
  return requested > window.effectiveEpoch ? requested : window.effectiveEpoch
}

export interface EpochRewardSource {
  credits(epoch: bigint): Promise<bigint>
  claimed(epoch: bigint): Promise<boolean>
  pending(epoch: bigint): Promise<bigint>
  claim(epoch: bigint): Promise<string>
}

export function verifierRewardSource(
  registry: { epochCredits(epoch: bigint, verifier: string): Promise<bigint> },
  rewards: {
    epochRewardClaimed(epoch: bigint, verifier: string): Promise<boolean>
    pendingVerifierReward(epoch: bigint, verifier: string): Promise<bigint>
    claimVerifierReward(signer: AbstractSigner, epoch: bigint): Promise<string>
  },
  address: string,
  signer: AbstractSigner,
): EpochRewardSource {
  return {
    credits: (epoch) => registry.epochCredits(epoch, address),
    claimed: (epoch) => rewards.epochRewardClaimed(epoch, address),
    pending: (epoch) => rewards.pendingVerifierReward(epoch, address),
    claim: (epoch) => rewards.claimVerifierReward(signer, epoch),
  }
}

export async function verifierRewardWindow(
  registry: { currentEpoch(): Promise<bigint> },
  rewards: { firstRewardedEpoch(): Promise<bigint> },
): Promise<EpochWindow> {
  const [currentEpoch, effectiveEpoch] = await Promise.all([
    registry.currentEpoch(),
    rewards.firstRewardedEpoch(),
  ])
  return { currentEpoch, effectiveEpoch }
}

export interface ClaimEpochsOptions {
  fromEpoch?: bigint
  onClaim?: (epoch: bigint, amount: bigint, tx: string) => void
  onEpochError?: (epoch: bigint, error: Error) => void
}

export interface ClaimEpochsResult {
  claimedTotal: bigint
  claimedEpochs: number
  failedEpochs: bigint[]
  settledThrough: bigint
}

export async function claimRewardEpochs(
  window: EpochWindow,
  source: EpochRewardSource,
  options: ClaimEpochsOptions = {},
): Promise<ClaimEpochsResult> {
  const first = firstScanEpoch(window, options.fromEpoch)
  let claimedTotal = 0n
  let claimedEpochs = 0
  const failedEpochs: bigint[] = []
  let settledThrough = first
  let contiguous = true

  for (let epoch = first; epoch < window.currentEpoch; epoch += 1n) {
    let settled = false
    try {
      const [credits, claimed] = await Promise.all([source.credits(epoch), source.claimed(epoch)])
      if (claimed || credits === 0n) {
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
    } catch (error) {
      failedEpochs.push(epoch)
      options.onEpochError?.(epoch, error instanceof Error ? error : new Error(String(error)))
    }
    if (contiguous && settled) settledThrough = epoch + 1n
    else contiguous = false
  }

  return { claimedTotal, claimedEpochs, failedEpochs, settledThrough }
}

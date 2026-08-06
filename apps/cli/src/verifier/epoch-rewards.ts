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
  pending(epoch: bigint): Promise<bigint>
  claim(epoch: bigint): Promise<string>
}

export function verifierRewardSource(
  verification: {
    epochCreditUsdMicros(epoch: bigint, verifier: string): Promise<bigint>
    pendingVerifierReward(epoch: bigint, verifier: string): Promise<bigint>
    claimVerifierReward(signer: AbstractSigner, epoch: bigint): Promise<string>
  },
  address: string,
  signer: AbstractSigner,
): EpochRewardSource {
  return {
    credits: (epoch) => verification.epochCreditUsdMicros(epoch, address),
    pending: (epoch) => verification.pendingVerifierReward(epoch, address),
    claim: (epoch) => verification.claimVerifierReward(signer, epoch),
  }
}

export async function verifierRewardWindow(
  verification: { currentEpoch(): Promise<bigint>; firstRewardedEpoch(): Promise<bigint> },
): Promise<EpochWindow> {
  const [currentEpoch, effectiveEpoch] = await Promise.all([
    verification.currentEpoch(),
    verification.firstRewardedEpoch(),
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
      const credits = await source.credits(epoch)
      if (credits === 0n) {
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

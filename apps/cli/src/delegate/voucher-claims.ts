import { Contract, JsonRpcProvider, TypedDataEncoder } from 'ethers'
import type { AbstractSigner } from 'ethers'
import { DELEGATE_VOUCHER_TYPES, makeVerifierRegistryDomain, peerIdToAddress } from '@antseed/node'
import type { DelegateVoucherMessage } from '@antseed/node'
import type { StoredDelegateVoucher } from './voucher-store.js'

/**
 * Claim-side plumbing for persisted DelegateVouchers: EIP-712 digests,
 * on-chain claimed-status resolution, and the per-voucher claim loop used by
 * `antseed delegate vouchers` / `antseed delegate claim`.
 */

/** Contract-shaped voucher struct from a persisted (or wire) voucher record. */
export function toVoucherMessage(voucher: {
  buyer: string
  probeCommitment: string
  credits: number
  nonce: string
  deadline: number
}): DelegateVoucherMessage {
  return {
    buyer: voucher.buyer,
    probeCommitment: voucher.probeCommitment,
    credits: voucher.credits,
    nonce: BigInt(voucher.nonce),
    deadline: voucher.deadline,
  }
}

/**
 * EIP-712 digest of a voucher — exactly what the verifier signed and what
 * AntseedVerifierRegistry keys its replay guard on (per recovered signer):
 * `voucherClaimed(address verifier, bytes32 digest)`.
 */
export function voucherDigest(voucher: StoredDelegateVoucher): string {
  return TypedDataEncoder.hash(
    makeVerifierRegistryDomain(voucher.chainId, voucher.registry),
    DELEGATE_VOUCHER_TYPES,
    toVoucherMessage(voucher),
  )
}

/** Read side of the on-chain replay guard. */
export interface VoucherClaimedReader {
  voucherClaimed(registry: string, verifier: string, digest: string): Promise<boolean>
}

const VOUCHER_CLAIMED_ABI = [
  'function voucherClaimed(address verifier, bytes32 digest) external view returns (bool)',
] as const

/**
 * Minimal on-chain reader for `voucherClaimed(verifier, digest)`. The
 * registry address comes from each voucher (the worker already refuses
 * foreign-domain vouchers at receipt, so in practice it is the configured
 * registry).
 */
export function makeVoucherClaimedReader(rpcUrl: string): VoucherClaimedReader {
  const provider = new JsonRpcProvider(rpcUrl)
  return {
    voucherClaimed: (registry, verifier, digest) =>
      new Contract(registry, VOUCHER_CLAIMED_ABI, provider).getFunction('voucherClaimed')(verifier, digest),
  }
}

export type VoucherState = 'claimable' | 'claimed' | 'expired'

export interface VoucherStatus {
  voucher: StoredDelegateVoucher
  /** Verifier address the voucher signature was verified against at receipt. */
  verifier: string
  digest: string
  state: VoucherState
}

/**
 * Resolve each voucher's claim state. With no reader (registry not
 * configured / offline listing) an unexpired voucher shows as claimable —
 * the contract's replay guard is the source of truth at claim time. A failed
 * per-voucher read degrades to claimable with a warning rather than failing
 * the whole listing.
 */
export async function resolveVoucherStatuses(
  vouchers: readonly StoredDelegateVoucher[],
  reader: VoucherClaimedReader | null,
  options: { nowSecs?: number; warn?: (message: string) => void } = {},
): Promise<VoucherStatus[]> {
  const now = options.nowSecs ?? Math.floor(Date.now() / 1000)
  const statuses: VoucherStatus[] = []
  for (const voucher of vouchers) {
    const verifier = peerIdToAddress(voucher.verifierPeerId)
    const digest = voucherDigest(voucher)
    let state: VoucherState
    if (voucher.deadline < now) {
      state = 'expired'
    } else {
      let claimed = false
      if (reader) {
        try {
          claimed = await reader.voucherClaimed(voucher.registry, verifier, digest)
        } catch (err) {
          options.warn?.(`claimed-status check failed for voucher ${digest.slice(0, 10)}…: ${(err as Error).message}`)
        }
      }
      state = claimed ? 'claimed' : 'claimable'
    }
    statuses.push({ voucher, verifier, digest, state })
  }
  return statuses
}

/** Write side of the claim (matches VerifierRegistryClient.claimDelegateCredits). */
export interface DelegateCreditsClaimer {
  claimDelegateCredits(signer: AbstractSigner, voucher: DelegateVoucherMessage, signature: string): Promise<string>
}

export interface ClaimVouchersResult {
  claimedCount: number
  claimedCredits: number
  skippedClaimed: number
  skippedExpired: number
  failed: number
}

/**
 * Claim every claimable voucher, one tx each, isolating failures per voucher
 * — one reverting voucher (budget exhausted, epoch cap, RPC blip) must not
 * strand the rest. The signer must be the operator registered for the
 * voucher's buyer in AntseedDeposits; the contract rejects anyone else.
 */
export async function claimDelegateVouchers(options: {
  statuses: readonly VoucherStatus[]
  registry: DelegateCreditsClaimer
  signer: AbstractSigner
  onClaim?: (status: VoucherStatus, tx: string) => void
  onSkip?: (status: VoucherStatus) => void
  onError?: (status: VoucherStatus, err: Error) => void
}): Promise<ClaimVouchersResult> {
  const result: ClaimVouchersResult = {
    claimedCount: 0,
    claimedCredits: 0,
    skippedClaimed: 0,
    skippedExpired: 0,
    failed: 0,
  }
  for (const status of options.statuses) {
    if (status.state !== 'claimable') {
      if (status.state === 'claimed') result.skippedClaimed += 1
      else result.skippedExpired += 1
      options.onSkip?.(status)
      continue
    }
    try {
      const tx = await options.registry.claimDelegateCredits(
        options.signer,
        toVoucherMessage(status.voucher),
        status.voucher.signature,
      )
      result.claimedCount += 1
      result.claimedCredits += status.voucher.credits
      options.onClaim?.(status, tx)
    } catch (err) {
      result.failed += 1
      options.onError?.(status, err as Error)
    }
  }
  return result
}

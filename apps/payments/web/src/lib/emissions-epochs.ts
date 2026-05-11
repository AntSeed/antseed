import type { EmissionsPendingRow } from './api';

/**
 * Picks the epochs the user can actually claim for one side
 * (seller or buyer). A row is claimable when:
 *   - it's not the current epoch (not yet finalised on-chain)
 *   - that side has not already been claimed
 *   - the side's pending amount is non-zero
 *
 * Returns the epoch numbers as bigints, which is what the
 * `claimSellerEmissions` / `claimBuyerEmissions` ABIs expect.
 */
export function selectClaimableEpochs(
  rows: readonly EmissionsPendingRow[],
  side: 'seller' | 'buyer',
): bigint[] {
  return rows
    .filter((r) => !r.isCurrent && !r[side].claimed && r[side].amount !== '0')
    .map((r) => BigInt(r.epoch));
}

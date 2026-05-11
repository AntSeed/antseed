import { describe, it, expect } from 'vitest';
import { selectClaimableEpochs } from '../lib/emissions-epochs';
import type { EmissionsPendingRow } from '../lib/api';

function row(overrides: Partial<EmissionsPendingRow> & {
  epoch: number;
  isCurrent?: boolean;
  seller?: Partial<EmissionsPendingRow['seller']>;
  buyer?: Partial<EmissionsPendingRow['buyer']>;
}): EmissionsPendingRow {
  return {
    epoch: overrides.epoch,
    epochEmission: '0',
    isCurrent: overrides.isCurrent ?? false,
    seller: {
      amount: '0',
      userPoints: '0',
      totalPoints: '0',
      claimed: false,
      ...(overrides.seller ?? {}),
    },
    buyer: {
      amount: '0',
      userPoints: '0',
      totalPoints: '0',
      claimed: false,
      ...(overrides.buyer ?? {}),
    },
  };
}

describe('selectClaimableEpochs', () => {
  it('returns an empty array when there are no rows', () => {
    expect(selectClaimableEpochs([], 'seller')).toEqual([]);
    expect(selectClaimableEpochs([], 'buyer')).toEqual([]);
  });

  it('skips the current epoch even when there is a pending amount', () => {
    const rows = [
      row({ epoch: 7, isCurrent: true, seller: { amount: '100' } }),
    ];
    expect(selectClaimableEpochs(rows, 'seller')).toEqual([]);
  });

  it('skips rows already claimed for that side', () => {
    const rows = [
      row({ epoch: 5, seller: { amount: '100', claimed: true } }),
    ];
    expect(selectClaimableEpochs(rows, 'seller')).toEqual([]);
  });

  it('skips rows where the side has a zero amount', () => {
    const rows = [
      row({ epoch: 4, seller: { amount: '0' } }),
    ];
    expect(selectClaimableEpochs(rows, 'seller')).toEqual([]);
  });

  it('returns the epoch as a bigint when claimable', () => {
    const rows = [
      row({ epoch: 12, seller: { amount: '1' } }),
    ];
    expect(selectClaimableEpochs(rows, 'seller')).toEqual([12n]);
  });

  it('filters the seller side independently of the buyer side', () => {
    const rows = [
      // Seller claimable, buyer already claimed.
      row({ epoch: 1, seller: { amount: '100' }, buyer: { amount: '50', claimed: true } }),
      // Buyer claimable, seller zero.
      row({ epoch: 2, seller: { amount: '0' }, buyer: { amount: '25' } }),
    ];
    expect(selectClaimableEpochs(rows, 'seller')).toEqual([1n]);
    expect(selectClaimableEpochs(rows, 'buyer')).toEqual([2n]);
  });

  it('preserves the order of the input rows', () => {
    const rows = [
      row({ epoch: 9, seller: { amount: '1' } }),
      row({ epoch: 3, seller: { amount: '1' } }),
      row({ epoch: 7, seller: { amount: '1' } }),
    ];
    expect(selectClaimableEpochs(rows, 'seller')).toEqual([9n, 3n, 7n]);
  });

  it('includes a mix of claimable and non-claimable rows correctly', () => {
    const rows = [
      row({ epoch: 1, isCurrent: true, seller: { amount: '100' } }),       // current → skip
      row({ epoch: 2, seller: { amount: '100', claimed: true } }),          // claimed → skip
      row({ epoch: 3, seller: { amount: '0' } }),                            // zero amount → skip
      row({ epoch: 4, seller: { amount: '50' } }),                           // claimable
      row({ epoch: 5, seller: { amount: '75' } }),                           // claimable
    ];
    expect(selectClaimableEpochs(rows, 'seller')).toEqual([4n, 5n]);
  });
});

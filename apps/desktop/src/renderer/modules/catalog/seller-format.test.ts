import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../../core/state';
import { sellerReputationLabel } from './seller-format.js';

test('seller reputation displays the effective model score, not raw trust', () => {
  const route = {
    effectiveReputationScore: 78.4,
    onChainReputationScore: 100,
    onChainTrustScore: 10_432,
  } as DiscoverRow;
  assert.equal(sellerReputationLabel(route), '7.8');
});

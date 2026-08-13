import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../../core/state';
import { sellerMetaLabel, sellerReputationLabel } from './seller-format.js';

test('seller reputation displays the effective model score, not raw trust', () => {
  const route = {
    effectiveReputationScore: 78.4,
    onChainReputationScore: 100,
    onChainTrustScore: 10_432,
  } as DiscoverRow;
  assert.equal(sellerReputationLabel(route), '7.8');
});

test('seller metadata omits the last settlement date', () => {
  const route = {
    protocol: 'openai-chat-completions',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    onChainLastSettledAt: 1_786_569_600,
  } as DiscoverRow;
  assert.equal(sellerMetaLabel(route), '$1/m input · $5/m output');
});

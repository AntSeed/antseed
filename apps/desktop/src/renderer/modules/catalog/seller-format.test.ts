import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../../core/state';
import { sellerMetaLabel, sellerReputationLabel, sellerReputationExplanation } from './seller-format.js';

test('seller reputation explains public history separately from chain evidence', () => {
  const route = { effectiveReputationScore: 70,
    reputationBreakdown: { version: 1, rawChainScore: 0, legacyChainScore: null, externalScore: 70 } } as DiscoverRow;
  assert.match(sellerReputationExplanation(route), /Chain: 0.0\/10/);
  assert.match(sellerReputationExplanation(route), /Public history after failure penalties: 7.0\/10/);
  assert.match(sellerReputationExplanation(route), /not proof of service quality/);
});

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

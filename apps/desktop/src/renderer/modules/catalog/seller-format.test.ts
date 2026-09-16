import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../../core/state';
import { sellerMetaLabel, sellerReputationLabel, sellerReputationExplanation } from './seller-format.js';

test('seller reputation explains the trust formula part by part', () => {
  const route = {
    effectiveReputationScore: 74,
    onChainReputationScore: 74,
    trust: {
      score: 74,
      usage: { score: 59, usdc: 120, epoch: 12 },
      identity: { score: 50, kind: 'github', claim: 'portfolio' },
      stake: { score: 15, powerShareBps: 10_000 },
      washFlagged: false,
    },
  } as DiscoverRow;
  assert.equal(
    sellerReputationExplanation(route),
    'Trust 7.4/10 = max(usage 5.9, identity 5.0 GitHub) + stake 1.5. Not flagged for wash trading.',
  );
});

test('seller reputation shows n/a, none and 0 for missing trust parts', () => {
  const route = {
    effectiveReputationScore: 0,
    onChainReputationScore: 0,
    trust: { score: 0, usage: null, identity: null, stake: null, washFlagged: null },
  } as DiscoverRow;
  assert.equal(
    sellerReputationExplanation(route),
    'Trust 0.0/10 = max(usage n/a, identity none) + stake 0. Wash-trading registry unavailable.',
  );
});

test('seller reputation calls out proven wash traders', () => {
  const route = {
    effectiveReputationScore: 0,
    onChainReputationScore: 0,
    trust: {
      score: 0,
      usage: { score: 90, usdc: 800, epoch: 12 },
      identity: null,
      stake: { score: 5, powerShareBps: 1_100 },
      washFlagged: true,
    },
  } as DiscoverRow;
  assert.equal(
    sellerReputationExplanation(route),
    'Trust 0/10: flagged as a proven wash trader by the on-chain registry.',
  );
});

test('seller reputation falls back to the label when no breakdown is available', () => {
  const route = { effectiveReputationScore: 42, onChainReputationScore: 42, trust: null } as DiscoverRow;
  assert.equal(sellerReputationExplanation(route), 'Trust: 4.2/10');
});

test('seller reputation displays the effective model score, not the raw trust score', () => {
  const route = {
    effectiveReputationScore: 78.4,
    onChainReputationScore: 100,
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

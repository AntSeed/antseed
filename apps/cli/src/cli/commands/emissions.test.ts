import assert from 'node:assert/strict';
import test from 'node:test';
import { claimablePendingForRole, pastEpochs } from './emissions.js';

test('pastEpochs returns finalized epoch ids before current epoch', () => {
  assert.deepEqual(pastEpochs(0), []);
  assert.deepEqual(pastEpochs(4), [0, 1, 2, 3]);
});

test('claimablePendingForRole only selects the requested reward bucket', () => {
  const pending = {
    seller: 10n,
    buyer: 25n,
  };

  assert.equal(claimablePendingForRole(pending, 'seller'), 10n);
  assert.equal(claimablePendingForRole(pending, 'buyer'), 25n);
});

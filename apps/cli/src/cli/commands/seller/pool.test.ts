import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateEarlyExit, positionState, validateStakeEpochs } from './pool.js';

const position = { id: 1, owner: '0x1', agentId: 2, amount: 1n, weightAmount: 1n, stakeStartEpoch: 5, stakeEndEpoch: 9, closedAtEpoch: 0, withdrawn: false };
test('positionState covers pending, active, matured, and withdrawn positions', () => {
  assert.equal(positionState(position, 4), 'pending');
  assert.equal(positionState(position, 5), 'active');
  assert.equal(positionState(position, 9), 'matured');
  assert.equal(positionState({ ...position, withdrawn: true }, 6), 'withdrawn');
});
test('validateStakeEpochs enforces contract bounds', () => {
  assert.doesNotThrow(() => validateStakeEpochs(4, 1, 104));
  assert.throws(() => validateStakeEpochs(0, 1, 104));
  assert.throws(() => validateStakeEpochs(105, 1, 104));
});
test('estimateEarlyExit reports exact principal loss and return', () => {
  assert.deepEqual(estimateEarlyExit({ ...position, amount: 100n * 10n ** 18n }, 2500), {
    id: 1,
    amount: 100n * 10n ** 18n,
    slashBps: 2500,
    slashedAmount: 25n * 10n ** 18n,
    returnedAmount: 75n * 10n ** 18n,
  });
});

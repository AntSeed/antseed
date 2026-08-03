import test from 'node:test';
import assert from 'node:assert/strict';

import { readPeerHealth } from './peer-health.js';

const NOW = 1_700_000_000_000;

test('a missing health entry reads as healthy', () => {
  assert.deepEqual(readPeerHealth(undefined, NOW), {
    cooldownUntil: null,
    failureStreak: 0,
    lastFailureReason: null,
  });
});

test('an active cooldown is surfaced with its streak and reason', () => {
  assert.deepEqual(
    readPeerHealth({ cooldownUntil: NOW + 30_000, failureStreak: 3, lastReason: 'seller-5xx' }, NOW),
    { cooldownUntil: NOW + 30_000, failureStreak: 3, lastFailureReason: 'seller-5xx' },
  );
});

test('an expired cooldown is normalized away rather than left for callers to compare', () => {
  const health = readPeerHealth({ cooldownUntil: NOW - 1, failureStreak: 3 }, NOW);
  assert.equal(health.cooldownUntil, null);
  // The streak survives so a flaky peer still loses ties after the cooldown lapses.
  assert.equal(health.failureStreak, 3);
});

test('malformed fields fall back to healthy defaults', () => {
  assert.deepEqual(
    readPeerHealth({ cooldownUntil: 'soon', failureStreak: Number.NaN, lastReason: 42 } as never, NOW),
    { cooldownUntil: null, failureStreak: 0, lastFailureReason: null },
  );
});

test('a negative or fractional streak is clamped to a sane integer', () => {
  assert.equal(readPeerHealth({ failureStreak: -5 }, NOW).failureStreak, 0);
  assert.equal(readPeerHealth({ failureStreak: 2.9 }, NOW).failureStreak, 2);
});

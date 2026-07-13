import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SellerBackoff, EpochAttemptBudget } from './backoff.js'

test('SellerBackoff blocks after a failure and doubles the cooldown', () => {
  const backoff = new SellerBackoff({ baseCooldownMs: 100, maxCooldownMs: 1_000 })
  const t0 = 1_000_000

  assert.equal(backoff.isBlocked('s1', t0), false)

  backoff.recordFailure('s1', t0)
  assert.equal(backoff.isBlocked('s1', t0 + 99), true)
  assert.equal(backoff.isBlocked('s1', t0 + 100), false)

  // Second consecutive failure: 200ms cooldown.
  backoff.recordFailure('s1', t0 + 100)
  assert.equal(backoff.isBlocked('s1', t0 + 100 + 199), true)
  assert.equal(backoff.isBlocked('s1', t0 + 100 + 200), false)
  assert.equal(backoff.consecutiveFailures('s1'), 2)

  // Third: 400ms.
  backoff.recordFailure('s1', t0 + 300)
  assert.equal(backoff.isBlocked('s1', t0 + 300 + 399), true)
  assert.equal(backoff.isBlocked('s1', t0 + 300 + 400), false)
})

test('SellerBackoff caps the cooldown at maxCooldownMs', () => {
  const backoff = new SellerBackoff({ baseCooldownMs: 100, maxCooldownMs: 250 })
  const t0 = 0
  for (let i = 0; i < 10; i += 1) backoff.recordFailure('s1', t0)
  assert.equal(backoff.isBlocked('s1', t0 + 249), true)
  assert.equal(backoff.isBlocked('s1', t0 + 250), false)
})

test('SellerBackoff resets on success', () => {
  const backoff = new SellerBackoff({ baseCooldownMs: 100, maxCooldownMs: 1_000 })
  backoff.recordFailure('s1', 0)
  backoff.recordFailure('s1', 0)
  backoff.recordSuccess('s1')
  assert.equal(backoff.isBlocked('s1', 1), false)
  assert.equal(backoff.consecutiveFailures('s1'), 0)
  // Next failure starts from the base cooldown again.
  backoff.recordFailure('s1', 1_000)
  assert.equal(backoff.isBlocked('s1', 1_000 + 99), true)
  assert.equal(backoff.isBlocked('s1', 1_000 + 100), false)
})

test('SellerBackoff keys are independent', () => {
  const backoff = new SellerBackoff({ baseCooldownMs: 100 })
  backoff.recordFailure('s1', 0)
  assert.equal(backoff.isBlocked('s2', 1), false)
})

test('EpochAttemptBudget enforces the cap and rolls over on epoch change', () => {
  const budget = new EpochAttemptBudget(5)
  assert.equal(budget.remaining(1), 5)
  budget.recordAttempts(1, 3)
  assert.equal(budget.remaining(1), 2)
  budget.recordAttempts(1, 3)
  assert.equal(budget.remaining(1), 0)
  // New epoch resets the counter.
  assert.equal(budget.remaining(2), 5)
  // Attempts recorded against a new epoch reset first.
  budget.recordAttempts(3, 1)
  assert.equal(budget.remaining(3), 4)
})

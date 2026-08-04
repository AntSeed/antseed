import assert from 'node:assert/strict'
import test from 'node:test'
import { UsdcBudget } from './benchmark-budget.js'

test('USDC budget accounts for concurrent reservations and actual charges', () => {
  const budget = new UsdcBudget(100n)
  const first = budget.reserve(60n)
  assert.throws(() => budget.reserve(50n), /budget exhausted/)
  assert.equal(budget.commit(first, 40n), 40n)

  const second = budget.reserve(60n)
  assert.equal(budget.getAvailable(), 0n)
  budget.release(second)
  assert.equal(budget.getAvailable(), 60n)
  assert.equal(budget.getSpent(), 40n)
})

test('USDC budget rejects seller charges above the reservation', () => {
  const budget = new UsdcBudget(100n)
  const ticket = budget.reserve(50n)
  assert.throws(() => budget.commit(ticket, 51n), /exceeded reserved/)
  budget.release(ticket)
  assert.equal(budget.getSpent(), 0n)
})

test('USDC budget restores persisted spend on resume', () => {
  const budget = new UsdcBudget(100n, 75n)
  assert.throws(() => budget.reserve(26n), /budget exhausted/)
  const ticket = budget.reserve(25n)
  assert.equal(budget.commit(ticket, 20n), 95n)
})

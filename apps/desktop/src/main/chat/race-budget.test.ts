import test from 'node:test';
import assert from 'node:assert/strict';
import { raceBudget } from './race-budget.js';

test('resolves with the task value when it finishes inside the budget', async () => {
  const out = await raceBudget(Promise.resolve('fast'), 1_000, () => 'fallback');
  assert.equal(out, 'fast');
});

test('resolves with the fallback when the task never settles', async () => {
  const never = new Promise<string>(() => {});
  const startedAt = Date.now();
  const out = await raceBudget(never, 50, () => 'fallback');
  assert.equal(out, 'fallback');
  assert.ok(Date.now() - startedAt < 1_000, 'must return around the budget, not hang');
});

test('resolves with the fallback when the task rejects', async () => {
  const out = await raceBudget(Promise.reject(new Error('boom')), 1_000, () => 'fallback');
  assert.equal(out, 'fallback');
});

test('a slow task still settles in the background after the fallback fired', async () => {
  let resolveTask: (value: string) => void = () => {};
  const task = new Promise<string>((resolve) => { resolveTask = resolve; });
  const out = await raceBudget(task, 20, () => 'fallback');
  assert.equal(out, 'fallback');
  // The caller moved on, but the underlying work is not cancelled — a later
  // completion (feeding some cache) must not throw or unhandled-reject.
  resolveTask('late');
  assert.equal(await task, 'late');
});

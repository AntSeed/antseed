import assert from 'node:assert/strict';
import { test } from 'vitest';
import { consumeQuickDepositRequest, requestQuickDeposit } from './deposit-navigation';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

test('quick deposit requests are consumed once', () => {
  const storage = memoryStorage();
  requestQuickDeposit(storage);
  assert.equal(consumeQuickDepositRequest(storage), true);
  assert.equal(consumeQuickDepositRequest(storage), false);
});

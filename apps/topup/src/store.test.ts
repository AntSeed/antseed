import { describe, expect, it } from 'vitest';
import { TopupStore, type TopupInsert } from './store.js';

function row(id: string): TopupInsert {
  return {
    id,
    state: 'settling',
    buyer: '0x2222222222222222222222222222222222222222',
    payer: '0x5555555555555555555555555555555555555555',
    network: 'base',
    grossAmount: '5000000',
    authNonce: `0x${'11'.repeat(32)}`,
    authValidBefore: 1_900_000_000,
    signature: '0xsig',
    payloadJson: '{}',
    requirementsJson: '{}',
    startBlock: 40,
  };
}

describe('TopupStore', () => {
  it('inserts and reads back a row', () => {
    const store = new TopupStore(':memory:');
    const inserted = store.insert(row('0xa'));
    expect(inserted.state).toBe('settling');
    expect(inserted.netAmount).toBeNull();
    expect(store.get('0xa')?.grossAmount).toBe('5000000');
    expect(store.get('0xmissing')).toBeNull();
  });

  it('applies partial updates including explicit nulls', () => {
    const store = new TopupStore(':memory:');
    store.insert(row('0xa'));
    const updated = store.update('0xa', { state: 'settled', settleTx: '0xtx', error: 'boom' });
    expect(updated.state).toBe('settled');
    expect(updated.settleTx).toBe('0xtx');
    const cleared = store.update('0xa', { error: null });
    expect(cleared.error).toBeNull();
    expect(cleared.settleTx).toBe('0xtx');
  });

  it('throws when updating a missing row', () => {
    const store = new TopupStore(':memory:');
    expect(() => store.update('0xnope', { state: 'failed' })).toThrow(/not found/);
  });

  it('lists rows by state in insertion order', () => {
    const store = new TopupStore(':memory:');
    store.insert(row('0xa'));
    store.insert(row('0xb'));
    store.update('0xb', { state: 'deposited' });
    const settling = store.listByStates(['settling', 'settled']);
    expect(settling.map((r) => r.id)).toEqual(['0xa']);
    expect(store.listByStates([])).toEqual([]);
  });

  it('rejects duplicate ids', () => {
    const store = new TopupStore(':memory:');
    store.insert(row('0xa'));
    expect(() => store.insert(row('0xa'))).toThrow();
  });
});

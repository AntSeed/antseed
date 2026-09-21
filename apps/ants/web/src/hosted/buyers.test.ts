import { describe, expect, it } from 'vitest';
import { ZeroAddress } from 'ethers';
import { BuyerStore, verifyBuyer } from './buyers';

const wallet = '0x0000000000000000000000000000000000000001';
const other = '0x0000000000000000000000000000000000000002';
const buyer = '0x0000000000000000000000000000000000000003';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('saved buyer accounts', () => {
  it('persists selection and labels across reloads without treating the wallet as a buyer', () => {
    const persistence = storage();
    const store = new BuyerStore(persistence);
    expect(store.load(8453, wallet)).toEqual({ buyers: [], selected: null });
    store.add(8453, wallet, buyer, 'Work');
    store.add(8453, wallet, other, 'Home');
    store.select(8453, wallet, buyer);
    store.rename(8453, wallet, buyer, 'Laptop');
    expect(new BuyerStore(persistence).load(8453, wallet)).toEqual({ buyers: [{ address: buyer, label: 'Laptop' }, { address: other, label: 'Home' }], selected: buyer });
  });
  it('isolates lists by wallet and network and removes only the local entry', () => {
    const store = new BuyerStore(storage());
    store.add(8453, wallet, buyer, 'Work');
    expect(store.load(84532, wallet).buyers).toEqual([]);
    expect(store.load(8453, other).buyers).toEqual([]);
    expect(store.remove(8453, wallet, buyer)).toEqual({ buyers: [], selected: null });
  });
  it('rejects duplicates, invalid addresses, zero addresses and unknown selections', () => {
    const store = new BuyerStore(storage());
    store.add(8453, wallet, buyer, 'Work');
    expect(() => store.add(8453, wallet, buyer, '')).toThrow('already saved');
    expect(() => store.add(8453, wallet, 'bad', '')).toThrow();
    expect(() => store.add(8453, wallet, ZeroAddress, '')).toThrow('nonzero');
    expect(() => store.select(8453, wallet, other)).toThrow('Unknown');
  });
  it('keeps an in-memory list when storage is blocked', () => {
    const store = new BuyerStore({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    store.add(8453, wallet, buyer, 'Work');
    expect(store.load(8453, wallet).selected).toBe(buyer);
    expect(store.persistent).toBe(false);
  });
  it('does not trust malformed saved data', () => {
    const store = new BuyerStore({ getItem: () => '{broken', setItem() {} });
    expect(store.load(8453, wallet)).toEqual({ buyers: [], selected: null });
    expect(store.persistent).toBe(false);
  });
});

describe('buyer authorization', () => {
  it('rechecks the operator and detects transfers', async () => {
    let operator = wallet;
    expect((await verifyBuyer(buyer, wallet, async () => operator)).status).toBe('authorized');
    operator = other;
    expect(await verifyBuyer(buyer, wallet, async () => operator)).toEqual({ status: 'view-only', operator: other });
  });
  it('distinguishes unlinked from unavailable without granting permissions', async () => {
    expect((await verifyBuyer(buyer, wallet, async () => ZeroAddress)).status).toBe('unlinked');
    expect((await verifyBuyer(buyer, wallet, async () => { throw new Error('offline'); })).status).toBe('error');
  });
});

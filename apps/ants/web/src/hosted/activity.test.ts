import { describe, expect, it } from 'vitest';
import type { Provider } from 'ethers';
import { ActivityStore, withWalletLock } from './activity';

const wallet = '0x0000000000000000000000000000000000000001';
const target = '0x0000000000000000000000000000000000000002';
const hash = `0x${'ab'.repeat(32)}`;
const intent = { id: 'intent', from: wallet, to: target, chainId: 8453, value: '0', data: '0x1234', nonceFloor: 5 };
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
  return { store: new ActivityStore(storage, 8453), storage };
}

describe('hosted recovery', () => {
  it('persists intent, approval state and broadcast hash across reloads', () => {
    const { store, storage } = fixture();
    store.record(intent, target);
    store.record({ ...intent, approvalStarted: true }, target);
    store.record({ ...intent, approvalStarted: true, submittedHash: hash }, target);
    expect(new ActivityStore(storage, 8453).transactions(wallet)).toEqual([expect.objectContaining({ ...intent, buyer: target, approvalStarted: true, submittedHash: hash })]);
  });
  it.each([1, 0])('tracks confirmed/reverted receipts without resubmitting: %s', async status => {
    const { store } = fixture();
    store.record({ ...intent, submittedHash: hash }, target);
    const provider = { getTransactionReceipt: async () => ({ status }), getTransaction: async () => ({ ...intent, chainId: 8453n, value: 0n, nonce: 5 }) } as unknown as Provider;
    expect(await store.track(provider, store.transactions(wallet)[0]!)).toBe(status ? 'confirmed' : 'reverted');
    expect(store.transactions(wallet)[0]!.resolved).toBe(true);
  });
  it('retains pending and uncertain approvals', async () => {
    const { store } = fixture();
    store.record(intent, target);
    const provider = { getTransactionReceipt: async () => null } as unknown as Provider;
    await expect(store.track(provider, store.transactions(wallet)[0]!)).rejects.toThrow('no recorded hash');
    store.record({ ...intent, submittedHash: hash }, target);
    expect(await store.track(provider, store.transactions(wallet)[0]!)).toBe('pending');
    expect(store.transactions(wallet)[0]!.resolved).toBeUndefined();
  });
  it.each([{ to: wallet }, { from: target }, { nonce: 4 }, { data: '0x' }, { value: 1n }, { chainId: 1n }])('rejects unrelated transactions: %#', async mismatch => {
    const { store } = fixture();
    store.record({ ...intent, submittedHash: hash }, target);
    const provider = { getTransactionReceipt: async () => ({ status: 1 }), getTransaction: async () => ({ ...intent, chainId: 8453n, value: 0n, nonce: 5, ...mismatch }) } as unknown as Provider;
    await expect(store.track(provider, store.transactions(wallet)[0]!)).rejects.toThrow('does not match');
  });
  it('fails closed without persistence', () => {
    expect(() => new ActivityStore(null, 8453).record(intent, target)).toThrow('storage');
  });
});

describe('wallet lock', () => {
  it('requires Web Locks and refuses a contended wallet', async () => {
    await expect(withWalletLock(undefined, 8453, wallet, async () => true)).rejects.toThrow('Web Locks');
    const locks = { request: async (_name: string, _options: unknown, callback: (lock: null) => Promise<unknown>) => callback(null) } as Pick<LockManager, 'request'>;
    await expect(withWalletLock(locks, 8453, wallet, async () => true)).rejects.toThrow('Another tab');
  });
  it('keys locks by wallet and chain and releases after failure', async () => {
    const names: string[] = [];
    const locks = { request: async (name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => { names.push(name); return callback({}); } } as Pick<LockManager, 'request'>;
    await expect(withWalletLock(locks, 8453, wallet, async () => { throw new Error('rejected'); })).rejects.toThrow('rejected');
    expect(await withWalletLock(locks, 8453, wallet, async () => true)).toBe(true);
    expect(names).toEqual([`ants.hosted.write:8453:${wallet}`, `ants.hosted.write:8453:${wallet}`]);
  });
});

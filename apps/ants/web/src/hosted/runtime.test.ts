import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroAddress } from 'ethers';
import { HostedRuntime } from './runtime';
import { AntsContext } from '../../../src/service/context';
import type { DashboardConfig } from '../api';
import type { JobView } from '../../../src/api-types';
import type { BuyerList } from './buyers';

const calls = vi.hoisted(() => ({ claim: vi.fn(), stakeUsageRewards: vi.fn(), positions: vi.fn(), seller: vi.fn(), split: vi.fn(), merge: vi.fn(), maxLock: vi.fn() }));
vi.mock('../../../src/service/index', async original => ({ ...await original<object>(), ...calls }));
vi.mock('../data', () => ({ invalidateAll: vi.fn() }));

const wallet = '0x0000000000000000000000000000000000000001';
const buyer = '0x0000000000000000000000000000000000000002';
const other = '0x0000000000000000000000000000000000000003';
const chain = { chainId: 'base-mainnet', evmChainId: 8453, rpcUrl: 'https://rpc.invalid' };
const locks = { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}) } as Pick<LockManager, 'request'>;
function runtime() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } } as Storage;
  return new HostedRuntime(chain, 'project', storage, locks);
}
const post = <T = unknown>(app: HostedRuntime, path: string, body: unknown) => app.request<T>(path, { method: 'POST', body });
const connect = (app: HostedRuntime, address = wallet) => post(app, '/api/wallet', { address, chainId: 8453 });

beforeEach(() => {
  vi.restoreAllMocks();
  for (const mock of Object.values(calls)) mock.mockReset();
  vi.spyOn(AntsContext.prototype, 'provider').mockReturnValue({} as ReturnType<AntsContext['provider']>);
  vi.spyOn(AntsContext.prototype, 'deposits').mockReturnValue({ getOperator: async () => wallet } as unknown as ReturnType<AntsContext['deposits']>);
});

describe('hosted account runtime', () => {
  const positionActions = [
    { path: '/api/positions/split', kind: 'split', method: 'split', body: { positionId: 1, amount: '2' } },
    { path: '/api/positions/merge', kind: 'merge', method: 'merge', body: { positionIds: [1, 2] } },
    { path: '/api/positions/max-lock', kind: 'max-lock', method: 'maxLock', body: { positionId: 1, enable: true } },
    { path: '/api/positions/max-lock', kind: 'max-lock', method: 'maxLock', body: { positionId: 1, enable: false } },
  ] as const;
  it.each(positionActions)('runs $kind through shared services without a buyer: $body', async ({ path, kind, method, body }) => {
    const app = runtime();
    await connect(app);
    const job = await post<JobView>(app, path, body);
    await vi.waitFor(() => expect(job.status).toBe('done'));
    expect(job).toMatchObject({ kind, owner: wallet });
    expect(calls[method]).toHaveBeenCalledWith(expect.objectContaining({ address: wallet, buyerAddress: null }), body, expect.any(Function));
  });
  it.each(positionActions)('requires a connected wallet on the correct network for $kind', async ({ path, method, body }) => {
    const app = runtime();
    await expect(post(app, path, body)).rejects.toThrow('Connect your wallet');
    await post(app, '/api/wallet', { address: wallet, chainId: 1 });
    await expect(post(app, path, body)).rejects.toThrow();
    expect(calls[method]).not.toHaveBeenCalled();
  });
  it.each(positionActions)('does not run $kind when another tab holds the wallet lock', async ({ path, method, body }) => {
    const contended = { request: async (_name: string, _options: unknown, callback: (lock: null) => Promise<unknown>) => callback(null) } as Pick<LockManager, 'request'>;
    const storage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
    const app = new HostedRuntime(chain, 'project', storage, contended);
    await connect(app);
    const job = await post<JobView>(app, path, body);
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job.error).toContain('Another tab');
    expect(calls[method]).not.toHaveBeenCalled();
  });
  it('loads without tokens, connects the selected wallet, and never infers a buyer', async () => {
    const app = runtime();
    expect(await app.request<DashboardConfig>('/api/config')).toMatchObject({ address: ZeroAddress, buyerAddress: null, readOnly: true });
    await connect(app);
    expect(await app.request<DashboardConfig>('/api/config')).toMatchObject({ address: wallet, buyerAddress: null, readOnly: false, canAuthorize: false });
  });
  it('selects buyers without changing the staking/seller wallet and restores lists after reconnect', async () => {
    const app = runtime();
    await connect(app);
    await post(app, '/api/hosted/buyers/add', { address: buyer, label: 'Work' });
    await app.request('/api/positions');
    await app.request('/api/seller');
    expect(calls.positions.mock.calls[0]![0]).toMatchObject({ address: wallet, buyerAddress: buyer });
    expect(calls.seller.mock.calls[0]![0]).toMatchObject({ address: wallet });
    await connect(app, other);
    expect(await app.request<BuyerList>('/api/hosted/buyers')).toMatchObject({ buyers: [], selected: null });
    await post(app, '/api/wallet', { disconnect: true });
    expect((await app.request<DashboardConfig>('/api/config')).address).toBe(ZeroAddress);
    await connect(app);
    expect((await app.request<DashboardConfig>('/api/config')).buyerAddress).toBe(buyer);
  });
  it.each(['/api/rewards/claim', '/api/rewards/stake-usage'])('runs buyer actions entirely in browser services: %s', async path => {
    const app = runtime();
    await connect(app);
    await post(app, '/api/hosted/buyers/add', { address: buyer, label: 'Work' });
    const job = await post<JobView>(app, path, { scope: 'buyer', buckets: ['buyer'], side: 'buyer', epochs: 4, stakeAgentId: 2 });
    await vi.waitFor(() => expect(job.status).toBe('done'));
    const call = path.endsWith('claim') ? calls.claim : calls.stakeUsageRewards;
    expect(call.mock.calls[0]![0]).toMatchObject({ address: wallet, buyerAddress: buyer });
  });
  it('fails closed when operator authorization is transferred', async () => {
    const app = runtime();
    await connect(app);
    await post(app, '/api/hosted/buyers/add', { address: buyer });
    vi.spyOn(AntsContext.prototype, 'deposits').mockReturnValue({ getOperator: async () => other } as unknown as ReturnType<AntsContext['deposits']>);
    const job = await post<JobView>(app, '/api/rewards/claim', { scope: 'buyer', buckets: ['buyer'] });
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(calls.claim).not.toHaveBeenCalled();
  });
  it('blocks buyer changes during actions and preserves the original identity after external wallet switch', async () => {
    const app = runtime();
    await connect(app);
    await post(app, '/api/hosted/buyers/add', { address: buyer });
    let finish!: () => void;
    calls.claim.mockImplementation(async () => new Promise<void>(resolve => { finish = resolve; }));
    const job = await post<JobView>(app, '/api/rewards/claim', { scope: 'buyer', buckets: ['buyer'] });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(post(app, '/api/hosted/buyers/select', { address: null })).rejects.toThrow('current action');
    const original = calls.claim.mock.calls[0]![0] as AntsContext;
    await connect(app, other);
    expect(original.address).toBe(wallet);
    expect(original.buyerAddress).toBe(buyer);
    expect(await app.request('/api/jobs')).toEqual([]);
    await connect(app);
    expect(await app.request('/api/jobs')).toEqual([expect.objectContaining({ status: 'running', owner: wallet })]);
    finish();
    await vi.waitFor(() => expect(job.status).toBe('done'));
  });
  it('rejects buyer actions without a selection', async () => {
    const app = runtime();
    await connect(app);
    const job = await post<JobView>(app, '/api/rewards/claim', { scope: 'buyer', buckets: ['buyer'] });
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job.error).toContain('Select a buyer');
  });
  it('discards a read completed for a previous wallet', async () => {
    const app = runtime();
    await connect(app);
    let resolve!: (value: object) => void;
    calls.positions.mockImplementation(() => new Promise(complete => { resolve = complete; }));
    const pending = app.request('/api/positions');
    const rejected = expect(pending).rejects.toThrow('Account changed');
    await connect(app, other);
    resolve({ owner: wallet });
    await rejected;
  });
});

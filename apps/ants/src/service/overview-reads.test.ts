import { beforeEach, describe, expect, it, vi } from 'vitest';
import { multicallRead } from '@antseed/node/payments';
import { overviewReads } from './overview-reads.js';
import type { AntsContext, ResolvedStack } from './context.js';
vi.mock('@antseed/node/payments', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));
const address = '0x0000000000000000000000000000000000000001';
const provider = { getBalance: vi.fn(async () => 99n) };
const ctx = {
  address, chain: { sellerPoolsAddress: address, sellerRegistryAddress: address, emissionsGateAddress: address, sellerPoolsRewardsAddress: address, usageRewardsAddress: address },
  antsToken: () => ({ contractAddress: address }), provider: () => provider,
} as unknown as AntsContext;
const stack = { currentEpoch: 22, legacyStaking: address } as ResolvedStack;
beforeEach(() => {
  vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(request =>
    request.method === 'transfersEnabled' ? [false] : request.method === 'transferWhitelist' ? [true] : request.method === 'usageEpochBudgets' ? [7n, 8n] : [10n]));
});
describe('batched overview', () => {
  it('groups contract reads and retains separate buyer/seller budgets and restrictions', async () => {
    const result = await overviewReads(ctx, stack);
    expect(result).toMatchObject({ ants: 10n, eth: 99n, transfersEnabled: false, whitelisted: true, positionCount: 10, usageBudgets: { buyer: 7n, seller: 8n } });
    expect(vi.mocked(multicallRead).mock.calls.at(-1)![1]).toHaveLength(14);
  });
  it('rejects an incomplete balance read instead of displaying a zero', async () => {
    vi.mocked(multicallRead).mockResolvedValue([null]);
    await expect(overviewReads(ctx, stack)).rejects.toThrow('balanceOf');
  });
});

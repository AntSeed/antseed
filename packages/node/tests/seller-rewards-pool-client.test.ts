import { Interface, ZeroAddress, type AbstractProvider } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { SellerRewardsPoolClient, validateRewardAddress } from '../src/payments/evm/seller-rewards-pool-client.js';

const seller = '0x0000000000000000000000000000000000000001';
const pool = '0x0000000000000000000000000000000000000002';
const policy = '0x0000000000000000000000000000000000000003';
const registry = '0x0000000000000000000000000000000000000004';
const token = '0x0000000000000000000000000000000000000005';
const legacy = '0x0000000000000000000000000000000000000006';
const washRegistry = '0x0000000000000000000000000000000000000007';
const contractInterface = new Interface([
  'function lockedRewards(address) view returns (uint256)',
  'function sellerClaimPolicy() view returns (address)',
  'function registry() view returns (address)',
  'function antsToken() view returns (address)',
  'function transfersEnabled() view returns (bool)',
  'function transferWhitelist(address) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function cumulativeLocked(address) view returns (uint256)',
  'function releaseBps() view returns (uint256)',
  'function lastEpoch() view returns (uint256)',
  'function v2() view returns (address)',
  'function washTradingRegistry() view returns (address)',
  'function isWashTrader(address) view returns (bool)',
  'function claimableSellerRewards(address,uint256) view returns (uint256)',
  'function claim(address)',
]);

function fixture(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    lockedRewards: 960n, sellerClaimPolicy: policy, registry, antsToken: token,
    transfersEnabled: false, transferWhitelist: true, balanceOf: 960n,
    cumulativeLocked: 1000n, releaseBps: 1000n, lastEpoch: 21n, v2: legacy,
    washTradingRegistry: washRegistry, isWashTrader: false, claimableSellerRewards: 60n,
    ...overrides,
  };
  const provider = {
    getBlockNumber: vi.fn(async () => 55),
    call: vi.fn(async (transaction: { data: string; blockTag?: number; from?: string }) => {
      const parsed = contractInterface.parseTransaction(transaction)!;
      if (parsed.name === 'claim') return '0x';
      if (!(parsed.name in values)) throw new Error('unsupported policy');
      return contractInterface.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    }),
    estimateGas: vi.fn(async () => 100_000n),
    getFeeData: vi.fn(async () => ({ maxFeePerGas: 2n, gasPrice: 1n })),
    getBalance: vi.fn(async () => 1_000_000n),
  };
  const client = new SellerRewardsPoolClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: pool }).withProvider(provider as unknown as AbstractProvider);
  return { client, provider, values };
}

describe('legacy seller rewards client', () => {
  it('reads cumulative entitlement and prior withdrawals at one block', async () => {
    const { client, provider } = fixture();
    expect(await client.details(seller)).toMatchObject({
      blockNumber: 55, locked: 960n, transferAllowed: true,
      policy: { cumulativeLocked: 1000n, entitlement: 100n, withdrawn: 40n, claimable: 60n, washTradingRegistry: washRegistry },
    });
    expect(provider.call.mock.calls.every(([transaction]) => transaction.blockTag === 55)).toBe(true);
  });

  it('reads the installed release share rather than hardcoding 10%', async () => {
    const { client } = fixture({ releaseBps: 1500n, claimableSellerRewards: 110n });
    expect((await client.details(seller)).policy?.entitlement).toBe(150n);
  });

  it('distinguishes a missing policy from a zero allowance', async () => {
    expect((await fixture({ sellerClaimPolicy: ZeroAddress }).client.details(seller)).policy).toBeNull();
    expect((await fixture({ isWashTrader: true, claimableSellerRewards: 0n }).client.details(seller)).policy).toMatchObject({ restricted: true, claimable: 0n });
  });

  it('reports transfer blockers and honors globally enabled transfers', async () => {
    expect((await fixture({ transferWhitelist: false }).client.details(seller)).transferAllowed).toBe(false);
    expect((await fixture({ transferWhitelist: false, transfersEnabled: true }).client.details(seller)).transferAllowed).toBe(true);
  });

  it('preserves the policy defensive cumulative floor and clamps the allowance', async () => {
    const { client } = fixture({ cumulativeLocked: 10n, claimableSellerRewards: 2000n });
    expect((await client.details(seller)).policy).toMatchObject({ cumulativeLocked: 10n, accountingCumulative: 960n, withdrawn: 0n, claimable: 960n });
  });

  it('does not turn read failures into zero rewards', async () => {
    const { client, provider } = fixture();
    provider.call.mockRejectedValue(new Error('RPC unavailable'));
    await expect(client.details(seller)).rejects.toThrow('RPC unavailable');
    await expect(client.claimable(seller)).rejects.toThrow('RPC unavailable');
  });

  it('simulates as the seller with the selected recipient and estimates buffered gas', async () => {
    const { client, provider } = fixture();
    expect(await client.previewClaim(seller, washRegistry)).toMatchObject({ gasEstimate: 100_000n, gasLimit: 130_000n, maxExecutionFee: 260_000n });
    const [transaction] = provider.call.mock.calls[0]!;
    expect(transaction.from).toBe(seller);
    expect(contractInterface.parseTransaction(transaction)!.args[0]).toBe(washRegistry);
  });

  it('rejects simulation failures, insufficient gas funds, and unavailable fee data', async () => {
    const { client, provider } = fixture();
    provider.call.mockRejectedValueOnce(new Error('NothingToClaim'));
    await expect(client.previewClaim(seller, seller)).rejects.toThrow('NothingToClaim');
    provider.getBalance.mockResolvedValue(0n);
    await expect(client.previewClaim(seller, seller)).rejects.toThrow('Insufficient ETH');
    provider.getFeeData.mockResolvedValue({ maxFeePerGas: null, gasPrice: null } as never);
    await expect(client.previewClaim(seller, seller)).rejects.toThrow('gas price');
  });

  it('rejects invalid and zero recipients before any RPC call', async () => {
    const { client, provider } = fixture();
    expect(() => validateRewardAddress(ZeroAddress)).toThrow('zero address');
    await expect(client.previewClaim(seller, 'not-an-address')).rejects.toThrow();
    await expect(client.previewClaim(seller, ZeroAddress)).rejects.toThrow('zero address');
    expect(provider.call).not.toHaveBeenCalled();
  });
});

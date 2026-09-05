import { describe, expect, it } from 'vitest';
import type { ChainConfig } from './chain-config.js';
import {
  ContractStackMismatchError,
  legacyEpochs,
  newEpochs,
  resolveContractStack,
} from './contract-stack.js';

const legacyEmissions = '0x0000000000000000000000000000000000000011';
const legacyStaking = '0x0000000000000000000000000000000000000012';
const usageAccounting = '0x0000000000000000000000000000000000000021';
const sellerRegistry = '0x0000000000000000000000000000000000000022';

function config(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId: 'base-mainnet', evmChainId: 8453, rpcUrl: 'http://rpc',
    registryContractAddress: '0x0000000000000000000000000000000000000001',
    depositsContractAddress: '0x0000000000000000000000000000000000000002',
    channelsContractAddress: '0x0000000000000000000000000000000000000003',
    usdcContractAddress: '0x0000000000000000000000000000000000000004',
    emissionsContractAddress: legacyEmissions,
    stakingContractAddress: legacyStaking,
    ...overrides,
  };
}

describe('resolveContractStack', () => {
  it('resolves legacy mode', async () => {
    const result = await resolveContractStack(config(), {
      registryClient: { emissions: async () => legacyEmissions, staking: async () => legacyStaking },
      legacyEmissionsClient: { getEpochInfo: async () => ({ epoch: 7 }) },
    });
    expect(result.mode).toBe('legacy');
    expect(result.currentEpoch).toBe(7);
  });

  it('resolves recognized usage and honors overrides', async () => {
    const result = await resolveContractStack(config({ usageAccountingAddress: usageAccounting, sellerRegistryAddress: sellerRegistry }), {
      registryClient: { emissions: async () => usageAccounting, staking: async () => sellerRegistry },
      usageAccountingClient: { currentEpoch: async () => 12, firstRewardedEpoch: async () => 9 },
    });
    expect(result).toMatchObject({ mode: 'recognized-usage', currentEpoch: 12, firstRewardedEpoch: 9 });
    expect(result.addresses.usageAccountingAddress).toBe(usageAccounting);
  });

  it.each([
    ['mismatch', usageAccounting, legacyStaking],
    ['zero emissions', '0x0000000000000000000000000000000000000000', legacyStaking],
    ['mixed stack', usageAccounting, legacyStaking],
  ])('rejects %s', async (_name, emissions, staking) => {
    await expect(resolveContractStack(config({ usageAccountingAddress: usageAccounting, sellerRegistryAddress: sellerRegistry }), {
      registryClient: { emissions: async () => emissions, staking: async () => staking },
    })).rejects.toBeInstanceOf(ContractStackMismatchError);
  });

  it('wraps RPC errors', async () => {
    await expect(resolveContractStack(config(), {
      registryClient: { emissions: async () => { throw new Error('offline'); }, staking: async () => legacyStaking },
    })).rejects.toThrow('offline');
  });

  it('rejects missing registry configuration', async () => {
    await expect(resolveContractStack(config({ registryContractAddress: undefined }))).rejects.toBeInstanceOf(ContractStackMismatchError);
  });
});

describe('epoch ranges', () => {
  it('splits legacy and new epochs at cutover', () => {
    expect(legacyEpochs(8, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(newEpochs(8, 5)).toEqual([5, 6, 7]);
  });
});

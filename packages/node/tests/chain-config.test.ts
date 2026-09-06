import { describe, expect, it } from 'vitest';
import { getChainConfig, resolveChainConfig } from '../src/payments/chain-config.js';
import { DEPLOYED_CONTRACT_ADDRESSES } from '../src/payments/generated-contract-addresses.js';

describe('recognized-usage deployment configuration', () => {
  it('exposes the generated inventory separately from active endpoints', () => {
    const config = getChainConfig('base-mainnet');
    const generated = DEPLOYED_CONTRACT_ADDRESSES['base-mainnet'];
    expect(config.recognizedUsage).toEqual(generated.recognizedUsage);
    expect(config.recognizedUsage?.contracts.emissionsGate).toBeDefined();
    expect(config.registryContractAddress).toBe(generated.registryContractAddress);
    expect(config.emissionsContractAddress).toBe(generated.emissionsContractAddress);
    expect(config.stakingContractAddress).toBe(generated.stakingContractAddress);
  });

  it('preserves inventory when overriding an RPC endpoint', () => {
    const config = resolveChainConfig({ chainId: 'base-mainnet', rpcUrl: 'http://localhost:8545' });
    expect(config.recognizedUsage).toEqual(getChainConfig('base-mainnet').recognizedUsage);
    expect(config.rpcUrl).toBe('http://localhost:8545');
    expect(config.fallbackRpcUrls).toEqual([]);
  });

  it('does not expose mainnet deployment metadata for local chains', () => {
    expect(getChainConfig('base-local').recognizedUsage).toBeUndefined();
  });
});

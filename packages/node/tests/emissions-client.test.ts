import { describe, it, expect } from 'vitest';
import { EmissionsClient } from '../src/payments/evm/emissions-client.js';

describe('EmissionsClient', () => {
  it('initializes with config', () => {
    const client = new EmissionsClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '3'.repeat(40),
    });
    expect(client.contractAddress).toBe('0x' + '3'.repeat(40));
    expect(client.provider).toBeDefined();
  });

  it('has all expected methods', () => {
    const client = new EmissionsClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '3'.repeat(40),
    });
    expect(typeof client.claimSellerEmissions).toBe('function');
    expect(typeof client.claimBuyerEmissions).toBe('function');
    expect(typeof client.pendingEmissions).toBe('function');
    expect(typeof client.getEpochInfo).toBe('function');
    expect(typeof client.flushReserve).toBe('function');
  });

  it('pendingEmissions returns correct type shape', async () => {
    const client = new EmissionsClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '3'.repeat(40),
    });
    // We can only verify the method exists and returns a promise
    // (actual call would need a running node with deployed contract)
    const result = client.pendingEmissions('0x' + '1'.repeat(40), [0]);
    expect(result).toBeInstanceOf(Promise);
  });

  it('has all new ABI methods', () => {
    const client = new EmissionsClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '3'.repeat(40),
    });
    expect(typeof client.getEpochEmission).toBe('function');
    expect(typeof client.getGenesis).toBe('function');
    expect(typeof client.getHalvingInterval).toBe('function');
    expect(typeof client.getShares).toBe('function');
    expect(typeof client.epochTotalSellerPoints).toBe('function');
    expect(typeof client.epochTotalBuyerPoints).toBe('function');
    expect(typeof client.userSellerPoints).toBe('function');
    expect(typeof client.userBuyerPoints).toBe('function');
    expect(typeof client.sellerEpochClaimed).toBe('function');
    expect(typeof client.buyerEpochClaimed).toBe('function');
  });

  it('does not expose the removed stale ABI methods', () => {
    const client = new EmissionsClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '3'.repeat(40),
    }) as unknown as Record<string, unknown>;
    expect(client.totalSellerPoints).toBeUndefined();
    expect(client.totalBuyerPoints).toBeUndefined();
  });
});

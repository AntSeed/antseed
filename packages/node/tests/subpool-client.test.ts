import { describe, it, expect } from 'vitest';
import { SubPoolClient } from '../src/payments/evm/subpool-client.js';

describe('SubPoolClient', () => {
  it('initializes with config', () => {
    const client = new SubPoolClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '3'.repeat(40),
    });
    expect(client.contractAddress).toBe('0x' + '3'.repeat(40));
    expect(client.provider).toBeDefined();
  });

  it('has all expected methods', () => {
    const client = new SubPoolClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '3'.repeat(40),
    });
    expect(typeof client.subscribe).toBe('function');
    expect(typeof client.renewSubscription).toBe('function');
    expect(typeof client.cancelSubscription).toBe('function');
    expect(typeof client.isSubscriptionActive).toBe('function');
    expect(typeof client.getRemainingDailyBudget).toBe('function');
    expect(typeof client.recordTokenUsage).toBe('function');
    expect(typeof client.optIn).toBe('function');
    expect(typeof client.optOut).toBe('function');
    expect(typeof client.claimRevenue).toBe('function');
    expect(typeof client.getProjectedRevenue).toBe('function');
    expect(typeof client.getTier).toBe('function');
    expect(typeof client.getOptedInPeerCount).toBe('function');
    expect(typeof client.currentEpoch).toBe('function');
    expect(typeof client.currentEpochRevenue).toBe('function');
  });

  it('getTier returns correct structure type hints', () => {
    const client = new SubPoolClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '3'.repeat(40),
    });
    // Verify the method exists and is callable (actual RPC calls would fail without a node)
    expect(client.getTier).toBeDefined();
  });
});

import { describe, it, expect } from 'vitest';
import { ANTSTokenClient } from '../src/payments/evm/ants-token-client.js';

describe('ANTSTokenClient', () => {
  it('initializes with config', () => {
    const client = new ANTSTokenClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '2'.repeat(40),
    });
    expect(client.contractAddress).toBe('0x' + '2'.repeat(40));
    expect(client.provider).toBeDefined();
  });

  it('has all expected methods', () => {
    const client = new ANTSTokenClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '2'.repeat(40),
    });
    expect(typeof client.balanceOf).toBe('function');
    expect(typeof client.totalSupply).toBe('function');
    expect(typeof client.transfersEnabled).toBe('function');
    expect(typeof client.setRegistry).toBe('function');
    expect(typeof client.enableTransfers).toBe('function');
    expect(typeof client.transferOwnership).toBe('function');
  });
});

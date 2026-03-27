import { describe, it, expect } from 'vitest';
import { IdentityClient } from '../src/payments/evm/identity-client.js';

describe('IdentityClient (ERC-8004)', () => {
  it('initializes with config', () => {
    const client = new IdentityClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '1'.repeat(40),
    });
    expect(client.contractAddress).toBe('0x' + '1'.repeat(40));
    expect(client.provider).toBeDefined();
  });

  it('has all expected methods', () => {
    const client = new IdentityClient({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0x' + '1'.repeat(40),
    });
    expect(typeof client.register).toBe('function');
    expect(typeof client.isRegistered).toBe('function');
    expect(typeof client.getMetadata).toBe('function');
  });
});

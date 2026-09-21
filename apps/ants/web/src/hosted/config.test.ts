import { describe, expect, it } from 'vitest';
import { hostedConfig } from './config';

describe('hosted deployment configuration', () => {
  it('pins production to repository mainnet contracts and ignores test overrides', () => {
    const config = hostedConfig({ MODE: 'hosted', VITE_ANTS_CHAIN: 'base-local', VITE_ANTS_TEST_CONFIG: '{"evmChainId":31337}' });
    expect(config.chain.evmChainId).toBe(8453);
    expect(config.chain.depositsContractAddress).toMatch(/^0x/);
  });
  it('rejects local or insecure production endpoints', () => {
    expect(() => hostedConfig({ MODE: 'hosted', VITE_ANTS_RPC_URL: 'http://127.0.0.1:8545' })).toThrow('HTTPS');
    expect(() => hostedConfig({ MODE: 'hosted', VITE_ANTS_EXPLORER_URL: 'https://localhost' })).toThrow('HTTPS');
  });
  it('accepts explicit test-chain configuration only in the test build', () => {
    expect(hostedConfig({ MODE: 'hosted-test', VITE_ANTS_CHAIN: 'base-local' }).chain.evmChainId).toBe(31337);
  });
});

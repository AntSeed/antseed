import { describe, expect, it, vi } from 'vitest';
import { Interface, type AbstractProvider } from 'ethers';
import { IdentityClient } from './identity-client.js';

describe('browser identity metadata', () => {
  it('decodes metadata bytes without a Buffer global', async () => {
    const iface = new Interface(['function getMetadata(uint256,string) view returns(bytes)']);
    const provider = { call: async () => iface.encodeFunctionResult('getMetadata', ['0x0001feff']) } as unknown as AbstractProvider;
    const client = new IdentityClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: '0x0000000000000000000000000000000000000001' }).withProvider(provider);
    vi.stubGlobal('Buffer', undefined);
    try { expect(await client.getMetadata(1, 'test')).toEqual(new Uint8Array([0, 1, 254, 255])); }
    finally { vi.unstubAllGlobals(); }
  });
});

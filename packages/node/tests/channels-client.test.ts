import { describe, expect, it, vi } from 'vitest';
import { ChannelsClient } from '../src/payments/evm/channels-client.js';
import { AbiCoder } from 'ethers';

describe('ChannelsClient readAddress probe', () => {
  it('passes the requested finalized block to channel reads', async () => {
    const client = new ChannelsClient({
      rpcUrl: 'http://127.0.0.1:1', contractAddress: `0x${'cc'.repeat(20)}`, evmChainId: 31337,
    });
    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint128', 'uint128', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint8'],
      [`0x${'aa'.repeat(20)}`, `0x${'bb'.repeat(20)}`, 1_000_000n, 0n, `0x${'00'.repeat(32)}`, 900n, 0n, 0n, 1],
    );
    const call = vi.spyOn(client.provider, 'call').mockResolvedValueOnce('0x').mockResolvedValueOnce(encoded);
    await expect(client.getSession(`0x${'dd'.repeat(32)}`, 123)).resolves.toMatchObject({ status: 1, deposit: 1_000_000n });
    expect(call.mock.calls[1]?.[0]).toMatchObject({ blockTag: 123 });
    client.provider.destroy();
  });

  it('falls back to the configured contract when channelsAddress() returns extra words', async () => {
    const configuredAddress = '0x' + 'cc'.repeat(20);
    const client = new ChannelsClient({
      rpcUrl: 'http://127.0.0.1:8545',
      contractAddress: configuredAddress,
      evmChainId: 31337,
    });

    const provider = (client as unknown as { _provider: { call: ReturnType<typeof vi.fn> } })._provider;
    provider.call = vi.fn().mockResolvedValue(
      '0x' +
      '00000000000000000000000000000000000000000000000000000002540be400' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '00000000000000000000000000000000000000000000000000000000680f66a6',
    );

    await expect(client.readAddress).resolves.toBe(configuredAddress);
  });
});

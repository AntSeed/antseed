import { describe, expect, it, vi } from 'vitest';
import { ChannelsClient } from '../src/payments/evm/channels-client.js';

describe('ChannelsClient readAddress probe', () => {
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

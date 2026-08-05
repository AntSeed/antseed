import { describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { DepositRelayClient } from '../src/payments/evm/deposit-relay-client.js';

const RELAY = '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318';
const BUYER = '0x1111111111111111111111111111111111111111';
const RELAYER = '0x2222222222222222222222222222222222222222';
const NONCE = '0x' + 'aa'.repeat(32);
const TX_HASH = '0x' + '77'.repeat(32);

const RELAY_IFACE = new Interface([
  'event SweepExecuted(address indexed buyer, address indexed relayer, uint256 deposited, uint256 fee, bytes32 authNonce)',
]);

function makeClientWithReceipt(receipt: unknown): DepositRelayClient {
  const client = new DepositRelayClient({
    rpcUrl: 'http://127.0.0.1:1',
    contractAddress: RELAY,
    evmChainId: 31337,
  });
  vi.spyOn(client.provider, 'getTransactionReceipt').mockResolvedValue(receipt as never);
  return client;
}

describe('DepositRelayClient', () => {
  it('confirms a matching SweepExecuted event from a transaction receipt', async () => {
    const encoded = RELAY_IFACE.encodeEventLog(
      RELAY_IFACE.getEvent('SweepExecuted')!,
      [BUYER, RELAYER, 4_950_000n, 50_000n, NONCE],
    );
    const client = makeClientWithReceipt({
      status: 1,
      hash: TX_HASH,
      blockNumber: 123,
      logs: [{ address: RELAY, topics: encoded.topics, data: encoded.data }],
    });

    const confirmation = await client.getSweepConfirmation(TX_HASH, {
      buyer: BUYER,
      deposited: 4_950_000n,
      fee: 50_000n,
      authNonce: NONCE,
    });

    expect(confirmation).toEqual({
      txHash: TX_HASH,
      blockNumber: 123,
      buyer: BUYER,
      relayer: RELAYER,
      deposited: 4_950_000n,
      fee: 50_000n,
      authNonce: NONCE,
    });
  });

  it('does not confirm receipts whose relay event does not match the requested nonce', async () => {
    const encoded = RELAY_IFACE.encodeEventLog(
      RELAY_IFACE.getEvent('SweepExecuted')!,
      [BUYER, RELAYER, 4_950_000n, 50_000n, NONCE],
    );
    const client = makeClientWithReceipt({
      status: 1,
      hash: TX_HASH,
      blockNumber: 123,
      logs: [{ address: RELAY, topics: encoded.topics, data: encoded.data }],
    });

    await expect(client.getSweepConfirmation(TX_HASH, {
      buyer: BUYER,
      deposited: 4_950_000n,
      fee: 50_000n,
      authNonce: '0x' + 'bb'.repeat(32),
    })).resolves.toBeNull();
  });
});

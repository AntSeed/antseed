import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { DepositsClient } from './deposits-client.js';

const DEPOSITED_ABI = [
  'event Deposited(address indexed buyer, uint256 amount)',
] as const;

const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000001';
const USDC_ADDRESS = '0x0000000000000000000000000000000000000002';

function makeClient(): DepositsClient {
  return new DepositsClient({ rpcUrl: 'http://localhost:8545', contractAddress: CONTRACT_ADDRESS, usdcAddress: USDC_ADDRESS });
}

function buildLog(params: {
  buyer: string;
  amount: bigint;
  blockNumber: number;
  transactionHash: string;
  index: number;
}) {
  const iface = new ethers.Interface(DEPOSITED_ABI);
  const encoded = iface.encodeEventLog('Deposited', [params.buyer, params.amount]);
  return {
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: params.blockNumber,
    transactionHash: params.transactionHash,
    index: params.index,
    address: CONTRACT_ADDRESS,
  };
}

describe('DepositsClient.getDepositHistory', () => {
  it('decodes Deposited logs and resolves block timestamps', async () => {
    const buyer = ethers.getAddress('0xabcdef1234567890abcdef1234567890abcdef12');
    const amount = 5_000_000n;
    const blockNumber = 1000;
    const transactionHash = '0x' + 'ff'.repeat(32);

    const cannedLog = buildLog({ buyer, amount, blockNumber, transactionHash, index: 2 });

    const client = makeClient();
    (client as any)._provider.getLogs = async () => [cannedLog];
    (client as any)._provider.getBlock = async () => ({ timestamp: 1_700_000_000 });

    const events = await client.getDepositHistory(buyer, { fromBlock: 0, toBlock: 2000 });

    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.buyer).toBe(buyer.toLowerCase());
    expect(evt.amount).toBe(amount);
    expect(evt.blockNumber).toBe(blockNumber);
    expect(evt.txHash).toBe(transactionHash);
    expect(evt.logIndex).toBe(2);
    expect(evt.timestamp).toBe(1_700_000_000);
  });

  it('sorts events ascending by (blockNumber, logIndex)', async () => {
    const buyer = '0x0000000000000000000000000000000000000003';
    const base = { buyer, amount: 1_000_000n, transactionHash: '0x' + '00'.repeat(32) };

    const log1 = buildLog({ ...base, blockNumber: 5, index: 0 });
    const log2 = buildLog({ ...base, blockNumber: 3, index: 1 });
    const log3 = buildLog({ ...base, blockNumber: 3, index: 0 });

    const client = makeClient();
    (client as any)._provider.getLogs = async () => [log1, log2, log3];
    (client as any)._provider.getBlock = async () => ({ timestamp: 1_700_000_000 });

    const events = await client.getDepositHistory(buyer, { fromBlock: 0, toBlock: 10 });

    expect(events).toHaveLength(3);
    expect(events[0]!.blockNumber).toBe(3);
    expect(events[0]!.logIndex).toBe(0);
    expect(events[1]!.blockNumber).toBe(3);
    expect(events[1]!.logIndex).toBe(1);
    expect(events[2]!.blockNumber).toBe(5);
    expect(events[2]!.logIndex).toBe(0);
  });

  it('halves the block range and retries when the RPC rejects a wide getLogs call', async () => {
    const buyer = ethers.getAddress('0xabcdef1234567890abcdef1234567890abcdef12');
    const amount = 2_000_000n;
    const transactionHash = '0x' + 'ab'.repeat(32);
    const cannedLog = buildLog({ buyer, amount, blockNumber: 750, transactionHash, index: 0 });

    const client = makeClient();
    const calls: Array<{ fromBlock: number; toBlock: number }> = [];
    (client as any)._provider.getLogs = async (params: { fromBlock: number; toBlock: number }) => {
      calls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock });
      const span = params.toBlock - params.fromBlock + 1;
      if (span > 600) {
        throw new Error('block range exceeds the maximum allowed');
      }
      return params.fromBlock <= 750 && 750 <= params.toBlock ? [cannedLog] : [];
    };
    (client as any)._provider.getBlock = async () => ({ timestamp: 1_700_000_000 });

    const events = await client.getDepositHistory(buyer, { fromBlock: 0, toBlock: 999, chunkSize: 1000 });

    expect(events).toHaveLength(1);
    expect(events[0]!.blockNumber).toBe(750);
    // The initial full-range call failed and was split into narrower retries.
    expect(calls.some((c) => c.toBlock - c.fromBlock + 1 > 600)).toBe(true);
    expect(calls.some((c) => c.toBlock - c.fromBlock + 1 <= 600)).toBe(true);
  });

  it('gives up once the adaptive range hits the minimum chunk floor', async () => {
    const buyer = '0x0000000000000000000000000000000000000004';
    const client = makeClient();
    (client as any)._provider.getLogs = async () => {
      throw new Error('persistently rejected');
    };

    await expect(client.getDepositHistory(buyer, { fromBlock: 0, toBlock: 999, chunkSize: 1000 }))
      .rejects.toThrow('persistently rejected');
  });

  it('returns an empty list without querying when fromBlock is after toBlock', async () => {
    const buyer = '0x0000000000000000000000000000000000000005';
    const client = makeClient();
    let called = false;
    (client as any)._provider.getLogs = async () => { called = true; return []; };

    const events = await client.getDepositHistory(buyer, { fromBlock: 100, toBlock: 50 });

    expect(events).toEqual([]);
    expect(called).toBe(false);
  });
});

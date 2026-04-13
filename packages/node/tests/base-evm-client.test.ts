import { describe, it, expect, vi } from 'vitest';
import type { AbstractSigner, InterfaceAbi, TransactionRequest, TransactionResponse } from 'ethers';
import { BaseEvmClient } from '../src/payments/evm/base-evm-client.js';

class TestEvmClient extends BaseEvmClient {
  constructor() {
    super('http://127.0.0.1:1', '0x' + 'aa'.repeat(20));
  }
  async exec(signer: AbstractSigner, abi: InterfaceAbi, method: string, ...args: unknown[]): Promise<string> {
    return this._execWrite(signer, abi, method, ...args);
  }
  get nonceCursor(): Map<string, number> {
    return this._nonceCursor;
  }
}

const ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
] as const;

describe('BaseEvmClient._execWrite', () => {
  it('applies a 30% buffer over estimateGas before sending the tx', async () => {
    const client = new TestEvmClient();

    // Stub the nonce read so we never touch the network.
    vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(42);

    const captured: TransactionRequest[] = [];
    const fakeSigner = {
      provider: client.provider,
      getAddress: async () => '0x' + 'bb'.repeat(20),
      connect() { return fakeSigner; },
      estimateGas: async (_tx: TransactionRequest) => 100_000n,
      sendTransaction: async (tx: TransactionRequest): Promise<TransactionResponse> => {
        captured.push(tx);
        return {
          hash: '0xdeadbeef',
          wait: async () => ({ hash: '0xdeadbeef' }),
        } as unknown as TransactionResponse;
      },
    } as unknown as AbstractSigner;

    const hash = await client.exec(
      fakeSigner,
      ABI as unknown as InterfaceAbi,
      'transfer',
      '0x' + '01'.repeat(20),
      100n,
    );

    expect(hash).toBe('0xdeadbeef');
    expect(captured.length).toBe(1);
    const sent = captured[0]!;
    // 100,000 * 130 / 100 = 130,000
    expect(sent.gasLimit).toBe(130_000n);
    expect(sent.nonce).toBe(42);
    expect(typeof sent.data).toBe('string');
    expect(sent.to?.toString().toLowerCase()).toBe('0x' + 'aa'.repeat(20));
  });

  it('rolls back the nonce cursor when estimateGas reverts', async () => {
    const client = new TestEvmClient();
    vi.spyOn(client.provider, 'getTransactionCount').mockResolvedValue(7);

    const fakeSigner = {
      provider: client.provider,
      getAddress: async () => '0x' + 'cc'.repeat(20),
      connect() { return fakeSigner; },
      estimateGas: async () => { throw new Error('execution reverted: not allowed'); },
      sendTransaction: async () => { throw new Error('should not be reached'); },
    } as unknown as AbstractSigner;

    await expect(
      client.exec(fakeSigner, ABI as unknown as InterfaceAbi, 'transfer', '0x' + '02'.repeat(20), 1n),
    ).rejects.toThrow(/execution reverted/);

    // Cursor was wiped so the next attempt re-reads pending nonce.
    expect(client.nonceCursor.has('0x' + 'cc'.repeat(20))).toBe(false);
  });
});

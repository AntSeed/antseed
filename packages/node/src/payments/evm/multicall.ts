import { Contract, Interface, type AbstractProvider } from 'ethers';

/** Canonical Multicall3 deployment (same address on Base, Base Sepolia, and most EVM chains). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
] as const;

export interface MulticallRequest {
  target: string;
  iface: Interface;
  method: string;
  args?: unknown[];
}

/**
 * Batch many read calls into a few `eth_call`s via Multicall3 (`allowFailure`
 * per call: a reverting read yields `null` instead of failing the batch).
 * Falls back to individual calls when the chain has no Multicall3.
 */
export async function multicallRead(
  provider: AbstractProvider,
  requests: MulticallRequest[],
  options: { chunkSize?: number; concurrency?: number; address?: string; blockTag?: number | string } = {},
): Promise<Array<unknown[] | null>> {
  if (requests.length === 0) return [];
  const chunkSize = options.chunkSize ?? 80;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const multicall = new Contract(options.address ?? MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  const results: Array<unknown[] | null> = new Array(requests.length).fill(null);
  const code = await provider.getCode(options.address ?? MULTICALL3_ADDRESS).catch(() => '0x');
  if (code === '0x') {
    await Promise.all(requests.map(async (request, index) => {
      try {
        const data = await provider.call({ to: request.target, data: request.iface.encodeFunctionData(request.method, request.args ?? []), ...(options.blockTag !== undefined ? { blockTag: options.blockTag } : {}) });
        results[index] = [...request.iface.decodeFunctionResult(request.method, data)];
      } catch {
        results[index] = null;
      }
    }));
    return results;
  }
  const overrides = options.blockTag !== undefined ? { blockTag: options.blockTag } : {};
  // A chunk that fails as a whole (RPC timeout, gas cap) is split and retried;
  // a single call that still fails yields null like a reverting read.
  const run = async (offset: number, size: number): Promise<void> => {
    const chunk = requests.slice(offset, offset + size);
    if (chunk.length === 0) return;
    const calls = chunk.map((request) => ({ target: request.target, allowFailure: true, callData: request.iface.encodeFunctionData(request.method, request.args ?? []) }));
    let returned: Array<{ success: boolean; returnData: string }>;
    try {
      returned = await multicall.getFunction('aggregate3').staticCall(calls, overrides) as Array<{ success: boolean; returnData: string }>;
    } catch (error) {
      if (chunk.length === 1) return;
      const half = Math.ceil(chunk.length / 2);
      await run(offset, half);
      await run(offset + half, chunk.length - half);
      return;
    }
    returned.forEach((entry, index) => {
      const request = chunk[index]!;
      if (!entry.success || entry.returnData === '0x') return;
      try {
        results[offset + index] = [...request.iface.decodeFunctionResult(request.method, entry.returnData)];
      } catch {
        results[offset + index] = null;
      }
    });
  };
  // Chunks run a few at a time: sequential batches made a 3,000-read view
  // take ~13 s through a public RPC, while a full fan-out trips rate limits.
  const offsets = Array.from({ length: Math.ceil(requests.length / chunkSize) }, (_, index) => index * chunkSize);
  await Promise.all(Array.from({ length: Math.min(concurrency, offsets.length) }, async () => {
    for (let next = offsets.shift(); next !== undefined; next = offsets.shift()) await run(next, chunkSize);
  }));
  return results;
}

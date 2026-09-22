import { id as eventId, type TransactionReceipt } from 'ethers';

/** The highest block (and time) at which this wallet confirmed a position change; indexed reads older than it are rejected. */
export interface PositionReadBarrier { block: number; at: number; }

const POSITION_TRANSFER_TOPIC = eventId('Transfer(address,address,uint256)');

export function parsePositionBarrier(value: unknown): PositionReadBarrier {
  const barrier = value as PositionReadBarrier | null;
  if (!barrier || !Number.isSafeInteger(barrier.block) || barrier.block < 0 || !Number.isSafeInteger(barrier.at) || barrier.at < 0) throw new Error('Invalid saved position checkpoint');
  return { block: barrier.block, at: barrier.at };
}

export function mergePositionBarrier(previous: PositionReadBarrier | undefined, block: number, at = Math.floor(Date.now() / 1000)): PositionReadBarrier {
  const next = parsePositionBarrier({ block, at });
  return { block: Math.max(previous?.block ?? 0, next.block), at: Math.max(previous?.at ?? 0, next.at) };
}

/** Position (lANTS token) ids minted or moved in a receipt, from the pool contract's ERC-721 Transfer logs. */
export function positionIdsInReceipt(receipt: TransactionReceipt, sellerPoolsAddress: string | undefined): number[] {
  const pools = sellerPoolsAddress?.toLowerCase();
  const ids = receipt.logs
    .filter((log) => log.address.toLowerCase() === pools && log.topics.length === 4 && log.topics[0] === POSITION_TRANSFER_TOPIC)
    .map((log) => Number(BigInt(log.topics[3]!)));
  return [...new Set(ids)];
}

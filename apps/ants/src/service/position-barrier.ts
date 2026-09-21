export interface PositionReadBarrier { block: number; at: number; }

export function parsePositionBarrier(value: unknown): PositionReadBarrier {
  const barrier = value as PositionReadBarrier | null;
  if (!barrier || !Number.isSafeInteger(barrier.block) || barrier.block < 0 || !Number.isSafeInteger(barrier.at) || barrier.at < 0) throw new Error('Invalid saved position checkpoint');
  return { block: barrier.block, at: barrier.at };
}

export function mergePositionBarrier(previous: PositionReadBarrier | undefined, block: number, at = Math.floor(Date.now() / 1000)): PositionReadBarrier {
  const next = parsePositionBarrier({ block, at });
  return { block: Math.max(previous?.block ?? 0, next.block), at: Math.max(previous?.at ?? 0, next.at) };
}

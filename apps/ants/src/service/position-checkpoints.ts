import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAddress, type TransactionReceipt } from 'ethers';
import type { AntsContext } from './context.js';
import { mergePositionBarrier, parsePositionBarrier } from './position-barrier.js';

function checkpointPath(ctx: AntsContext, dataDir: string): string {
  return path.join(dataDir, 'ants-activity', `${ctx.chain.evmChainId}-position-checkpoints.json`);
}

export async function loadPositionCheckpoints(ctx: AntsContext, dataDir: string): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(checkpointPath(ctx, dataDir), 'utf8')) as Array<[string, unknown]>;
    for (const [wallet, barrier] of saved) {
      const address = getAddress(wallet).toLowerCase();
      const parsed = parsePositionBarrier(barrier);
      ctx.positionReadBarriers.set(address, mergePositionBarrier(ctx.positionReadBarriers.get(address), parsed.block, parsed.at));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read local position checkpoints.', { cause: error });
  }
}

export async function recordPositionCheckpoint(ctx: AntsContext, dataDir: string, receipt: TransactionReceipt): Promise<void> {
  if (receipt.status !== 1) return;
  await loadPositionCheckpoints(ctx, dataDir);
  const wallet = receipt.from.toLowerCase();
  ctx.positionReadBarriers.set(wallet, mergePositionBarrier(ctx.positionReadBarriers.get(wallet), receipt.blockNumber));
  const destination = checkpointPath(ctx, dataDir);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify([...ctx.positionReadBarriers]), { mode: 0o600 });
  await rename(temporary, destination);
}

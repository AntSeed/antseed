import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './artifacts.mjs';
import { sourceCommit } from './exec.mjs';

/**
 * Takes an exclusive per-migration, per-network lock for the duration of a broadcast.
 * Returns a release function; callers must invoke it in a `finally` block.
 */
export async function acquireMigrationLock(context, migrationId) {
  const slug = `${migrationId.toLowerCase()}-${context.network}`;
  const locksRoot = path.join(context.outputRoot, '.deployments');
  const lockDirectory = path.join(locksRoot, `${slug}.lock`);
  await mkdir(locksRoot, { recursive: true });
  try {
    await mkdir(lockDirectory, { recursive: false });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(
      `Another ${migrationId} broadcast may be running (${lockDirectory}). `
      + 'Remove the lock only after verifying no deployment is active.',
    );
  }
  try {
    await writeJsonAtomic(path.join(lockDirectory, 'owner.json'), {
      pid: process.pid,
      host: process.env.HOSTNAME ?? null,
      startedAt: new Date().toISOString(),
      sourceCommit: sourceCommit(),
    });
  } catch (error) {
    await rm(lockDirectory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(lockDirectory, { recursive: true, force: true });
}

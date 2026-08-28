import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cast } from './chain.mjs';

/**
 * Generic primitives for a guarded pause window.
 *
 * A migration that must stop traffic while it mutates live state pauses a
 * contract, does the work, verifies the end state, and only then unpauses.
 * This module owns the parts of that pattern that are the same for every
 * migration: who is allowed to unpause, when to pause relative to a deadline,
 * and how to record the receipts. Which contract gets paused, what "verified"
 * means, and which script performs the work are migration-specific and belong
 * to the migration.
 */

/** Splits a deadline into the moment to pause and the moment to act. */
export function pauseWindow({ boundary, leadSeconds }) {
  if (!Number.isFinite(boundary) || !Number.isFinite(leadSeconds) || leadSeconds < 0) {
    throw new Error('pauseWindow requires a finite boundary and non-negative leadSeconds');
  }
  return { target: boundary, pauseAt: boundary - leadSeconds };
}

/**
 * Decides what to do about the pause, given live state.
 * `adopt` resumes a pause this migration previously took and can prove;
 * `foreign` means somebody else paused the contract, so we must not unpause it.
 */
export function pauseDecision({ simulation, isPaused, canAdopt }) {
  if (simulation) return 'skip-simulation';
  if (!isPaused) return 'pause';
  return canAdopt ? 'adopt' : 'foreign';
}

/** We own the unpause only if we took (or provably adopted) the pause. */
export function ownsPause(decision) {
  return decision === 'pause' || decision === 'adopt';
}

/** Never unpause on an unverified end state: that is the whole safety property. */
export function shouldResume({ pauseOwned, endStateVerified }) {
  return pauseOwned && endStateVerified;
}

export function recoveryInstructions({ resourceLabel, recoveryCommand }) {
  if (!resourceLabel || !recoveryCommand) {
    throw new Error('recoveryInstructions requires resourceLabel and recoveryCommand');
  }
  return [
    '',
    `!! ${resourceLabel} REMAINS PAUSED: the change did not reach its verified end state.`,
    '!! Fix the failure and rerun the migration - the phase is idempotent and',
    '!! finishes whatever is left.',
    '!! To recover manually instead:',
    `!!   ${recoveryCommand}`,
  ].join('\n');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(timestamp, now = () => Math.floor(Date.now() / 1000)) {
  while (now() < timestamp) {
    const remaining = timestamp - now();
    await sleep(Math.min(remaining + 1, 300) * 1000);
  }
}

export async function sendAndRecord({ rpcUrl, contract, signature, privateKey, receiptFile }) {
  const output = cast(rpcUrl, ['send', contract, signature, '--private-key', privateKey, '--json']);
  if (receiptFile) {
    await mkdir(path.dirname(receiptFile), { recursive: true });
    await writeFile(receiptFile, output);
  }
}

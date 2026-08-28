import { cp } from 'node:fs/promises';
import path from 'node:path';
import { CANONICAL_DEPLOYMENTS_ROOT } from './paths.mjs';
import { run, sourceCommit } from './exec.mjs';
import { fileExists, readJson } from './fsx.mjs';
import { rpcEnvName } from './env.mjs';
import { writeJsonAtomic, writeJsonOnce } from './artifacts.mjs';

/**
 * Resolves everything a migration phase needs: the canonical baseline, the
 * writable output root, the RPC endpoint, and the checkpoint location.
 */
export async function loadContext(migration, network, overrides = {}) {
  const canonicalRoot = CANONICAL_DEPLOYMENTS_ROOT;
  const outputRoot = overrides.outputRoot ?? process.env.CONTRACT_DEPLOYMENTS_ROOT ?? canonicalRoot;
  if (outputRoot !== canonicalRoot && !(await fileExists(path.join(outputRoot, network, 'current.json')))) {
    await cp(canonicalRoot, outputRoot, { recursive: true });
  }
  const canonical = await readJson(path.join(canonicalRoot, network, 'current.json'));
  migration.validateBaseline?.(canonical);
  const rpcUrl = overrides.rpcUrl ?? process.env[rpcEnvName(network)];
  if (!rpcUrl) throw new Error(`${rpcEnvName(network)} is required`);
  const slug = `${migration.id.toLowerCase()}-${network}`;
  return {
    migrationId: migration.id,
    network,
    rpcUrl,
    outputRoot,
    canonicalRoot,
    canonical,
    expected: migration.expectedState(canonical),
    checkpointFile: path.join(outputRoot, '.deployments', `${slug}.json`),
    receiptDirectory: path.join(outputRoot, '.deployments', `${slug}-receipts`),
    forkTest: overrides.forkTest ?? false,
  };
}

export function networkRoot(context) {
  return path.join(context.outputRoot, context.network);
}

export function historyFile(context, release) {
  return path.join(networkRoot(context), 'history', `${release}.json`);
}

export function currentFile(context) {
  return path.join(networkRoot(context), 'current.json');
}

export async function readCheckpoint(context) {
  if (!(await fileExists(context.checkpointFile))) return null;
  return readJson(context.checkpointFile);
}

export async function writeCheckpoint(context, checkpoint) {
  await writeJsonAtomic(context.checkpointFile, checkpoint);
}

/** History records are append-only: writing the same release twice is refused. */
export async function writeHistoryRecord(context, release, record) {
  await writeJsonOnce(historyFile(context, release), record);
}

export async function writeCurrent(context, current) {
  await writeJsonAtomic(currentFile(context), current);
}

export async function historyRecordExists(context, release) {
  return fileExists(historyFile(context, release));
}

/**
 * History and `current.json` are separate files written in sequence, so a crash
 * between them leaves the pointer stale. Callers reconcile each independently
 * rather than treating either one as proof the other landed.
 */
export async function currentRelease(context) {
  const file = currentFile(context);
  if (!(await fileExists(file))) return null;
  return (await readJson(file)).release ?? null;
}

/** Regenerates derived config and re-runs the ledger validator against the output root. */
export function validateArtifacts(context) {
  const env = { CONTRACT_DEPLOYMENTS_ROOT: context.outputRoot };
  if (context.outputRoot === context.canonicalRoot) {
    run('node', ['scripts/generate-contract-chain-config.mjs'], { env });
  }
  run('node', ['scripts/validate-contract-deployments.mjs'], { env });
}

export function assertCheckpointSourceCommit(context, checkpoint) {
  const currentCommit = sourceCommit();
  if (currentCommit !== checkpoint.sourceCommit) {
    throw new Error(
      `${context.migrationId} was deployed from ${checkpoint.sourceCommit}, but the current commit is ${currentCommit}. `
      + 'Check out the deployment commit before broadcasting or recovering a later migration phase.',
    );
  }
}

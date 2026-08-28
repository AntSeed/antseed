#!/usr/bin/env node

/**
 * Proves that the code running on chain is the code in this repository.
 *
 * `runtimeCodeHash` in the deployment ledger is only meaningful if something
 * checks it. This compares, for every contract a release claims to have
 * deployed, the keccak256 of the artifact produced by a local `forge build`
 * against the hash recorded in the ledger — and, when an RPC endpoint is
 * available, against the code actually deployed at that address.
 *
 * Reproducibility depends on `bytecode_hash = "none"` and `cbor_metadata =
 * false` in packages/contracts/foundry.toml; with the default settings the
 * embedded metadata digest varies by machine and this check cannot pass.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACTS_ROOT } from './deployments/runtime/paths.mjs';
import { capture } from './deployments/runtime/exec.mjs';
import { cast, sameAddress } from './deployments/runtime/chain.mjs';
import { fileExists, readJson } from './deployments/runtime/fsx.mjs';
import { rpcEnvName } from './deployments/runtime/env.mjs';

const deploymentsRoot = process.env.CONTRACT_DEPLOYMENTS_ROOT
  ? path.resolve(process.env.CONTRACT_DEPLOYMENTS_ROOT)
  : path.join(CONTRACTS_ROOT, 'deployments');
const artifactsRoot = path.join(CONTRACTS_ROOT, 'out');

/** Ledger keys are camelCase; Solidity artifacts are PascalCase file names. */
async function buildArtifactIndex() {
  const index = new Map();
  for (const entry of await readdir(artifactsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.sol')) continue;
    for (const file of await readdir(path.join(artifactsRoot, entry.name))) {
      if (!file.endsWith('.json')) continue;
      index.set(file.replace(/\.json$/, ''), path.join(artifactsRoot, entry.name, file));
    }
  }
  return index;
}

function candidateNames(ledgerKey) {
  const pascal = ledgerKey.charAt(0).toUpperCase() + ledgerKey.slice(1);
  return [`Antseed${pascal}`, pascal, ledgerKey];
}

async function localRuntimeHash(index, ledgerKey) {
  for (const name of candidateNames(ledgerKey)) {
    const file = index.get(name);
    if (!file) continue;
    const artifact = await readJson(file);
    const object = artifact.deployedBytecode?.object;
    if (!object || object === '0x') continue;
    return { name, hash: capture('cast', ['keccak', object]) };
  }
  return null;
}

async function verifyRecord(file, rpcUrl) {
  const record = await readJson(file);
  const results = [];
  for (const [key, contract] of Object.entries(record.contracts ?? {})) {
    if (contract.deployedInRelease !== true || !contract.runtimeCodeHash) continue;

    const local = await localRuntimeHash(artifactIndex, key);
    if (!local) {
      results.push({ key, status: 'skipped', detail: 'no matching local artifact' });
      continue;
    }
    if (!sameAddress(local.hash, contract.runtimeCodeHash)) {
      results.push({
        key,
        status: 'failed',
        detail: `local ${local.name} runtime hash ${local.hash} != ledger ${contract.runtimeCodeHash}`,
      });
      continue;
    }
    if (rpcUrl) {
      const onChain = cast(rpcUrl, ['codehash', contract.address]);
      if (!sameAddress(onChain, contract.runtimeCodeHash)) {
        results.push({ key, status: 'failed', detail: `on-chain ${onChain} != ledger ${contract.runtimeCodeHash}` });
        continue;
      }
      results.push({ key, status: 'verified', detail: `matches local build and ${contract.address}` });
      continue;
    }
    results.push({ key, status: 'verified', detail: 'matches local build (no RPC; on-chain check skipped)' });
  }
  return { record, results };
}

const artifactIndex = await buildArtifactIndex();
if (artifactIndex.size === 0) {
  throw new Error('No Foundry artifacts found; run `forge build` in packages/contracts first');
}

const networks = (await readdir(deploymentsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort();

let failures = 0;
let checked = 0;

for (const network of networks) {
  const rpcUrl = process.env[rpcEnvName(network)] ?? null;
  const historyDirectory = path.join(deploymentsRoot, network, 'history');
  if (!(await fileExists(historyDirectory))) continue;

  for (const historyFile of (await readdir(historyDirectory)).filter((file) => file.endsWith('.json')).sort()) {
    const file = path.join(historyDirectory, historyFile);
    const { results } = await verifyRecord(file, rpcUrl);
    for (const result of results) {
      checked += 1;
      if (result.status === 'failed') failures += 1;
      const label = { verified: 'ok', skipped: '--', failed: 'FAIL' }[result.status];
      console.log(`[${label}] ${network}/${historyFile} ${result.key}: ${result.detail}`);
    }
  }
}

if (failures > 0) {
  throw new Error(`${failures} contract(s) do not match their recorded runtime code`);
}
console.log(checked === 0
  ? 'No deployed-in-release contracts recorded yet; nothing to verify.'
  : `Verified runtime code for ${checked} contract(s).`);

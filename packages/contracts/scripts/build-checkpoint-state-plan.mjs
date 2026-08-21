#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { AbiCoder, Interface, getAddress, sha256 } from "ethers";
import { statePlanDigest, validateStatePlan } from "./state-plan.mjs";

const JOURNAL = "tuple(tuple(uint256 id,bytes32 digest,bytes32 configID) ethereumCommitment,uint64 chainId,address anchorStateRegistry,address game,uint8 intermediateRootIndex,uint64 checkpointBlockNumber,bytes32 checkpointBlockHash,bytes32 outputRoot,tuple(uint64 number,bytes32 blockHash)[] canonicalBlocks)";
const TRANSACTIONS = new Interface([
  "function archiveBeaconRoot(uint256 ethereumTimestamp)",
  "function submitCheckpoint(bytes seal,bytes journalData)",
]);
const CHECKS = new Interface([
  "function archivedBeaconRoots(uint256 ethereumTimestamp) view returns (bytes32)",
  "function consumedJournalDigests(bytes32 journalDigest) view returns (bool)",
  "function canonicalBlockHashes(uint64 blockNumber) view returns (bytes32)",
]);
const TRUE = AbiCoder.defaultAbiCoder().encode(["bool"], [true]);

export async function buildCheckpointStatePlan({ manifest, oracle, loadArtifact }) {
  if (manifest?.version !== 1 || manifest?.kind !== "antseed-checkpoint-proof-artifacts" || manifest.chainId !== 8_453
      || !Array.isArray(manifest.proofs) || manifest.proofs.length === 0 || manifest.proofs.some((proof) => proof?.status !== "proven")) {
    throw new Error("checkpoint artifact manifest is incomplete");
  }
  const decoded = [];
  for (const proof of manifest.proofs) {
    const journalFile = await loadArtifact(proof.journalFile);
    const sealFile = await loadArtifact(proof.sealFile);
    if (fileSha256(journalFile) !== proof.journalSha256 || fileSha256(sealFile) !== proof.sealSha256) throw new Error(`checkpoint artifact ${proof.index} digest mismatch`);
    const journalBytes = hexText(journalFile, `checkpoint ${proof.index} journal`);
    const seal = hexText(sealFile, `checkpoint ${proof.index} seal`);
    const journal = AbiCoder.defaultAbiCoder().decode([JOURNAL], journalBytes)[0];
    if (journal.chainId !== 8_453n || journal.checkpointBlockNumber !== BigInt(proof.checkpointBlockNumber)) throw new Error(`checkpoint artifact ${proof.index} journal identity mismatch`);
    decoded.push({ proof, journal, journalBytes, seal });
  }

  const entries = [];
  const commitments = new Map();
  for (const item of decoded) {
    const timestamp = item.journal.ethereumCommitment.id & ((1n << 64n) - 1n);
    const digest = item.journal.ethereumCommitment.digest.toLowerCase();
    const existing = commitments.get(timestamp.toString());
    if (existing && existing !== digest) throw new Error(`checkpoint commitments disagree at timestamp ${timestamp}`);
    commitments.set(timestamp.toString(), digest);
  }
  for (const [timestamp, digest] of [...commitments.entries()].sort((left, right) => Number(BigInt(left[0]) - BigInt(right[0])))) {
    entries.push({
      id: `checkpoint:archive:${timestamp}`,
      order: entries.length,
      purpose: `archive Ethereum beacon root at ${timestamp}`,
      to: getAddress(oracle),
      value: "0x0",
      data: TRANSACTIONS.encodeFunctionData("archiveBeaconRoot", [timestamp]),
      checks: [{
        to: getAddress(oracle),
        data: CHECKS.encodeFunctionData("archivedBeaconRoots", [timestamp]),
        expected: AbiCoder.defaultAbiCoder().encode(["bytes32"], [digest]),
      }],
    });
  }
  for (const { proof, journal, journalBytes, seal } of decoded) {
    entries.push({
      id: `checkpoint:submit:${proof.checkpointBlockNumber}`,
      order: entries.length,
      purpose: `submit checkpoint ${proof.checkpointBlockNumber}`,
      to: getAddress(oracle),
      value: "0x0",
      data: TRANSACTIONS.encodeFunctionData("submitCheckpoint", [seal, journalBytes]),
      checks: [
        {
          to: getAddress(oracle),
          data: CHECKS.encodeFunctionData("consumedJournalDigests", [sha256(journalBytes)]),
          expected: TRUE,
        },
        ...journal.canonicalBlocks.map((block) => ({
          to: getAddress(oracle),
          data: CHECKS.encodeFunctionData("canonicalBlockHashes", [block.number]),
          expected: AbiCoder.defaultAbiCoder().encode(["bytes32"], [block.blockHash]),
        })),
      ],
    });
  }
  const plan = { version: 1, kind: "antseed-base-state-plan", chainId: 8_453, oracle: getAddress(oracle), entries };
  validateStatePlan(plan);
  return plan;
}

function hexText(bytes, label) {
  const value = Buffer.from(bytes).toString("utf8").trim();
  if (!/^0x[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) throw new Error(`${label} is invalid hex`);
  return value;
}

function fileSha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const manifestPath = value("--manifest");
  const artifactDir = value("--artifact-dir");
  const oracle = value("--oracle");
  const out = value("--out");
  if (!manifestPath || !artifactDir || !oracle || !out) throw new Error("usage: build-checkpoint-state-plan.mjs --manifest manifest.json --artifact-dir DIR --oracle 0x... --out plan.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = await buildCheckpointStatePlan({ manifest, oracle, loadArtifact: (file) => readFile(join(artifactDir, file)) });
  await writeFile(out, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`statePlanDigest ${statePlanDigest(plan)}`);
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

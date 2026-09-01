#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { getAddress } from "ethers";
import {
  BASE_CHAIN_ID,
  DEFAULT_BLOCKHASH_STORE,
  JsonRpcClient,
  clusterBlockNumbers,
  findNextStoredBlock,
  loadProductionArtifacts,
  mapWithConcurrency,
  mergeBackfillRanges,
  parseArguments,
  positiveInteger,
  readStoredBlockhashes,
  stableDigest,
  uniqueBlockReferences,
} from "./wash-trading-blockhash-backfill-lib.mjs";

const { value } = parseArguments(process.argv.slice(2));
const artifactDirectory = value("--artifact-dir");
const rpcUrl = value("--rpc-url") ?? process.env.BASE_RPC_URL;
const outputPath = value("--out");
const blockhashStore = getAddress(value("--blockhash-store") ?? DEFAULT_BLOCKHASH_STORE);
const maximumClusterGap = positiveInteger(value("--maximum-cluster-gap") ?? "512", "maximum cluster gap");
const maximumAnchorSearch = positiveInteger(value("--maximum-anchor-search") ?? "250000", "maximum anchor search");
const anchorConcurrency = positiveInteger(value("--anchor-concurrency") ?? "8", "anchor concurrency");
if (!artifactDirectory || !rpcUrl || !outputPath) {
  throw new Error("usage: plan-wash-trading-blockhash-backfill.mjs --artifact-dir DIR --rpc-url URL --out PLAN.json");
}

const client = new JsonRpcClient(rpcUrl);
const chainId = BigInt(await client.request("eth_chainId", []));
if (chainId !== BASE_CHAIN_ID) throw new Error(`expected Base chain ID ${BASE_CHAIN_ID}, got ${chainId}`);
const artifacts = await loadProductionArtifacts(artifactDirectory);
const references = uniqueBlockReferences(artifacts);
const numbers = references.map((reference) => reference.number);
process.stderr.write(`checking ${numbers.length} unique required block hashes\n`);
const stored = await readStoredBlockhashes(client, blockhashStore, numbers, (completed, total) => {
  if (completed === total || completed % 20_000 < client.batchSize) process.stderr.write(`coverage ${completed}/${total}\n`);
});
let present = 0;
let missing = 0;
for (const reference of references) {
  const storedHash = stored.get(reference.number);
  if (storedHash === null) missing += 1;
  else if (storedHash !== reference.blockHash) throw new Error(`stored hash mismatch for Base block ${reference.number}`);
  else present += 1;
}

const missingNumbers = references.filter((reference) => stored.get(reference.number) === null).map((reference) => reference.number);
const clusters = clusterBlockNumbers(missingNumbers, maximumClusterGap);
process.stderr.write(`finding anchors for ${clusters.length} conservative ranges\n`);
let anchorsCompleted = 0;
const anchored = await mapWithConcurrency(clusters, anchorConcurrency, async (cluster) => {
  const anchor = await findNextStoredBlock(client, blockhashStore, cluster.endBlock + 1, maximumAnchorSearch);
  anchorsCompleted += 1;
  if (anchorsCompleted === clusters.length || anchorsCompleted % 25 === 0) {
    process.stderr.write(`anchors ${anchorsCompleted}/${clusters.length}\n`);
  }
  return {
    startBlock: cluster.startBlock,
    endBlock: anchor.number - 1,
    anchorBlock: anchor.number,
    anchorHash: anchor.blockHash,
    requiredReferenceCount: cluster.requiredReferenceCount,
  };
});
const ranges = mergeBackfillRanges(anchored).map((range, index) => ({
  index,
  ...range,
  blockCount: range.endBlock - range.startBlock + 1,
}));
const planWithoutDigest = {
  version: 1,
  kind: "antseed-wash-trading-blockhash-backfill-plan",
  chainId: Number(BASE_CHAIN_ID),
  blockhashStore,
  artifacts: {
    sellerProofCount: artifacts.length,
    uniqueRequiredBlockCount: references.length,
    minimumRequiredBlock: numbers[0],
    maximumRequiredBlock: numbers.at(-1),
  },
  liveCoverage: {
    presentRequiredBlockCount: present,
    missingRequiredBlockCount: missing,
  },
  parameters: {
    maximumClusterGap,
    maximumAnchorSearch,
    conservative: true,
  },
  totals: {
    clusterCount: clusters.length,
    mergedRangeCount: ranges.length,
    plannedBlockWriteCount: ranges.reduce((total, range) => total + range.blockCount, 0),
    minimumFreshStorageGas: ranges.reduce((total, range) => total + range.blockCount * 20_000, 0),
  },
  ranges,
};
const plan = { ...planWithoutDigest, digest: stableDigest(planWithoutDigest) };
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(`WASH_TRADING_BLOCKHASH_BACKFILL_PLAN=${JSON.stringify({
  path: outputPath,
  digest: plan.digest,
  ...plan.liveCoverage,
  ...plan.totals,
})}`);

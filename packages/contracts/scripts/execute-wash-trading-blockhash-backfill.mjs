#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  decodeRlp,
  getAddress,
  keccak256,
  solidityPackedKeccak256,
} from "ethers";
import {
  BASE_CHAIN_ID,
  JsonRpcClient,
  buildTargetBitmap,
  normalizeHash,
  parseArguments,
  positiveInteger,
  stableDigest,
} from "./wash-trading-blockhash-backfill-lib.mjs";

const contractsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { value, has } = parseArguments(process.argv.slice(2));
const planPath = value("--plan");
const rpcUrl = value("--rpc-url") ?? "http://127.0.0.1:8545";
const headerRpcUrl = value("--header-rpc-url") ?? rpcUrl;
const checkpointPath = value("--checkpoint") ?? `${planPath}.checkpoint.json`;
const batchSize = positiveInteger(value("--batch-size") ?? "200", "batch size");
const maximumCompleteRanges = positiveInteger(
  value("--maximum-complete-ranges") ?? "64",
  "maximum complete ranges",
);
const headerRpcBatchSize = positiveInteger(
  value("--header-rpc-batch-size") ?? "100",
  "header RPC batch size",
);
const maximumBatches = value("--maximum-batches") === null
  ? Number.POSITIVE_INFINITY
  : positiveInteger(value("--maximum-batches"), "maximum batches");
if (!planPath) throw new Error("usage: execute-wash-trading-blockhash-backfill.mjs --plan PLAN.json --rpc-url URL [--execute]");
if (has("--execute") && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(rpcUrl) && !has("--allow-live")) {
  throw new Error("live backfill requires both --execute and --allow-live");
}

const plan = JSON.parse(await readFile(planPath, "utf8"));
if (plan.version !== 2 || plan.kind !== "antseed-wash-trading-sparse-blockhash-backfill-plan") {
  throw new Error("expected a version 2 sparse blockhash backfill plan");
}
const { digest, ...planWithoutDigest } = plan;
if (digest !== stableDigest(planWithoutDigest)) throw new Error("backfill plan digest mismatch");
const approvedDigest = value("--approve-plan-digest");
if (has("--execute") && approvedDigest !== digest) throw new Error(`execution requires --approve-plan-digest ${digest}`);

const provider = new JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork();
if (network.chainId !== BASE_CHAIN_ID) throw new Error(`expected Base chain ID ${BASE_CHAIN_ID}, got ${network.chainId}`);
const headerRpc = new JsonRpcClient(headerRpcUrl, { batchSize: headerRpcBatchSize, concurrency: 1, retries: 20 });
const chainlinkStore = new Contract(
  plan.chainlinkBlockhashStore,
  ["function getBlockhash(uint256) view returns (bytes32)"],
  provider,
);
const signer = new Wallet(
  process.env.BACKFILL_PRIVATE_KEY ?? process.env.ANVIL_PRIVATE_KEY
    ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider,
);
let nonce = await provider.getTransactionCount(signer.address, "pending");
const existingCheckpoint = await readCheckpoint();
const sparseStoreAddress = value("--sparse-store")
  ? getAddress(value("--sparse-store"))
  : existingCheckpoint?.sparseStore ?? await deploySparseStore();
const sparseStore = new Contract(
  sparseStoreAddress,
  [
    "function getBlockhash(uint256) view returns (bytes32)",
    "function frontiers(bytes32) view returns (uint64 anchorBlock,uint64 nextHeaderBlock,bytes32 expectedHeaderHash)",
    "function verifyHeaderBatch(bytes32,uint64,bytes[],bytes)",
    "function verifyCompleteHeaderBatches((uint64 anchorBlock,bytes[] descendingHeaders,bytes storeBitmap)[] batches)",
  ],
  signer,
);
const checkpoint = existingCheckpoint ?? {
  version: 2,
  planDigest: digest,
  sparseStore: sparseStoreAddress,
  cursors: {},
  completedRanges: {},
};
checkpoint.completedRanges ??= {};
if (checkpoint.planDigest !== digest || checkpoint.sparseStore !== sparseStoreAddress) {
  throw new Error("backfill checkpoint configuration mismatch");
}
let submittedBatches = 0;
let submittedBlocks = 0;
let totalGasUsed = 0n;

const orderedRanges = [...plan.ranges].sort((left, right) => right.endBlock - left.endBlock);
for (let rangeCursor = 0; rangeCursor < orderedRanges.length;) {
  const range = orderedRanges[rangeCursor];
  if (checkpoint.completedRanges[String(range.index)]) {
    rangeCursor += 1;
    continue;
  }
  const rangeBlockCount = range.endBlock - range.startBlock + 1;
  if (checkpoint.cursors[String(range.index)] === undefined && rangeBlockCount <= batchSize) {
    const completeRanges = [];
    let completeHeaderCount = 0;
    while (rangeCursor + completeRanges.length < orderedRanges.length && completeRanges.length < maximumCompleteRanges) {
      const candidate = orderedRanges[rangeCursor + completeRanges.length];
      const candidateBlockCount = candidate.endBlock - candidate.startBlock + 1;
      if (
        checkpoint.completedRanges[String(candidate.index)]
        || checkpoint.cursors[String(candidate.index)] !== undefined
        || candidateBlockCount > batchSize
        || completeHeaderCount + candidateBlockCount > batchSize
      ) break;
      completeRanges.push(candidate);
      completeHeaderCount += candidateBlockCount;
    }
    const prepared = await prepareCompleteRanges(completeRanges);
    if (!has("--execute")) {
      console.error(`dry run complete ranges=${completeRanges.length} headers=${completeHeaderCount}`);
      process.exit(0);
    }
    const receipt = await (await sparseStore.verifyCompleteHeaderBatches(
      prepared.map((item) => ({
        anchorBlock: item.range.anchorBlock,
        descendingHeaders: item.headers,
        storeBitmap: item.bitmap,
      })),
      { nonce: nonce++ },
    )).wait();
    totalGasUsed += receipt.gasUsed;
    submittedBatches += 1;
    submittedBlocks += completeHeaderCount;
    await verifyStoredTargets(prepared.flatMap((item) => item.targets));
    for (const completedRange of completeRanges) checkpoint.completedRanges[String(completedRange.index)] = true;
    checkpoint.submittedBlocks = (checkpoint.submittedBlocks ?? 0) + completeHeaderCount;
    checkpoint.submittedBatches = (checkpoint.submittedBatches ?? 0) + 1;
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    console.error(
      `backfilled complete ranges=${completeRanges.length} headers=${completeHeaderCount} gas=${receipt.gasUsed}`,
    );
    rangeCursor += completeRanges.length;
    if (submittedBatches >= maximumBatches) break;
    continue;
  }

  let cursor = checkpoint.cursors[String(range.index)] ?? range.endBlock;
  const liveAnchor = normalizeHash(await chainlinkStore.getBlockhash(range.anchorBlock));
  if (liveAnchor !== normalizeHash(range.anchorHash)) throw new Error(`range ${range.index}: anchor changed`);
  const sessionId = solidityPackedKeccak256(["bytes32", "uint256"], [digest, range.index]);
  const requiredReferences = new Map(range.requiredReferences.map((reference) => [reference.number, reference.blockHash]));
  while (cursor >= range.startBlock && submittedBatches < maximumBatches) {
    const batchStart = Math.max(range.startBlock, cursor - batchSize + 1);
    const blockNumbers = Array.from({ length: cursor - batchStart + 1 }, (_, index) => cursor - index);
    const headers = await rawHeaders(headerRpc, blockNumbers.map((number) => number + 1));
    let expectedChildHash = liveAnchor;
    if (cursor !== range.endBlock) {
      const frontier = await sparseStore.frontiers(sessionId);
      if (Number(frontier.nextHeaderBlock) !== cursor + 1) {
        throw new Error(`range ${range.index}: sparse frontier does not match checkpoint cursor`);
      }
      expectedChildHash = normalizeHash(frontier.expectedHeaderHash);
    }
    let finalParentHash;
    for (let index = 0; index < blockNumbers.length; ++index) {
      const headerHash = normalizeHash(keccak256(headers[index]));
      if (headerHash !== expectedChildHash) {
        throw new Error(`block ${blockNumbers[index] + 1}: raw header does not match stored child hash`);
      }
      const decoded = decodeRlp(headers[index]);
      if (!Array.isArray(decoded) || typeof decoded[0] !== "string") throw new Error("invalid RLP block header");
      finalParentHash = normalizeHash(decoded[0]);
      expectedChildHash = finalParentHash;
    }
    const { bitmap, targets } = buildTargetBitmap(blockNumbers, requiredReferences);
    if (!has("--execute")) {
      console.error(`dry run range=${range.index} blocks=${cursor}-${batchStart} targets=${targets.length}`);
      process.exit(0);
    }
    const receipt = await (await sparseStore.verifyHeaderBatch(
      sessionId,
      range.anchorBlock,
      headers,
      bitmap,
      { nonce: nonce++ },
    )).wait();
    totalGasUsed += receipt.gasUsed;
    submittedBatches += 1;
    submittedBlocks += blockNumbers.length;
    await verifyStoredTargets(targets);
    cursor = batchStart - 1;
    checkpoint.cursors[String(range.index)] = cursor;
    checkpoint.submittedBlocks = (checkpoint.submittedBlocks ?? 0) + blockNumbers.length;
    checkpoint.submittedBatches = (checkpoint.submittedBatches ?? 0) + 1;
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    console.error(
      `backfilled range=${range.index} through block=${batchStart} targets=${targets.length} gas=${receipt.gasUsed}`,
    );
  }
  if (submittedBatches >= maximumBatches) break;
  rangeCursor += 1;
}

console.log(`WASH_TRADING_BLOCKHASH_BACKFILL_RESULT=${JSON.stringify({
  planDigest: digest,
  sparseStore: sparseStoreAddress,
  submittedBatches,
  submittedBlocks,
  totalGasUsed: totalGasUsed.toString(),
  checkpoint: checkpointPath,
})}`);

async function deploySparseStore() {
  if (!has("--execute")) return "0x0000000000000000000000000000000000000001";
  const artifact = JSON.parse(await readFile(
    resolve(contractsDirectory, "out/AntseedSparseBlockhashStore.sol/AntseedSparseBlockhashStore.json"),
    "utf8",
  ));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const deployed = await factory.deploy(plan.chainlinkBlockhashStore, { nonce: nonce++ });
  await deployed.waitForDeployment();
  return deployed.getAddress();
}

async function rawHeaders(client, blockNumbers) {
  const headers = new Array(blockNumbers.length);
  await client.mapBatches(
    blockNumbers,
    (number) => ({
      method: "debug_getRawHeader",
      params: [`0x${number.toString(16)}`],
    }),
    async (batch, results, batchIndex) => {
      const offset = batchIndex * client.batchSize;
      for (let index = 0; index < batch.length; ++index) {
        const result = results[index];
        const blockNumber = batch[index];
        if (result.error) throw new Error(`debug_getRawHeader(${blockNumber}): ${result.error.message}`);
        if (!/^0x[0-9a-f]+$/i.test(result.result)) throw new Error(`invalid raw header for block ${blockNumber}`);
        headers[offset + index] = result.result;
      }
    },
  );
  return headers;
}

async function prepareCompleteRanges(ranges) {
  const blockNumberGroups = ranges.map((range) =>
    Array.from({ length: range.endBlock - range.startBlock + 1 }, (_, index) => range.endBlock - index));
  const allBlockNumbers = blockNumberGroups.flat();
  const allHeaders = await rawHeaders(headerRpc, allBlockNumbers.map((number) => number + 1));
  const anchors = await Promise.all(ranges.map((range) => chainlinkStore.getBlockhash(range.anchorBlock)));
  const prepared = [];
  let headerCursor = 0;
  for (let index = 0; index < ranges.length; ++index) {
    const range = ranges[index];
    const blockNumbers = blockNumberGroups[index];
    const headers = allHeaders.slice(headerCursor, headerCursor + blockNumbers.length);
    headerCursor += blockNumbers.length;
    const liveAnchor = normalizeHash(anchors[index]);
    if (liveAnchor !== normalizeHash(range.anchorHash)) throw new Error(`range ${range.index}: anchor changed`);
    validateHeaderChain(headers, blockNumbers, liveAnchor);
    const requiredReferences = new Map(range.requiredReferences.map((reference) => [reference.number, reference.blockHash]));
    const { bitmap, targets } = buildTargetBitmap(blockNumbers, requiredReferences);
    prepared.push({ range, headers, bitmap, targets });
  }
  return prepared;
}

function validateHeaderChain(headers, blockNumbers, firstExpectedHash) {
  let expectedChildHash = firstExpectedHash;
  for (let index = 0; index < blockNumbers.length; ++index) {
    const headerHash = normalizeHash(keccak256(headers[index]));
    if (headerHash !== expectedChildHash) {
      throw new Error(`block ${blockNumbers[index] + 1}: raw header does not match stored child hash`);
    }
    const decoded = decodeRlp(headers[index]);
    if (!Array.isArray(decoded) || typeof decoded[0] !== "string") throw new Error("invalid RLP block header");
    expectedChildHash = normalizeHash(decoded[0]);
  }
}

async function verifyStoredTargets(targets) {
  const storedTargets = await Promise.all(targets.map((target) => sparseStore.getBlockhash(target.number)));
  for (let index = 0; index < targets.length; ++index) {
    if (normalizeHash(storedTargets[index]) !== normalizeHash(targets[index].blockHash)) {
      throw new Error(`block ${targets[index].number}: sparse backfill verification failed`);
    }
  }
}

async function readCheckpoint() {
  try {
    return JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

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
} from "ethers";
import {
  BASE_CHAIN_ID,
  JsonRpcClient,
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
const { digest, ...planWithoutDigest } = plan;
if (digest !== stableDigest(planWithoutDigest)) throw new Error("backfill plan digest mismatch");
const approvedDigest = value("--approve-plan-digest");
if (has("--execute") && approvedDigest !== digest) throw new Error(`execution requires --approve-plan-digest ${digest}`);

const provider = new JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork();
if (network.chainId !== BASE_CHAIN_ID) throw new Error(`expected Base chain ID ${BASE_CHAIN_ID}, got ${network.chainId}`);
const headerRpc = new JsonRpcClient(headerRpcUrl, { batchSize: headerRpcBatchSize, concurrency: 1, retries: 20 });
const store = new Contract(plan.blockhashStore, ["function getBlockhash(uint256) view returns (bytes32)"], provider);
const signer = new Wallet(
  process.env.BACKFILL_PRIVATE_KEY ?? process.env.ANVIL_PRIVATE_KEY
    ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider,
);
let nonce = await provider.getTransactionCount(signer.address, "pending");
const existingCheckpoint = await readCheckpoint();
const batcherAddress = value("--batcher")
  ? getAddress(value("--batcher"))
  : existingCheckpoint?.batcher ?? await deployBatcher();
const batcher = new Contract(
  batcherAddress,
  ["function storeVerifyHeaders(uint256[] blockNumbers,bytes[] headers)"],
  signer,
);
const checkpoint = existingCheckpoint ?? { version: 1, planDigest: digest, batcher: batcherAddress, cursors: {} };
if (checkpoint.planDigest !== digest || checkpoint.batcher !== batcherAddress) {
  throw new Error("backfill checkpoint configuration mismatch");
}
let submittedBatches = 0;
let submittedBlocks = 0;
let totalGasUsed = 0n;

for (const range of [...plan.ranges].sort((left, right) => right.endBlock - left.endBlock)) {
  let cursor = checkpoint.cursors[String(range.index)] ?? range.endBlock;
  const liveAnchor = normalizeHash(await store.getBlockhash(range.anchorBlock));
  if (liveAnchor !== normalizeHash(range.anchorHash)) throw new Error(`range ${range.index}: anchor changed`);
  while (cursor >= range.startBlock && submittedBatches < maximumBatches) {
    const batchStart = Math.max(range.startBlock, cursor - batchSize + 1);
    const blockNumbers = Array.from({ length: cursor - batchStart + 1 }, (_, index) => cursor - index);
    const headers = await rawHeaders(headerRpc, blockNumbers.map((number) => number + 1));
    let expectedChildHash = normalizeHash(await store.getBlockhash(cursor + 1));
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
    if (!has("--execute")) {
      console.error(`dry run range=${range.index} blocks=${cursor}-${batchStart}`);
      process.exit(0);
    }
    const receipt = await (await batcher.storeVerifyHeaders(blockNumbers, headers, { nonce: nonce++ })).wait();
    totalGasUsed += receipt.gasUsed;
    submittedBatches += 1;
    submittedBlocks += blockNumbers.length;
    const storedParent = normalizeHash(await store.getBlockhash(batchStart));
    if (storedParent !== finalParentHash) throw new Error(`block ${batchStart}: backfill verification failed`);
    cursor = batchStart - 1;
    checkpoint.cursors[String(range.index)] = cursor;
    checkpoint.submittedBlocks = (checkpoint.submittedBlocks ?? 0) + blockNumbers.length;
    checkpoint.submittedBatches = (checkpoint.submittedBatches ?? 0) + 1;
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    console.error(`backfilled range=${range.index} through block=${batchStart} gas=${receipt.gasUsed}`);
  }
  if (submittedBatches >= maximumBatches) break;
}

console.log(`WASH_TRADING_BLOCKHASH_BACKFILL_RESULT=${JSON.stringify({
  planDigest: digest,
  batcher: batcherAddress,
  submittedBatches,
  submittedBlocks,
  totalGasUsed: totalGasUsed.toString(),
  checkpoint: checkpointPath,
})}`);

async function deployBatcher() {
  if (!has("--execute")) return "0x0000000000000000000000000000000000000001";
  const artifact = JSON.parse(await readFile(
    resolve(contractsDirectory, "out/AntseedBlockhashStoreBatcher.sol/AntseedBlockhashStoreBatcher.json"),
    "utf8",
  ));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const deployed = await factory.deploy(plan.blockhashStore, { nonce: nonce++ });
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

async function readCheckpoint() {
  try {
    return JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

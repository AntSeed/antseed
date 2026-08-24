#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Contract, JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers";

const BLOCKHASH_STORE_ABI = [
  "function getBlockhash(uint256 blockNumber) view returns (bytes32)",
  "function store(uint256 blockNumber)",
  "function storeVerifyHeader(uint256 blockNumber,bytes header)",
];
const BASE_BLOCKHASH_STORE = "0x78b69899C8cD252126cBB1A50171ec37286C3877";
const USAGE = "usage: backfill-blockhash-store.mjs --manifest proof-results.json --headers headers.json --rpc-url URL (--dry-run|--submit)";

export function collectRequiredBlockRefs(manifest) {
  if (manifest?.version !== 2 || manifest?.kind !== "antseed-wash-trading-proof-results" || !Array.isArray(manifest.entries)) {
    throw new Error("unsupported proof manifest");
  }
  const refs = new Map();
  for (const entry of manifest.entries) {
    if (!Array.isArray(entry.blockReferences)) throw new Error(`${entry.claimId}: block references missing`);
    for (const ref of entry.blockReferences) {
      const number = BigInt(ref.number);
      if (number < 0n || !/^0x[0-9a-f]{64}$/i.test(ref.blockHash ?? "")) throw new Error(`${entry.claimId}: invalid block reference`);
      const key = number.toString();
      const hash = ref.blockHash.toLowerCase();
      if (refs.has(key) && refs.get(key) !== hash) throw new Error(`conflicting hashes for Base block ${key}`);
      refs.set(key, hash);
    }
  }
  return [...refs].map(([number, blockHash]) => ({ number: BigInt(number), blockHash })).sort((left, right) => left.number < right.number ? -1 : 1);
}

export function validateHeaderBundle(headers) {
  if (!Array.isArray(headers) || headers.length === 0) throw new Error("header bundle is empty");
  const byNumber = new Map();
  let previous = null;
  for (const header of headers) {
    const number = BigInt(header.number);
    if (!/^0x[0-9a-f]{64}$/i.test(header.hash ?? "") || !/^0x[0-9a-f]+$/i.test(header.rlp ?? "")) throw new Error(`block ${number}: invalid header export`);
    if (keccak256(header.rlp).toLowerCase() !== header.hash.toLowerCase()) throw new Error(`block ${number}: RLP hash mismatch`);
    if (previous != null && number !== previous + 1n) throw new Error("header bundle must be strictly consecutive");
    if (byNumber.has(number.toString())) throw new Error(`duplicate header ${number}`);
    byNumber.set(number.toString(), { number, hash: header.hash.toLowerCase(), rlp: header.rlp });
    previous = number;
  }
  return byNumber;
}

export function buildBackfillPlan(requiredRefs, headerByNumber, storedNumbers, latestBlock) {
  const missing = requiredRefs.filter((ref) => !storedNumbers.has(ref.number.toString()));
  if (missing.length === 0) return [];
  const plan = [];
  const missingSet = new Set(missing.map((ref) => ref.number.toString()));
  const highestMissing = missing.at(-1).number;
  let anchor = null;
  for (const number of storedNumbers) {
    const candidate = BigInt(number);
    if (candidate > highestMissing && headerByNumber.has(candidate.toString()) && (anchor == null || candidate < anchor)) anchor = candidate;
  }
  if (anchor == null) {
    const recentAnchor = [...headerByNumber.values()]
      .filter((header) => header.number > highestMissing && latestBlock - header.number <= 256n)
      .sort((left, right) => left.number < right.number ? -1 : 1)[0];
    if (!recentAnchor) throw new Error("no stored or recent BlockhashStore anchor above the missing proof blocks");
    anchor = recentAnchor.number;
    plan.push({ method: "store", blockNumber: anchor, expectedHash: recentAnchor.hash });
  }
  const lowestMissing = missing[0].number;
  for (let blockNumber = anchor - 1n; blockNumber >= lowestMissing; blockNumber -= 1n) {
    const childHeader = headerByNumber.get((blockNumber + 1n).toString());
    if (!childHeader) throw new Error(`missing exported child header ${blockNumber + 1n} needed to authenticate block ${blockNumber}`);
    if (!storedNumbers.has(blockNumber.toString())) {
      plan.push({
        method: "storeVerifyHeader",
        blockNumber,
        header: childHeader.rlp,
        expectedHash: headerByNumber.get(blockNumber.toString())?.hash ?? null,
        required: missingSet.has(blockNumber.toString()),
      });
    }
    if (blockNumber === 0n) break;
  }
  for (const ref of missing) {
    const step = plan.find((candidate) => candidate.blockNumber === ref.number);
    if (!step) throw new Error(`no backfill step produced for required block ${ref.number}`);
    if (step.expectedHash == null || step.expectedHash !== ref.blockHash) throw new Error(`header bundle does not authenticate required block ${ref.number}`);
  }
  return plan;
}

export async function runBackfill({ manifest, headers, rpcUrl, submit = false, privateKey }) {
  const requiredRefs = collectRequiredBlockRefs(manifest);
  const headerByNumber = validateHeaderBundle(headers);
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 8_453n) throw new Error(`expected Base chain ID 8453, got ${network.chainId}`);
  const blockhashStoreAddress = getAddress(manifest.batch?.blockhashStore ?? BASE_BLOCKHASH_STORE);
  if (blockhashStoreAddress !== getAddress(BASE_BLOCKHASH_STORE)) throw new Error("manifest does not use the immutable Base Chainlink BlockhashStore");
  if (await provider.getCode(blockhashStoreAddress) === "0x") throw new Error("BlockhashStore address has no bytecode");
  const signer = submit ? new Wallet(privateKey, provider) : provider;
  const store = new Contract(blockhashStoreAddress, BLOCKHASH_STORE_ABI, signer);
  const storedNumbers = new Set();
  for (const ref of requiredRefs) {
    const stored = await getStoredHash(store, ref.number);
    if (stored != null) {
      if (stored.toLowerCase() !== ref.blockHash) throw new Error(`stored hash mismatch for Base block ${ref.number}`);
      storedNumbers.add(ref.number.toString());
    }
  }
  for (const header of headerByNumber.values()) {
    if (storedNumbers.has(header.number.toString())) continue;
    const stored = await getStoredHash(store, header.number);
    if (stored != null) {
      if (stored.toLowerCase() !== header.hash) throw new Error(`stored hash mismatch for Base block ${header.number}`);
      storedNumbers.add(header.number.toString());
    }
  }
  const latestBlock = BigInt(await provider.getBlockNumber());
  const plan = buildBackfillPlan(requiredRefs, headerByNumber, storedNumbers, latestBlock);
  if (!submit) return { status: "planned", requiredBlockCount: requiredRefs.length, transactionCount: plan.length, plan };
  if (!privateKey) throw new Error("SUBMITTER_PRIVATE_KEY is required with --submit");
  const receipts = [];
  for (const step of plan) {
    const transaction = step.method === "store"
      ? await store.store(step.blockNumber)
      : await store.storeVerifyHeader(step.blockNumber, step.header);
    const receipt = await transaction.wait();
    if (receipt.status !== 1) throw new Error(`BlockhashStore ${step.method} failed for ${step.blockNumber}`);
    const stored = await store.getBlockhash(step.blockNumber);
    if (step.expectedHash && stored.toLowerCase() !== step.expectedHash) throw new Error(`stored hash verification failed for ${step.blockNumber}`);
    receipts.push({ blockNumber: step.blockNumber.toString(), transactionHash: transaction.hash, gasUsed: receipt.gasUsed.toString() });
  }
  for (const ref of requiredRefs) {
    const stored = await store.getBlockhash(ref.number);
    if (stored.toLowerCase() !== ref.blockHash) throw new Error(`required block ${ref.number} not present after backfill`);
  }
  return { status: "submitted", requiredBlockCount: requiredRefs.length, transactionCount: receipts.length, receipts };
}

async function getStoredHash(store, blockNumber) {
  try { return await store.getBlockhash(blockNumber); }
  catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const manifestPath = value("--manifest");
  const headersPath = value("--headers");
  const rpcUrl = value("--rpc-url") ?? process.env.ANTSEED_BASE_RPC_URL ?? process.env.BASE_RPC_URL;
  const submit = args.includes("--submit");
  const dryRun = args.includes("--dry-run");
  if (!manifestPath || !headersPath || !rpcUrl || submit === dryRun) {
    throw new Error(USAGE);
  }
  const [manifest, headers] = await Promise.all([
    readFile(manifestPath, "utf8").then(JSON.parse),
    readFile(headersPath, "utf8").then(JSON.parse),
  ]);
  const result = await runBackfill({ manifest, headers, rpcUrl, submit, privateKey: process.env.SUBMITTER_PRIVATE_KEY });
  console.log(JSON.stringify(result, (_, valueToPrint) => typeof valueToPrint === "bigint" ? valueToPrint.toString() : valueToPrint, 2));
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

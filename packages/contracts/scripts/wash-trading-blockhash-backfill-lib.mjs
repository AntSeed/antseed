import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Interface, getAddress } from "ethers";

export const BASE_CHAIN_ID = 8_453n;
export const DEFAULT_BLOCKHASH_STORE = "0x78b69899C8cD252126cBB1A50171ec37286C3877";
export const blockhashStoreInterface = new Interface([
  "function getBlockhash(uint256 blockNumber) view returns (bytes32)",
]);

export function parseArguments(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index < 0 ? null : argv[index + 1];
  };
  return { value, has: (flag) => argv.includes(flag) };
}

export async function loadProductionArtifacts(directory) {
  const absolute = resolve(directory);
  const files = (await readdir(absolute))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".request.json"))
    .sort();
  const artifacts = [];
  for (const name of files) {
    const artifact = JSON.parse(await readFile(join(absolute, name), "utf8"));
    if (artifact?.kind !== "antseed-wash-trading-seller-proof" || artifact.securityMode !== "production") continue;
    artifacts.push(artifact);
  }
  if (artifacts.length === 0) throw new Error(`no production seller proofs in ${absolute}`);
  return artifacts;
}

export function uniqueBlockReferences(artifacts) {
  const references = new Map();
  for (const artifact of artifacts) {
    for (const chunk of artifact.blockAuthenticationChunks ?? []) {
      for (const reference of chunk.references ?? []) {
        const number = positiveSafeInteger(reference.number, "block number");
        const blockHash = normalizeHash(reference.blockHash);
        const existing = references.get(number);
        if (existing && existing !== blockHash) throw new Error(`conflicting hash for Base block ${number}`);
        references.set(number, blockHash);
      }
    }
  }
  return [...references].map(([number, blockHash]) => ({ number, blockHash })).sort((left, right) => left.number - right.number);
}

export function clusterBlockNumbers(numbers, maximumGap) {
  if (numbers.length === 0) return [];
  const clusters = [];
  let start = numbers[0];
  let end = numbers[0];
  let count = 1;
  for (const number of numbers.slice(1)) {
    if (number - end > maximumGap) {
      clusters.push({ startBlock: start, endBlock: end, requiredReferenceCount: count });
      start = number;
      count = 0;
    }
    end = number;
    count += 1;
  }
  clusters.push({ startBlock: start, endBlock: end, requiredReferenceCount: count });
  return clusters;
}

export function mergeBackfillRanges(ranges) {
  const sorted = [...ranges].sort((left, right) => left.startBlock - right.startBlock);
  const merged = [];
  for (const range of sorted) {
    const current = merged.at(-1);
    if (!current || range.startBlock > current.endBlock + 1) {
      merged.push({ ...range });
      continue;
    }
    current.endBlock = Math.max(current.endBlock, range.endBlock);
    if (range.anchorBlock > current.anchorBlock) {
      current.anchorBlock = range.anchorBlock;
      current.anchorHash = range.anchorHash;
    }
    current.requiredReferenceCount += range.requiredReferenceCount;
  }
  return merged;
}

export class JsonRpcClient {
  constructor(url, { batchSize = 250, concurrency = 12, retries = 5 } = {}) {
    this.url = url;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.retries = retries;
    this.nextId = 1;
  }

  async request(method, params) {
    const [result] = await this.batch([{ method, params }]);
    if (result.error) throw new Error(`${method}: ${result.error.message}`);
    return result.result;
  }

  async batch(calls) {
    const requests = calls.map((call) => ({ jsonrpc: "2.0", id: this.nextId++, ...call }));
    for (let attempt = 1; attempt <= this.retries; ++attempt) {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requests),
      });
      if (response.ok) {
        const payload = await response.json();
        const values = Array.isArray(payload) ? payload : [payload];
        if (values.some((item) => isRetryableRpcError(item.error))) {
          if (attempt === this.retries) return values;
          await new Promise((done) => setTimeout(done, 500 * attempt));
          continue;
        }
        const byId = new Map(values.map((item) => [item.id, item]));
        return requests.map((request) => byId.get(request.id) ?? { error: { message: "missing JSON-RPC response" } });
      }
      if (attempt === this.retries) throw new Error(`JSON-RPC ${response.status}: ${await response.text()}`);
      await new Promise((done) => setTimeout(done, 250 * attempt));
    }
    throw new Error("unreachable JSON-RPC retry state");
  }

  async mapBatches(values, makeCall, consume) {
    const batches = [];
    for (let index = 0; index < values.length; index += this.batchSize) batches.push(values.slice(index, index + this.batchSize));
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, batches.length) }, async () => {
      while (cursor < batches.length) {
        const batchIndex = cursor++;
        const batch = batches[batchIndex];
        const results = await this.batch(batch.map(makeCall));
        await consume(batch, results, batchIndex, batches.length);
      }
    });
    await Promise.all(workers);
  }
}

export async function readStoredBlockhashes(client, blockhashStore, numbers, progress) {
  const address = getAddress(blockhashStore);
  const values = new Map();
  let completed = 0;
  await client.mapBatches(
    numbers,
    (number) => ({
      method: "eth_call",
      params: [{ to: address, data: blockhashStoreInterface.encodeFunctionData("getBlockhash", [number]) }, "latest"],
    }),
    async (batch, results) => {
      for (let index = 0; index < batch.length; ++index) {
        const response = results[index];
        if (response.error) values.set(batch[index], null);
        else values.set(batch[index], normalizeHash(blockhashStoreInterface.decodeFunctionResult("getBlockhash", response.result)[0]));
      }
      completed += batch.length;
      progress?.(completed, numbers.length);
    },
  );
  return values;
}

export async function findNextStoredBlock(client, blockhashStore, startBlock, maximumDistance) {
  const address = getAddress(blockhashStore);
  for (let offset = 0; offset <= maximumDistance; offset += client.batchSize) {
    const numbers = Array.from(
      { length: Math.min(client.batchSize, maximumDistance - offset + 1) },
      (_, index) => startBlock + offset + index,
    );
    const results = await client.batch(numbers.map((number) => ({
      method: "eth_call",
      params: [{ to: address, data: blockhashStoreInterface.encodeFunctionData("getBlockhash", [number]) }, "latest"],
    })));
    for (let index = 0; index < numbers.length; ++index) {
      if (results[index].error) continue;
      const blockHash = normalizeHash(blockhashStoreInterface.decodeFunctionResult("getBlockhash", results[index].result)[0]);
      return { number: numbers[index], blockHash };
    }
  }
  throw new Error(`no stored blockhash found in [${startBlock}, ${startBlock + maximumDistance}]`);
}

export async function mapWithConcurrency(values, concurrency, worker) {
  const output = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await worker(values[index], index);
    }
  }));
  return output;
}

export function stableDigest(value) {
  return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function positiveInteger(raw, label) {
  if (!/^[1-9][0-9]*$/.test(String(raw))) throw new Error(`${label} must be a positive integer`);
  return Number(raw);
}

export function positiveSafeInteger(raw, label) {
  const number = positiveInteger(raw, label);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds the safe integer range`);
  return number;
}

export function normalizeHash(value) {
  if (!/^0x[0-9a-f]{64}$/i.test(String(value))) throw new Error(`invalid bytes32 value ${value}`);
  return String(value).toLowerCase();
}

function isRetryableRpcError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("compute units per second") || message.includes("rate limit") || message.includes("too many requests");
}

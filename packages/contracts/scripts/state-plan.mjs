import { Interface, JsonRpcProvider, Wallet, getAddress, keccak256, sha256, toUtf8Bytes } from "ethers";

export const STATE_PLAN_VERSION = 1;
export const STATE_PLAN_KIND = "antseed-base-state-plan";
export const RESUME_VERSION = 3;

const TRANSACTION_INTERFACE = new Interface([
  "function archiveBeaconRoot(uint256 ethereumTimestamp)",
  "function submitCheckpoint(bytes seal,bytes journalData)",
  "function beginHistoricalBackfill()",
  "function submitHistoricalChunk(bytes seal,bytes journalData)",
  "function materializeHistoricalBlocks(tuple(uint64 blockNumber,bytes32 blockHash,bytes32[14] siblings)[] proofs)",
]);
const CHECK_INTERFACE = new Interface([
  "function archivedBeaconRoots(uint256 ethereumTimestamp) view returns (bytes32)",
  "function historicalBackfillStarted() view returns (bool)",
  "function consumedJournalDigests(bytes32 journalDigest) view returns (bool)",
  "function historicalChunkRoots(uint16 chunkIndex) view returns (bytes32)",
  "function canonicalBlockHashes(uint64 blockNumber) view returns (bytes32)",
]);
const PLAN_KEYS = new Set(["version", "kind", "chainId", "oracle", "entries"]);
const ENTRY_KEYS = new Set(["id", "order", "purpose", "to", "value", "data", "checks"]);
const CHECK_KEYS = new Set(["to", "data", "expected"]);

export function validateStatePlan(plan, expectedOracle = null) {
  requireExactKeys(plan, PLAN_KEYS, "state plan");
  if (plan.version !== STATE_PLAN_VERSION || plan.kind !== STATE_PLAN_KIND) throw new Error("unsupported state plan");
  if (plan.chainId !== 8_453) throw new Error("state plan must target Base chain ID 8453");
  const oracle = normalizeAddress(plan.oracle, "state plan oracle");
  if (expectedOracle && oracle !== normalizeAddress(expectedOracle, "expected oracle")) throw new Error("state plan oracle mismatch");
  if (!Array.isArray(plan.entries) || plan.entries.length === 0) throw new Error("state plan has no entries");
  const ids = new Set();
  for (const [order, entry] of plan.entries.entries()) {
    requireExactKeys(entry, ENTRY_KEYS, `state plan entry ${order}`);
    if (entry.order !== order) throw new Error(`state plan entry ${entry.id ?? order} has noncontiguous order`);
    if (typeof entry.id !== "string" || entry.id.length === 0 || ids.has(entry.id)) throw new Error("state plan entry has an empty or duplicate id");
    ids.add(entry.id);
    if (typeof entry.purpose !== "string" || entry.purpose.length === 0) throw new Error(`state plan entry ${entry.id} has no purpose`);
    if (normalizeAddress(entry.to, `${entry.id} target`) !== oracle) throw new Error(`state plan entry ${entry.id} targets a different oracle`);
    if (entry.value !== "0x0") throw new Error(`state plan entry ${entry.id} sends value`);
    validateCalldata(entry.data, TRANSACTION_INTERFACE, `${entry.id} transaction`);
    if (!Array.isArray(entry.checks) || entry.checks.length === 0) throw new Error(`state plan entry ${entry.id} has no completion checks`);
    for (const [checkIndex, check] of entry.checks.entries()) {
      requireExactKeys(check, CHECK_KEYS, `${entry.id} check ${checkIndex}`);
      if (normalizeAddress(check.to, `${entry.id} check target`) !== oracle) throw new Error(`state plan entry ${entry.id} has a non-oracle check`);
      validateCalldata(check.data, CHECK_INTERFACE, `${entry.id} check`);
      validateHex(check.expected, `${entry.id} expected result`, 32, 32);
    }
  }
  return plan;
}

export function statePlanDigest(plan) {
  validateStatePlan(plan);
  return sha256(toUtf8Bytes(canonicalJson(plan)));
}

export function initializeResume(plan, resume = null) {
  const digest = statePlanDigest(plan);
  if (resume == null) return { version: RESUME_VERSION, chainId: plan.chainId, oracle: getAddress(plan.oracle), planDigest: digest, transactions: {} };
  requireExactKeys(resume, new Set(["version", "chainId", "oracle", "planDigest", "transactions"]), "state plan resume");
  if (resume.version !== RESUME_VERSION || resume.chainId !== plan.chainId
      || normalizeAddress(resume.oracle, "resume oracle") !== normalizeAddress(plan.oracle, "plan oracle")
      || resume.planDigest.toLowerCase() !== digest.toLowerCase()) {
    throw new Error("state plan resume does not match the plan");
  }
  if (!resume.transactions || typeof resume.transactions !== "object" || Array.isArray(resume.transactions)) throw new Error("state plan resume transactions are invalid");
  return resume;
}

export async function applyStatePlan({
  plan,
  rpcUrl = null,
  provider = null,
  signer = null,
  privateKey = null,
  mode,
  confirmPlanDigest = null,
  resume = null,
  onPersist = async () => {},
}) {
  validateStatePlan(plan);
  if (!["validate-only", "fork-submit", "submit"].includes(mode)) throw new Error("unsupported state plan mode");
  if (mode === "fork-submit" && !isLoopbackUrl(rpcUrl)) throw new Error("fork-submit requires a loopback RPC URL");
  const digest = statePlanDigest(plan);
  if (mode === "submit" && normalizeHex(confirmPlanDigest) !== normalizeHex(digest)) throw new Error(`submit requires --confirm-plan-digest ${digest}`);

  provider ??= new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 8_453n) throw new Error(`expected Base chain ID 8453, got ${network.chainId}`);
  if (await provider.getCode(plan.oracle) === "0x") throw new Error("state plan oracle has no bytecode");
  if (mode !== "validate-only") signer ??= new Wallet(privateKey, provider);
  const nextResume = initializeResume(plan, resume);
  const results = [];

  for (const entry of plan.entries) {
    if (await checksSatisfied(provider, entry)) {
      results.push({ id: entry.id, status: "satisfied" });
      continue;
    }
    if (mode === "validate-only") {
      results.push({ id: entry.id, status: "unsatisfied" });
      continue;
    }

    const existing = nextResume.transactions[entry.id];
    if (existing?.hash) {
      const pending = await verifyRecordedTransaction(provider, entry, existing);
      if (pending) throw new Error(`state plan entry ${entry.id} has a pending transaction ${existing.hash}`);
      if (await checksSatisfied(provider, entry)) {
        results.push({ id: entry.id, status: "resumed", transactionHash: existing.hash });
        continue;
      }
      if (existing.receipt?.status === 1) throw new Error(`state plan entry ${entry.id} succeeded but its completion checks are not satisfied`);
    }

    const request = { to: entry.to, data: entry.data, value: 0n, from: signer.address };
    await provider.call(request);
    const gas = await provider.estimateGas(request);
    const response = await signer.sendTransaction({ to: entry.to, data: entry.data, value: 0n, gasLimit: gas * 12n / 10n });
    nextResume.transactions[entry.id] = {
      hash: response.hash,
      nonce: response.nonce,
      to: getAddress(entry.to),
      calldataHash: keccak256(entry.data),
    };
    await onPersist(nextResume);
    const receipt = await response.wait();
    nextResume.transactions[entry.id].receipt = {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
    await onPersist(nextResume);
    if (receipt.status !== 1) throw new Error(`state plan entry ${entry.id} reverted`);
    if (!await checksSatisfied(provider, entry)) throw new Error(`state plan entry ${entry.id} did not satisfy its completion checks`);
    results.push({ id: entry.id, status: "submitted", transactionHash: response.hash });
  }

  if (mode !== "validate-only") {
    for (const entry of plan.entries) if (!await checksSatisfied(provider, entry)) throw new Error(`state plan entry ${entry.id} is incomplete after execution`);
  }
  return { planDigest: digest, resume: nextResume, results };
}

async function verifyRecordedTransaction(provider, entry, recorded) {
  if (!Number.isSafeInteger(recorded.nonce) || recorded.nonce < 0) throw new Error(`state plan entry ${entry.id} resume nonce is invalid`);
  if (recorded.to && normalizeAddress(recorded.to, `${entry.id} resume target`) !== normalizeAddress(entry.to, `${entry.id} target`)) throw new Error(`state plan entry ${entry.id} resume target mismatch`);
  if (recorded.calldataHash?.toLowerCase() !== keccak256(entry.data).toLowerCase()) throw new Error(`state plan entry ${entry.id} resume calldata mismatch`);
  const transaction = await provider.getTransaction(recorded.hash);
  if (!transaction) throw new Error(`state plan entry ${entry.id} resume transaction is unavailable`);
  if (normalizeAddress(transaction.to, `${entry.id} transaction target`) !== normalizeAddress(entry.to, `${entry.id} target`)
      || keccak256(transaction.data).toLowerCase() !== keccak256(entry.data).toLowerCase()
      || transaction.nonce !== recorded.nonce
      || transaction.value !== 0n) {
    throw new Error(`state plan entry ${entry.id} on-chain transaction mismatch`);
  }
  const receipt = await provider.getTransactionReceipt(recorded.hash);
  if (!receipt) return true;
  recorded.receipt = { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  return false;
}

async function checksSatisfied(provider, entry) {
  for (const check of entry.checks) {
    let actual;
    try { actual = await provider.call({ to: check.to, data: check.data }); }
    catch { return false; }
    if (normalizeHex(actual) !== normalizeHex(check.expected)) return false;
  }
  return true;
}

function requireExactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) throw new Error(`${label} has invalid fields${unknown.length ? ` unknown=${unknown.join(",")}` : ""}${missing.length ? ` missing=${missing.join(",")}` : ""}`);
}

function normalizeAddress(value, label) {
  try { return getAddress(value).toLowerCase(); }
  catch { throw new Error(`${label} is not a valid address`); }
}

function validateCalldata(value, iface, label) {
  validateHex(value, label, 4);
  let transaction;
  try { transaction = iface.parseTransaction({ data: value }); }
  catch { throw new Error(`${label} uses malformed or unauthorized calldata`); }
  if (!transaction) throw new Error(`${label} uses an unauthorized selector`);
  const canonical = iface.encodeFunctionData(transaction.fragment, transaction.args);
  if (canonical.toLowerCase() !== value.toLowerCase()) throw new Error(`${label} is not canonical ABI calldata`);
}

function validateHex(value, label, minimumBytes, maximumBytes = null) {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-f]{${minimumBytes * 2},}$`, "i").test(value)
      || (value.length - 2) % 2 !== 0
      || (maximumBytes != null && value.length !== 2 + maximumBytes * 2)) throw new Error(`${label} is not valid hex`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function normalizeHex(value) {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function isLoopbackUrl(value) {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname); }
  catch { return false; }
}

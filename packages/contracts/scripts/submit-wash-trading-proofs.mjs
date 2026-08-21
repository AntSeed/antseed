#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { AbiCoder, Contract, JsonRpcProvider, Wallet, getAddress, keccak256, sha256, toUtf8Bytes } from "ethers";

const REGISTRY_ABI = [
  "function closedCycleImageId() view returns (bytes32)",
  "function reciprocalImageId() view returns (bytes32)",
  "function stateOracle() view returns (address)",
  "function isSellerP0(address seller) view returns (bool)",
  "function submitClosedCycleProof(bytes seal,bytes journalData) returns (bool)",
  "function submitReciprocalProof(bytes seal,bytes journalData) returns (bool,bool)",
];
const STATE_ORACLE_ABI = ["function isCanonicalBlock(uint64 blockNumber,bytes32 blockHash) view returns (bool)"];
const BLOCK_REFS = "tuple(uint64 number,bytes32 blockHash)[]";
const CLOSED_CYCLE_JOURNAL = `tuple(address seller,${BLOCK_REFS} blockRefs)`;
const RECIPROCAL_JOURNAL = `tuple(address addressA,address addressB,${BLOCK_REFS} blockRefs)`;
const MAX_SUBMISSION_GAS = 7_000_000n;
const SUBMISSION_RESUME_VERSION = 4;
const PROOF_CONFIG = {
  P0_CLOSED_LOOP: { journal: CLOSED_CYCLE_JOURNAL, image: "closedCycleImageId", method: "submitClosedCycleProof" },
  P0_RECIPROCAL: { journal: RECIPROCAL_JOURNAL, image: "reciprocalImageId", method: "submitReciprocalProof" },
};

export async function runSubmission({
  manifest,
  registryAddress,
  rpcUrl,
  submit = false,
  privateKey,
  allowDevelopmentOnLoopback = false,
  resume = null,
  onPersist = async () => {},
}) {
  validateManifest(manifest);
  const localDevelopment = manifest.securityMode === "development" && allowDevelopmentOnLoopback && isLoopbackRpcUrl(rpcUrl);
  if (manifest.securityMode !== "production" && !localDevelopment) {
    throw new Error(`refusing ${manifest.securityMode} receipts; production receipts are required`);
  }
  resume = initializeSubmissionResume(manifest, registryAddress, resume);
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 8_453n) throw new Error(`expected Base chain ID 8453, got ${network.chainId}`);
  if (await provider.getCode(registryAddress) === "0x") throw new Error("registry address has no bytecode");
  const signer = submit ? new Wallet(privateKey, provider) : provider;
  const registry = new Contract(registryAddress, REGISTRY_ABI, signer);
  const [closedCycleImageId, reciprocalImageId, stateOracle] = await Promise.all([
    registry.closedCycleImageId(), registry.reciprocalImageId(), registry.stateOracle(),
  ]);
  const images = { closedCycleImageId, reciprocalImageId };
  const stateOracleContract = new Contract(stateOracle, STATE_ORACLE_ABI, provider);

  const results = [];
  for (const entry of manifest.entries) {
    const decoded = decodeAndValidateEntry(entry, manifest.chainId);
    const config = PROOF_CONFIG[entry.claimType];
    if (normalizeBytes32(entry.imageId) !== normalizeBytes32(images[config.image])) {
      throw new Error(`${entry.claimId}: image ID mismatch`);
    }
    if (await subjectsAreP0(registry, decoded.subjects)) {
      results.push({ claimId: entry.claimId, status: "already-p0" });
      continue;
    }
    for (const blockRef of decoded.blockRefs) {
      if (!await stateOracleContract.isCanonicalBlock(blockRef.number, blockRef.blockHash)) {
        throw new Error(`${entry.claimId}: Base block ${blockRef.number} is not canonical in the configured state oracle`);
      }
    }
    const transaction = await registry[config.method].populateTransaction(entry.seal, entry.journalBytes);
    await provider.call({ ...transaction, from: submit ? signer.address : undefined });
    const gas = await provider.estimateGas({ ...transaction, from: submit ? signer.address : undefined });
    if (gas > MAX_SUBMISSION_GAS) throw new Error(`${entry.claimId}: estimated gas ${gas} exceeds ${MAX_SUBMISSION_GAS}`);
    if (!submit) {
      results.push({ claimId: entry.claimId, status: "simulated", gas: gas.toString() });
      continue;
    }
    const existing = resume.transactions[entry.claimId];
    if (existing?.hash) {
      const pending = await verifyRecordedSubmission(provider, transaction, entry, registryAddress, existing);
      if (pending) throw new Error(`${entry.claimId}: recorded submission ${existing.hash} is still pending`);
      if (existing.receipt.status === 1) {
        if (!await subjectsAreP0(registry, decoded.subjects)) {
          throw new Error(`${entry.claimId}: recorded submission succeeded but did not mark every subject P0`);
        }
        results.push({ claimId: entry.claimId, status: "submitted", transactionHash: existing.hash });
        continue;
      }
    }
    const response = await signer.sendTransaction({ ...transaction, gasLimit: gas * 12n / 10n });
    resume.transactions[entry.claimId] = {
      hash: response.hash,
      nonce: response.nonce,
      to: getAddress(registryAddress),
      calldataHash: keccak256(transaction.data),
    };
    await onPersist(resume);
    const receipt = await response.wait();
    if (receipt.status !== 1) throw new Error(`${entry.claimId}: submission reverted`);
    if (!await subjectsAreP0(registry, decoded.subjects)) {
      throw new Error(`${entry.claimId}: submission succeeded but did not mark every subject P0`);
    }
    resume.transactions[entry.claimId].receipt = {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
    await onPersist(resume);
    results.push({ claimId: entry.claimId, status: "submitted", transactionHash: response.hash });
  }
  return results;
}

export function initializeSubmissionResume(manifest, registryAddress, resume = null) {
  const expected = {
    version: SUBMISSION_RESUME_VERSION,
    chainId: manifest.chainId,
    registry: getAddress(registryAddress),
    manifestDigest: sha256(toUtf8Bytes(canonicalJson(manifest))),
    transactions: {},
  };
  if (resume == null) return expected;
  requireExactKeys(resume, ["version", "chainId", "registry", "manifestDigest", "transactions"], "submission resume");
  if (resume.version !== expected.version || resume.chainId !== expected.chainId
      || getAddress(resume.registry) !== expected.registry
      || resume.manifestDigest.toLowerCase() !== expected.manifestDigest.toLowerCase()
      || !resume.transactions || typeof resume.transactions !== "object" || Array.isArray(resume.transactions)) {
    throw new Error("submission resume does not match the proof manifest");
  }
  return resume;
}

async function verifyRecordedSubmission(provider, transaction, entry, registryAddress, recorded) {
  if (!Number.isSafeInteger(recorded.nonce) || recorded.nonce < 0) throw new Error(`${entry.claimId}: recorded nonce is invalid`);
  if (getAddress(recorded.to) !== getAddress(registryAddress) || recorded.calldataHash?.toLowerCase() !== keccak256(transaction.data).toLowerCase()) {
    throw new Error(`${entry.claimId}: recorded submission binding mismatch`);
  }
  const onchain = await provider.getTransaction(recorded.hash);
  if (!onchain) throw new Error(`${entry.claimId}: recorded submission transaction is unavailable`);
  if (getAddress(onchain.to) !== getAddress(registryAddress) || onchain.nonce !== recorded.nonce || onchain.value !== 0n
      || keccak256(onchain.data).toLowerCase() !== keccak256(transaction.data).toLowerCase()) {
    throw new Error(`${entry.claimId}: recorded on-chain submission differs from the manifest`);
  }
  const receipt = await provider.getTransactionReceipt(recorded.hash);
  if (!receipt) return true;
  recorded.receipt = { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  return false;
}

export function validateManifest(manifest) {
  if (manifest.version !== 1 || manifest.kind !== "antseed-wash-trading-proof-results") {
    throw new Error("unsupported proof manifest");
  }
  if (manifest.chainId !== 8_453) throw new Error("proof manifest must target Base chain ID 8453");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error("proof manifest has no entries");
  const claims = new Set();
  for (const entry of manifest.entries) {
    if (entry.enforceable === false) throw new Error(`${entry.claimId}: analysis-only entries cannot be submitted`);
    if (!PROOF_CONFIG[entry.claimType]) throw new Error(`${entry.claimId}: unsupported claim type`);
    if (!/^0x[0-9a-f]+$/i.test(entry.seal ?? "") || entry.seal === "0x") throw new Error(`${entry.claimId}: seal missing`);
    if (!/^0x[0-9a-f]+$/i.test(entry.journalBytes ?? "")) throw new Error(`${entry.claimId}: journal missing`);
    if (!Array.isArray(entry.subjects) || entry.subjects.length === 0) throw new Error(`${entry.claimId}: subjects missing`);
    if (!entry.metrics || typeof entry.metrics !== "object" || Array.isArray(entry.metrics)) throw new Error(`${entry.claimId}: metrics missing`);
    if (sha256(entry.journalBytes).toLowerCase() !== entry.journalDigest.toLowerCase()) {
      throw new Error(`${entry.claimId}: journal digest mismatch`);
    }
    const normalized = entry.claimId.toLowerCase();
    if (claims.has(normalized)) throw new Error(`${entry.claimId}: duplicate claim ID`);
    claims.add(normalized);
  }
}

export function decodeAndValidateEntry(entry, chainId = 8_453) {
  if (chainId !== 8_453) throw new Error(`${entry.claimId}: manifest is not for Base`);
  const config = PROOF_CONFIG[entry.claimType];
  if (!config) throw new Error(`${entry.claimId}: unsupported claim type`);
  const decoded = AbiCoder.defaultAbiCoder().decode([config.journal], entry.journalBytes)[0];
  let subjects;
  if (entry.claimType === "P0_RECIPROCAL") {
    if (BigInt(decoded.addressA) >= BigInt(decoded.addressB)) throw new Error(`${entry.claimId}: pair is not normalized`);
    subjects = [getAddress(decoded.addressA), getAddress(decoded.addressB)];
  } else {
    subjects = [getAddress(decoded.seller)];
  }
  if (subjects.length !== entry.subjects.length
      || subjects.some((subject, index) => subject !== getAddress(entry.subjects[index]))) {
    throw new Error(`${entry.claimId}: journal subjects mismatch`);
  }
  let previous = -1n;
  if (decoded.blockRefs.length === 0 || decoded.blockRefs.length > 2_048) throw new Error(`${entry.claimId}: invalid block reference count`);
  for (const blockRef of decoded.blockRefs) {
    if (blockRef.number <= previous || /^0x0{64}$/i.test(blockRef.blockHash)) throw new Error(`${entry.claimId}: invalid block references`);
    previous = blockRef.number;
  }
  return { blockRefs: decoded.blockRefs, subjects };
}

async function subjectsAreP0(registry, subjects) {
  return (await Promise.all(subjects.map((subject) => registry.isSellerP0(subject)))).every(Boolean);
}

function normalizeBytes32(value) {
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) throw new Error(`${label} has invalid fields`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function isLoopbackRpcUrl(value) {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname); }
  catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const manifestPath = value("--manifest");
  const baselinePath = value("--volume-baseline");
  const planPath = value("--proof-plan");
  const bundlePath = value("--proof-bundle");
  const baselinePublicKeyPath = value("--volume-baseline-public-key") ?? process.env.VOLUME_BASELINE_PUBLIC_KEY;
  const registryAddress = value("--registry") ?? process.env.WASH_TRADING_REGISTRY;
  const rpcUrl = value("--rpc-url") ?? process.env.ANTSEED_BASE_RPC_URL ?? process.env.BASE_RPC_URL;
  const submit = args.includes("--submit");
  const dryRun = args.includes("--dry-run");
  if (!manifestPath || !baselinePath || !baselinePublicKeyPath || !planPath || !bundlePath || !registryAddress || !rpcUrl || submit === dryRun) {
    throw new Error("usage: node submit-wash-trading-proofs.mjs --manifest proof-results.json --volume-baseline baseline.json --volume-baseline-public-key baseline.pub.pem --proof-plan plan.json --proof-bundle bundle.json --registry 0x... (--dry-run|--submit)");
  }
  const resumePath = resolve(value("--resume") ?? `${manifestPath}.submission.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const proofPlan = JSON.parse(await readFile(planPath, "utf8"));
  const proofBundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const { authenticateBaselineReceipts, compareVolumeBaseline, verifyVolumeBaselineSignature } = await import("./verify-proof-volumes.mjs");
  verifyVolumeBaselineSignature(baseline, await readFile(baselinePublicKeyPath, "utf8"));
  if (baseline.body.claimCount !== 26 || proofPlan.claims?.length !== 26 || manifest.entries?.length !== 26) throw new Error("deployment submission requires exactly 26 claims");
  const volumeProvider = new JsonRpcProvider(rpcUrl);
  const receiptVolumes = await authenticateBaselineReceipts(baseline.body, proofBundle, (method, params) => volumeProvider.send(method, params));
  const volumeReport = compareVolumeBaseline(baseline, proofPlan, manifest, receiptVolumes);
  if (!volumeReport.ok) throw new Error(`volume equivalence failed with ${volumeReport.differences.length} differences`);
  const resume = await readJson(resumePath, null);
  const results = await runSubmission({
    manifest, registryAddress, rpcUrl, submit,
    privateKey: submit ? process.env.SUBMITTER_PRIVATE_KEY : null,
    resume,
    onPersist: (next) => writeJsonAtomic(resumePath, next),
  });
  for (const result of results) console.log(`${result.claimId} ${result.status}${result.gas ? ` gas=${result.gas}` : ""}`);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJsonAtomic(path, valueToWrite) {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(valueToWrite, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

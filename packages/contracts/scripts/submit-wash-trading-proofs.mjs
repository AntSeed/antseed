#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  keccak256,
  sha256,
  toUtf8Bytes,
} from "ethers";

const REGISTRY_ABI = [
  "function closedLoopVKey() view returns (bytes32)",
  "function reciprocalVKey() view returns (bytes32)",
  "function blockhashStore() view returns (address)",
  "function expectedBatchCount() view returns (uint32)",
  "function expectedBatchDigest() view returns (bytes32)",
  "function backfillComplete() view returns (bool)",
  "function claimJournalDigest(bytes32 claimId) view returns (bytes32)",
  "function washRecords(address seller) view returns (uint128 washVolume,uint128 settledVolume)",
  "function washRatioBps(address seller) view returns (uint16)",
  "function submitBatch(bytes[] publicValues,bytes[] proofBytes)",
];
const BLOCKHASH_STORE_ABI = ["function getBlockhash(uint256 blockNumber) view returns (bytes32)"];
const POINTS_POLICY_ABI = ["function penaltyBps(bytes32,address,address,uint256) view returns (uint16,uint16)"];
const REWARD_POLICY_ABI = [
  "function retainedSellerRewardsBps(address seller) view returns (uint16)",
  "function canClaimSellerUnlocked(address seller) view returns (bool)",
];
const WASH_JOURNAL = "tuple(uint8 predicateId,uint64 chainId,uint64 periodStartBlock,uint64 periodEndBlock,bytes32 claimId,tuple(address subject,uint128 washVolume,uint128 settledVolume)[] subjects,tuple(uint64 number,bytes32 blockHash)[] blockRefs)";
const BATCH_DOMAIN = keccak256(toUtf8Bytes("ANTSEED_AIP4_BACKFILL_V1"));
const MAX_BATCH_GAS = 300_000_000n;
const DEFAULT_MAX_CALLDATA_BYTES = 10_000_000;
const SUBMISSION_RESUME_VERSION = 7;
const PROOF_CONFIG = {
  P0_CLOSED_LOOP: { predicateId: 1, vkey: "closedLoopVKey" },
  P0_RECIPROCAL: { predicateId: 2, vkey: "reciprocalVKey" },
};
const MANIFEST_KEYS = ["version", "kind", "chainId", "securityMode", "batch", "entries"];
const BATCH_KEYS = ["domain", "blockhashStore", "closedLoopVKey", "reciprocalVKey", "expectedBatchCount", "expectedBatchDigest", "commitments"];
const COMMITMENT_KEYS = ["claimId", "journalDigest"];
const ENTRY_KEYS = ["claimId", "sourceClaimId", "claimType", "subjects", "metrics", "programVKey", "journalBytes", "journalDigest", "proofBytes", "blockReferences", "instructionCount"];
const USAGE = "usage: node submit-wash-trading-proofs.mjs --manifest proof-results.json --volume-baseline baseline.json --volume-baseline-public-key baseline.pub.pem --proof-plan plan.json --proof-bundle bundle.json --registry 0x... --points-policy 0x... --reward-policy 0x... --max-calldata-bytes N (--dry-run|--submit)";

export async function runSubmission({
  manifest,
  registryAddress,
  rpcUrl,
  submit = false,
  privateKey,
  allowDevelopmentOnLoopback = false,
  maxCalldataBytes = DEFAULT_MAX_CALLDATA_BYTES,
  pointsPolicyAddress = null,
  rewardPolicyAddress = null,
  resume = null,
  onPersist = async () => {},
}) {
  validateManifest(manifest);
  const localDevelopment = manifest.securityMode === "development" && allowDevelopmentOnLoopback && isLoopbackRpcUrl(rpcUrl);
  if (manifest.securityMode !== "production" && !localDevelopment) {
    throw new Error(`refusing ${manifest.securityMode} proofs; production SP1 proofs are required`);
  }
  if (manifest.securityMode === "production" && (!pointsPolicyAddress || !rewardPolicyAddress)) {
    throw new Error("production batch verification requires both installed policy addresses");
  }
  if (submit && !privateKey) throw new Error("SUBMITTER_PRIVATE_KEY is required with --submit");
  if (!Number.isSafeInteger(maxCalldataBytes) || maxCalldataBytes <= 0) throw new Error("invalid calldata-size limit");

  resume = initializeSubmissionResume(manifest, registryAddress, resume);
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 8_453n) throw new Error(`expected Base chain ID 8453, got ${network.chainId}`);
  if (await provider.getCode(registryAddress) === "0x") throw new Error("registry address has no bytecode");
  const signer = submit ? new Wallet(privateKey, provider) : provider;
  const registry = new Contract(registryAddress, REGISTRY_ABI, signer);
  const [closedLoopVKey, reciprocalVKey, blockhashStore, expectedBatchCount, expectedBatchDigest, complete] = await Promise.all([
    registry.closedLoopVKey(),
    registry.reciprocalVKey(),
    registry.blockhashStore(),
    registry.expectedBatchCount(),
    registry.expectedBatchDigest(),
    registry.backfillComplete(),
  ]);
  assertRegistryBinding(manifest, {
    closedLoopVKey,
    reciprocalVKey,
    blockhashStore,
    expectedBatchCount,
    expectedBatchDigest,
  });

  const decodedEntries = manifest.entries.map((entry) => decodeAndValidateEntry(entry, manifest.chainId));
  if (complete) {
    await verifyPostSubmission(registry, manifest, decodedEntries, pointsPolicyAddress, rewardPolicyAddress, provider);
    return [{ status: "already-complete", claimCount: manifest.entries.length }];
  }

  if (pointsPolicyAddress || rewardPolicyAddress) {
    await verifyPendingPolicies(pointsPolicyAddress, rewardPolicyAddress, provider);
  }

  const blockhashStoreContract = new Contract(blockhashStore, BLOCKHASH_STORE_ABI, provider);
  const uniqueBlockRefs = new Map();
  for (const decoded of decodedEntries) {
    for (const blockRef of decoded.blockRefs) {
      const key = blockRef.number.toString();
      const prior = uniqueBlockRefs.get(key);
      if (prior && normalizeBytes32(prior) !== normalizeBytes32(blockRef.blockHash)) {
        throw new Error(`Base block ${key} has conflicting hashes in the proof manifest`);
      }
      uniqueBlockRefs.set(key, blockRef.blockHash);
    }
  }
  await Promise.all([...uniqueBlockRefs].map(async ([number, expectedHash]) => {
    const actualHash = await blockhashStoreContract.getBlockhash(number);
    if (normalizeBytes32(actualHash) !== normalizeBytes32(expectedHash)) {
      throw new Error(`Base block ${number} is absent or mismatched in BlockhashStore`);
    }
  }));

  const publicValues = manifest.entries.map((entry) => entry.journalBytes);
  const proofBytes = manifest.entries.map((entry) => entry.proofBytes);
  const transaction = await registry.submitBatch.populateTransaction(publicValues, proofBytes);
  const calldataBytes = (transaction.data.length - 2) / 2;
  if (calldataBytes > maxCalldataBytes) {
    throw new Error(`batch calldata ${calldataBytes} bytes exceeds sequencer limit ${maxCalldataBytes}`);
  }
  const from = submit ? signer.address : undefined;
  await provider.call({ ...transaction, from });
  const gas = await provider.estimateGas({ ...transaction, from });
  if (gas > MAX_BATCH_GAS) throw new Error(`estimated batch gas ${gas} exceeds production ceiling ${MAX_BATCH_GAS}`);
  if (!submit) return [{ status: "simulated", claimCount: manifest.entries.length, gas: gas.toString(), calldataBytes }];

  const recorded = resume.transaction;
  if (recorded?.hash) {
    const pending = await verifyRecordedSubmission(provider, transaction, registryAddress, recorded);
    if (pending) throw new Error(`recorded batch submission ${recorded.hash} is still pending`);
    if (recorded.receipt.status !== 1) throw new Error(`recorded batch submission ${recorded.hash} reverted`);
    await verifyPostSubmission(registry, manifest, decodedEntries, pointsPolicyAddress, rewardPolicyAddress, provider);
    return [{ status: "submitted", claimCount: manifest.entries.length, transactionHash: recorded.hash, gas: recorded.receipt.gasUsed, calldataBytes }];
  }

  const gasLimit = gas * 105n / 100n;
  const response = await signer.sendTransaction({ ...transaction, gasLimit });
  resume.transaction = {
    hash: response.hash,
    nonce: response.nonce,
    to: getAddress(registryAddress),
    calldataHash: keccak256(transaction.data),
  };
  await onPersist(resume);
  const receipt = await response.wait();
  if (receipt.status !== 1) throw new Error("atomic backfill submission reverted");
  resume.transaction.receipt = {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
  };
  await onPersist(resume);
  await verifyPostSubmission(registry, manifest, decodedEntries, pointsPolicyAddress, rewardPolicyAddress, provider);
  return [{ status: "submitted", claimCount: manifest.entries.length, transactionHash: response.hash, gas: receipt.gasUsed.toString(), calldataBytes }];
}

export function computeBatchCommitments(entries) {
  return entries.map((entry) => ({ claimId: normalizeBytes32(entry.claimId), journalDigest: normalizeBytes32(entry.journalDigest) }));
}

export function computeExpectedBatchDigest({ chainId = 8_453, closedLoopVKey, reciprocalVKey, blockhashStore, commitments }) {
  const abi = AbiCoder.defaultAbiCoder();
  let digest = keccak256(abi.encode(
    ["bytes32", "uint64", "bytes32", "bytes32", "address", "uint256"],
    [BATCH_DOMAIN, chainId, closedLoopVKey, reciprocalVKey, blockhashStore, commitments.length],
  ));
  for (const commitment of commitments) {
    digest = keccak256(abi.encode(
      ["bytes32", "bytes32", "bytes32"],
      [digest, commitment.claimId, commitment.journalDigest],
    ));
  }
  return digest;
}

export function initializeSubmissionResume(manifest, registryAddress, resume = null) {
  const expected = {
    version: SUBMISSION_RESUME_VERSION,
    chainId: manifest.chainId,
    registry: getAddress(registryAddress),
    manifestDigest: sha256(toUtf8Bytes(canonicalJson(manifest))),
    transaction: null,
  };
  if (resume == null) return expected;
  requireExactKeys(resume, ["version", "chainId", "registry", "manifestDigest", "transaction"], "submission resume");
  if (resume.version !== expected.version || resume.chainId !== expected.chainId
      || getAddress(resume.registry) !== expected.registry
      || normalizeBytes32(resume.manifestDigest) !== normalizeBytes32(expected.manifestDigest)) {
    throw new Error("submission resume does not match the proof manifest");
  }
  return resume;
}

async function verifyRecordedSubmission(provider, transaction, registryAddress, recorded) {
  if (!Number.isSafeInteger(recorded.nonce) || recorded.nonce < 0) throw new Error("recorded nonce is invalid");
  if (getAddress(recorded.to) !== getAddress(registryAddress)
      || normalizeBytes32(recorded.calldataHash) !== normalizeBytes32(keccak256(transaction.data))) {
    throw new Error("recorded batch submission binding mismatch");
  }
  const onchain = await provider.getTransaction(recorded.hash);
  if (!onchain) throw new Error("recorded batch submission transaction is unavailable");
  if (getAddress(onchain.to) !== getAddress(registryAddress) || onchain.nonce !== recorded.nonce || onchain.value !== 0n
      || normalizeBytes32(keccak256(onchain.data)) !== normalizeBytes32(keccak256(transaction.data))) {
    throw new Error("recorded on-chain batch differs from the manifest");
  }
  const receipt = await provider.getTransactionReceipt(recorded.hash);
  if (!receipt) return true;
  recorded.receipt = { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  return false;
}

export function validateManifest(manifest) {
  requireExactKeys(manifest, MANIFEST_KEYS, "proof manifest");
  if (manifest.version !== 2 || manifest.kind !== "antseed-wash-trading-proof-results") throw new Error("unsupported proof manifest");
  if (manifest.chainId !== 8_453) throw new Error("proof manifest must target Base chain ID 8453");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error("proof manifest has no entries");
  requireExactKeys(manifest.batch, BATCH_KEYS, "proof manifest batch");
  if (normalizeBytes32(manifest.batch.domain) !== normalizeBytes32(BATCH_DOMAIN)) throw new Error("batch domain mismatch");
  getAddress(manifest.batch.blockhashStore);
  if (manifest.batch.expectedBatchCount !== manifest.entries.length) throw new Error("batch count does not match proof entries");
  if (!Array.isArray(manifest.batch.commitments) || manifest.batch.commitments.length !== manifest.entries.length) throw new Error("invalid batch commitments");

  const claims = new Set();
  let previousClaimId = -1n;
  for (const [index, entry] of manifest.entries.entries()) {
    requireExactKeys(entry, ENTRY_KEYS, `${entry.claimId ?? "proof entry"}`);
    const config = PROOF_CONFIG[entry.claimType];
    if (!config) throw new Error(`${entry.claimId}: unsupported claim type`);
    if (!/^0x[0-9a-f]{64}$/i.test(entry.claimId ?? "")) throw new Error(`${entry.claimId}: invalid claim ID`);
    if (BigInt(entry.claimId) <= previousClaimId) throw new Error(`${entry.claimId}: proof entries are not strictly claim-ID ordered`);
    previousClaimId = BigInt(entry.claimId);
    if (!/^0x[0-9a-f]{64}$/i.test(entry.programVKey ?? "")) throw new Error(`${entry.claimId}: SP1 program vkey missing`);
    if (normalizeBytes32(entry.programVKey) !== normalizeBytes32(manifest.batch[config.vkey])) throw new Error(`${entry.claimId}: batch vkey mismatch`);
    if (!/^0x[0-9a-f]+$/i.test(entry.proofBytes ?? "") || entry.proofBytes === "0x") throw new Error(`${entry.claimId}: SP1 proof bytes missing`);
    if (!/^0x[0-9a-f]+$/i.test(entry.journalBytes ?? "")) throw new Error(`${entry.claimId}: journal missing`);
    if (!Array.isArray(entry.subjects) || entry.subjects.length === 0) throw new Error(`${entry.claimId}: subjects missing`);
    if (!Array.isArray(entry.blockReferences) || entry.blockReferences.length === 0) throw new Error(`${entry.claimId}: block references missing`);
    if (!entry.metrics || typeof entry.metrics !== "object" || Array.isArray(entry.metrics)) throw new Error(`${entry.claimId}: metrics missing`);
    if (normalizeBytes32(sha256(entry.journalBytes)) !== normalizeBytes32(entry.journalDigest)) throw new Error(`${entry.claimId}: journal digest mismatch`);
    const normalized = normalizeBytes32(entry.claimId);
    if (claims.has(normalized)) throw new Error(`${entry.claimId}: duplicate claim ID`);
    claims.add(normalized);
    const commitment = manifest.batch.commitments[index];
    requireExactKeys(commitment, COMMITMENT_KEYS, `${entry.claimId} commitment`);
    if (normalizeBytes32(commitment.claimId) !== normalized
        || normalizeBytes32(commitment.journalDigest) !== normalizeBytes32(entry.journalDigest)) {
      throw new Error(`${entry.claimId}: batch commitment mismatch`);
    }
  }
  const computedDigest = computeExpectedBatchDigest({
    chainId: manifest.chainId,
    closedLoopVKey: manifest.batch.closedLoopVKey,
    reciprocalVKey: manifest.batch.reciprocalVKey,
    blockhashStore: manifest.batch.blockhashStore,
    commitments: manifest.batch.commitments,
  });
  if (normalizeBytes32(computedDigest) !== normalizeBytes32(manifest.batch.expectedBatchDigest)) throw new Error("expected batch digest mismatch");
}

export function decodeAndValidateEntry(entry, chainId = 8_453) {
  if (chainId !== 8_453) throw new Error(`${entry.claimId}: manifest is not for Base`);
  const config = PROOF_CONFIG[entry.claimType];
  if (!config) throw new Error(`${entry.claimId}: unsupported claim type`);
  const decoded = AbiCoder.defaultAbiCoder().decode([WASH_JOURNAL], entry.journalBytes)[0];
  if (Number(decoded.predicateId) !== config.predicateId) throw new Error(`${entry.claimId}: journal predicate mismatch`);
  if (Number(decoded.chainId) !== chainId) throw new Error(`${entry.claimId}: journal targets wrong chain`);
  if (normalizeBytes32(decoded.claimId) !== normalizeBytes32(entry.claimId)) throw new Error(`${entry.claimId}: journal claim ID mismatch`);
  const subjects = decoded.subjects.map((subject) => ({
    subject: getAddress(subject.subject),
    washVolume: subject.washVolume,
    settledVolume: subject.settledVolume,
  }));
  if (subjects.length !== entry.subjects.length
      || subjects.some((subject, index) => subject.subject !== getAddress(entry.subjects[index]))) {
    throw new Error(`${entry.claimId}: journal subjects mismatch`);
  }
  let previous = -1n;
  if (decoded.blockRefs.length === 0 || decoded.blockRefs.length > 40_000) throw new Error(`${entry.claimId}: invalid block reference count`);
  const blockRefs = decoded.blockRefs.map((blockRef) => ({ number: blockRef.number, blockHash: blockRef.blockHash }));
  for (const [index, blockRef] of blockRefs.entries()) {
    if (blockRef.number <= previous || /^0x0{64}$/i.test(blockRef.blockHash)) throw new Error(`${entry.claimId}: invalid block references`);
    previous = blockRef.number;
    const declared = entry.blockReferences[index];
    if (!declared || BigInt(declared.number) !== blockRef.number || normalizeBytes32(declared.blockHash) !== normalizeBytes32(blockRef.blockHash)) {
      throw new Error(`${entry.claimId}: declared block references mismatch journal`);
    }
  }
  if (entry.blockReferences.length !== blockRefs.length) throw new Error(`${entry.claimId}: declared block reference count mismatch`);
  return { claimId: decoded.claimId, blockRefs, subjects };
}

function assertRegistryBinding(manifest, onchain) {
  const comparisons = [
    ["closed-loop vkey", manifest.batch.closedLoopVKey, onchain.closedLoopVKey],
    ["reciprocal vkey", manifest.batch.reciprocalVKey, onchain.reciprocalVKey],
    ["batch digest", manifest.batch.expectedBatchDigest, onchain.expectedBatchDigest],
  ];
  for (const [label, expected, actual] of comparisons) {
    if (normalizeBytes32(expected) !== normalizeBytes32(actual)) throw new Error(`registry ${label} mismatch`);
  }
  if (getAddress(manifest.batch.blockhashStore) !== getAddress(onchain.blockhashStore)) throw new Error("registry BlockhashStore mismatch");
  if (BigInt(manifest.batch.expectedBatchCount) !== onchain.expectedBatchCount) throw new Error("registry batch count mismatch");
}

async function verifyPostSubmission(registry, manifest, decodedEntries, pointsPolicyAddress, rewardPolicyAddress, provider) {
  if (!await registry.backfillComplete()) throw new Error("batch transaction succeeded without completing the backfill");
  await Promise.all(manifest.entries.map(async (entry) => {
    const actual = await registry.claimJournalDigest(entry.claimId);
    if (normalizeBytes32(actual) !== normalizeBytes32(entry.journalDigest)) throw new Error(`${entry.claimId}: on-chain journal digest mismatch`);
  }));

  const expectedBySubject = greatestRatios(decodedEntries.flatMap((entry) => entry.subjects));
  for (const [subject, expected] of expectedBySubject) {
    const [record, ratioBps] = await Promise.all([registry.washRecords(subject), registry.washRatioBps(subject)]);
    if (record.washVolume !== expected.washVolume || record.settledVolume !== expected.settledVolume || ratioBps !== expected.ratioBps) {
      throw new Error(`${subject}: on-chain wash ratio record mismatch`);
    }
  }

  if (Boolean(pointsPolicyAddress) !== Boolean(rewardPolicyAddress)) throw new Error("both policy addresses are required for policy verification");
  if (!pointsPolicyAddress) return;
  const pointsPolicy = new Contract(pointsPolicyAddress, POINTS_POLICY_ABI, provider);
  const rewardPolicy = new Contract(rewardPolicyAddress, REWARD_POLICY_ABI, provider);
  for (const [subject] of expectedBySubject) {
    const [[sellerPenaltyBps, buyerPenaltyBps], retainedBps, immediate] = await Promise.all([
      pointsPolicy.penaltyBps("0x" + "00".repeat(32), subject, subject, 1),
      rewardPolicy.retainedSellerRewardsBps(subject),
      rewardPolicy.canClaimSellerUnlocked(subject),
    ]);
    if (buyerPenaltyBps !== 0n || sellerPenaltyBps + retainedBps !== 10_000n || immediate) {
      throw new Error(`${subject}: points and reward policies disagree after backfill`);
    }
  }
  const unproven = firstUnprovenAddress(expectedBySubject);
  const [[sellerPenaltyBps, buyerPenaltyBps], retainedBps, immediate] = await Promise.all([
    pointsPolicy.penaltyBps("0x" + "00".repeat(32), unproven, unproven, 1),
    rewardPolicy.retainedSellerRewardsBps(unproven),
    rewardPolicy.canClaimSellerUnlocked(unproven),
  ]);
  if (sellerPenaltyBps !== 0n || buyerPenaltyBps !== 0n || retainedBps !== 10_000n || !immediate) {
    throw new Error("unproven seller is not fully released after backfill");
  }
}

async function verifyPendingPolicies(pointsPolicyAddress, rewardPolicyAddress, provider) {
  if (Boolean(pointsPolicyAddress) !== Boolean(rewardPolicyAddress)) throw new Error("both policy addresses are required for policy verification");
  const seller = "0x0000000000000000000000000000000000000001";
  const pointsPolicy = new Contract(pointsPolicyAddress, POINTS_POLICY_ABI, provider);
  const rewardPolicy = new Contract(rewardPolicyAddress, REWARD_POLICY_ABI, provider);
  const [[sellerPenaltyBps, buyerPenaltyBps], retainedBps, immediate] = await Promise.all([
    pointsPolicy.penaltyBps("0x" + "00".repeat(32), seller, seller, 1),
    rewardPolicy.retainedSellerRewardsBps(seller),
    rewardPolicy.canClaimSellerUnlocked(seller),
  ]);
  if (sellerPenaltyBps !== 0n || buyerPenaltyBps !== 0n || retainedBps !== 0n || immediate) {
    throw new Error("installed policies do not enforce the pending-backfill behavior");
  }
}

function firstUnprovenAddress(expectedBySubject) {
  for (let value = 1n; value < 1_000n; value += 1n) {
    const address = `0x${value.toString(16).padStart(40, "0")}`;
    if (!expectedBySubject.has(address)) return address;
  }
  throw new Error("could not choose an unproven policy-test address");
}

function greatestRatios(subjects) {
  const records = new Map();
  for (const candidate of subjects) {
    const key = candidate.subject;
    const current = records.get(key);
    if (!current || isGreaterRatio(candidate, current)) records.set(key, candidate);
  }
  for (const record of records.values()) record.ratioBps = ratioBps(record);
  return records;
}

function isGreaterRatio(candidate, current) {
  if (current.settledVolume === 0n || current.washVolume >= current.settledVolume) return false;
  if (candidate.settledVolume === 0n || candidate.washVolume >= candidate.settledVolume) return true;
  return candidate.washVolume * current.settledVolume > current.washVolume * candidate.settledVolume;
}

function ratioBps(record) {
  if (record.washVolume === 0n) return 0n;
  if (record.settledVolume === 0n || record.washVolume >= record.settledVolume) return 10_000n;
  return record.washVolume * 10_000n / record.settledVolume;
}

function normalizeBytes32(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("invalid bytes32 value");
  return value.toLowerCase();
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
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
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
  const maxCalldataBytes = value("--max-calldata-bytes");
  const pointsPolicyAddress = value("--points-policy") ?? process.env.WASH_TRADING_POINTS_POLICY;
  const rewardPolicyAddress = value("--reward-policy") ?? process.env.WASH_TRADING_REWARD_POLICY;
  if (!manifestPath || !baselinePath || !baselinePublicKeyPath || !planPath || !bundlePath || !registryAddress || !rpcUrl || !maxCalldataBytes || !pointsPolicyAddress || !rewardPolicyAddress || submit === dryRun) {
    throw new Error(USAGE);
  }
  const resumePath = resolve(value("--resume") ?? `${manifestPath}.submission.json`);
  const [manifest, baseline, proofPlan, proofBundle] = await Promise.all([
    readJson(manifestPath), readJson(baselinePath), readJson(planPath), readJson(bundlePath),
  ]);
  const { authenticateBaselineReceipts, compareVolumeBaseline, verifyVolumeBaselineSignature } = await import("./verify-proof-volumes.mjs");
  verifyVolumeBaselineSignature(baseline, await readFile(baselinePublicKeyPath, "utf8"));
  if (baseline.body.claimCount !== proofPlan.claims?.length || proofPlan.claims.length !== manifest.entries?.length) {
    throw new Error("approved baseline, proof plan, and proof manifest claim counts differ");
  }
  const volumeProvider = new JsonRpcProvider(rpcUrl);
  const receiptVolumes = await authenticateBaselineReceipts(baseline.body, proofBundle, (method, params) => volumeProvider.send(method, params));
  const volumeReport = compareVolumeBaseline(baseline, proofPlan, manifest, receiptVolumes);
  if (!volumeReport.ok) throw new Error(`volume equivalence failed with ${volumeReport.differences.length} differences`);
  const resume = await readJson(resumePath, null);
  const results = await runSubmission({
    manifest,
    registryAddress,
    rpcUrl,
    submit,
    privateKey: submit ? process.env.SUBMITTER_PRIVATE_KEY : null,
    maxCalldataBytes: Number(maxCalldataBytes),
    pointsPolicyAddress,
    rewardPolicyAddress,
    resume,
    onPersist: (next) => writeJsonAtomic(resumePath, next),
  });
  for (const result of results) console.log(JSON.stringify(result));
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && arguments.length > 1) return fallback; throw error; }
}

async function writeJsonAtomic(path, valueToWrite) {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(valueToWrite, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

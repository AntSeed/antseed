#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet, getBytes, sha256 } from "ethers";

const REGISTRY_ABI = [
  "function approvedReportRoot() view returns (bytes32)",
  "function cohortImageId() view returns (bytes32)",
  "function reciprocalImageId() view returns (bytes32)",
  "function stateOracle() view returns (address)",
  "function consumedClaimIds(bytes32) view returns (bool)",
  "function sellerPenaltyBps(address) view returns (uint16)",
  "function submitCohortPenalty(bytes seal, bytes journalData) returns (bool)",
  "function submitReciprocalPenalty(bytes seal, bytes journalData) returns (bool,bool)",
];
const STATE_ORACLE_INTERFACE = new Interface([
  "function archiveBeaconRoot(uint256 ethereumTimestamp)",
  "function submitCheckpoint(bytes seal,bytes journalData)",
  "function beginHistoricalBackfill()",
  "function submitHistoricalChunk(bytes seal,bytes journalData)",
  "function materializeHistoricalBlocks(tuple(uint64 blockNumber,bytes32 blockHash,bytes32[14] siblings)[] proofs)",
]);
const ALLOWED_STATE_SELECTORS = new Set(STATE_ORACLE_INTERFACE.fragments.map((fragment) => STATE_ORACLE_INTERFACE.getFunction(fragment.name).selector.toLowerCase()));
const COHORT_JOURNAL = "tuple(uint32 predicateVersion,uint8 claimType,bytes32 claimId,bytes32 reportRoot,address seller,uint16 penaltyBps,uint32 linkedBuyerCount,uint128 qualifiedVolumeRaw,tuple(uint64 number,bytes32 blockHash)[] blockRefs)";
const RECIPROCAL_JOURNAL = "tuple(uint32 predicateVersion,bytes32 claimId,bytes32 reportRoot,address sellerA,address sellerB,uint16 penaltyBps,uint32 settlementCount,uint128 qualifiedVolumeRaw,tuple(uint64 number,bytes32 blockHash)[] blockRefs)";
const MAX_PENALTY_GAS = 5_000_000n;

export async function runSubmission({ manifest, registryAddress, rpcUrl, submit = false, privateKey, stateManifest = null, resume = { transactions: {} }, onPersist = async () => {} }) {
  validateManifest(manifest);
  if (manifest.securityMode !== "production") throw new Error(`refusing ${manifest.securityMode} receipts; production receipts are required`);
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 8_453n) throw new Error(`expected Base chain ID 8453, got ${network.chainId}`);
  const code = await provider.getCode(registryAddress);
  if (code === "0x") throw new Error("registry address has no bytecode");
  const signer = submit ? new Wallet(privateKey, provider) : provider;
  const registry = new Contract(registryAddress, REGISTRY_ABI, signer);
  const [reportRoot, cohortImageId, reciprocalImageId, stateOracle] = await Promise.all([
    registry.approvedReportRoot(), registry.cohortImageId(), registry.reciprocalImageId(), registry.stateOracle(),
  ]);
  if (reportRoot.toLowerCase() !== manifest.reportRoot.toLowerCase()) throw new Error("registry report root mismatch");

  for (const stateProof of stateManifest?.entries ?? []) {
    await simulateAndMaybeSendRaw({ provider, signer, submit, entry: stateProof, stateOracle, resume, onPersist });
  }

  const results = [];
  for (const entry of manifest.entries) {
    const decoded = decodeAndValidateEntry(entry, manifest.reportRoot);
    const expectedImage = entry.claimType === "P0_RECIPROCAL" ? reciprocalImageId : cohortImageId;
    if (normalizeBytes32(entry.imageId) !== normalizeBytes32(expectedImage)) throw new Error(`${entry.claimId}: image ID mismatch`);
    if (await registry.consumedClaimIds(entry.claimId)) {
      results.push({ claimId: entry.claimId, status: "consumed" });
      continue;
    }
    const sellers = entry.claimType === "P0_RECIPROCAL" ? [decoded.sellerA, decoded.sellerB] : [decoded.seller];
    const penalties = await Promise.all(sellers.map((seller) => registry.sellerPenaltyBps(seller)));
    if (penalties.every((penalty) => penalty >= 9_000n)) {
      results.push({ claimId: entry.claimId, status: "already-maxed" });
      continue;
    }
    const method = entry.claimType === "P0_RECIPROCAL" ? "submitReciprocalPenalty" : "submitCohortPenalty";
    const transaction = await registry[method].populateTransaction(entry.seal, entry.journalBytes);
    await provider.call({ ...transaction, from: submit ? signer.address : undefined });
    const gas = await provider.estimateGas({ ...transaction, from: submit ? signer.address : undefined });
    if (gas > MAX_PENALTY_GAS) throw new Error(`${entry.claimId}: estimated gas ${gas} exceeds limit ${MAX_PENALTY_GAS}`);
    if (!submit) {
      results.push({ claimId: entry.claimId, status: "simulated", gas: gas.toString() });
      continue;
    }
    const existing = resume.transactions[entry.claimId];
    if (existing?.receipt?.status === 1) {
      results.push({ claimId: entry.claimId, status: "submitted", transactionHash: existing.hash });
      continue;
    }
    const response = await signer.sendTransaction({ ...transaction, gasLimit: gas * 12n / 10n });
    resume.transactions[entry.claimId] = { hash: response.hash };
    await onPersist(resume);
    const receipt = await response.wait();
    if (receipt.status !== 1) throw new Error(`${entry.claimId}: transaction reverted ${response.hash}`);
    resume.transactions[entry.claimId].receipt = { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
    await onPersist(resume);
    results.push({ claimId: entry.claimId, status: "submitted", transactionHash: response.hash });
  }
  return results;
}

export function validateManifest(manifest) {
  if (manifest?.version !== 1 || manifest?.chainId !== 8_453 || !Array.isArray(manifest.entries)) throw new Error("unsupported proof results manifest");
  if (manifest.kind !== "antseed-wash-trading-proof-results" || manifest.securityMode !== "production" || !/^0x[0-9a-f]{64}$/i.test(manifest.reportRoot ?? "")) {
    throw new Error("invalid production proof results manifest");
  }
  const claimIds = new Set();
  for (const entry of manifest.entries) {
    if (!["P0_CLOSED_LOOP", "P1_COORDINATED_CONTROL", "P0_RECIPROCAL"].includes(entry.claimType)) throw new Error(`${entry.claimId}: unsupported claim type`);
    if (!/^0x[0-9a-f]{64}$/i.test(entry.claimId ?? "") || !/^(?:0x)?[0-9a-f]{64}$/i.test(entry.imageId ?? "")) throw new Error("invalid proof result identity");
    if (claimIds.has(entry.claimId)) throw new Error(`duplicate claim ID ${entry.claimId}`);
    claimIds.add(entry.claimId);
    if (!/^0x[0-9a-f]+$/i.test(entry.seal ?? "")) throw new Error(`${entry.claimId}: proof seal missing or malformed`);
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(entry.journalBytes ?? "") || !/^0x[0-9a-f]{64}$/i.test(entry.journalDigest ?? "")) {
      throw new Error(`${entry.claimId}: journal encoding malformed`);
    }
    if (sha256(entry.journalBytes).toLowerCase() !== entry.journalDigest.toLowerCase()) throw new Error(`${entry.claimId}: journal digest mismatch`);
  }
}

export function decodeAndValidateEntry(entry, reportRoot) {
  const coder = AbiCoder.defaultAbiCoder();
  const type = entry.claimType === "P0_RECIPROCAL" ? RECIPROCAL_JOURNAL : COHORT_JOURNAL;
  const decoded = coder.decode([type], entry.journalBytes)[0];
  if (decoded.claimId.toLowerCase() !== entry.claimId.toLowerCase()) throw new Error(`${entry.claimId}: journal claim ID mismatch`);
  if (decoded.reportRoot.toLowerCase() !== reportRoot.toLowerCase()) throw new Error(`${entry.claimId}: journal report root mismatch`);
  if (decoded.penaltyBps !== 9_000n) throw new Error(`${entry.claimId}: unexpected penalty`);
  if (entry.claimType !== "P0_RECIPROCAL") {
    const expectedClaimType = entry.claimType === "P0_CLOSED_LOOP" ? 1n : 2n;
    if (decoded.claimType !== expectedClaimType) throw new Error(`${entry.claimId}: journal claim type mismatch`);
  }
  let previous = -1n;
  for (const blockRef of decoded.blockRefs) {
    if (blockRef.number <= previous || /^0x0{64}$/i.test(blockRef.blockHash)) throw new Error(`${entry.claimId}: invalid block references`);
    previous = blockRef.number;
  }
  return decoded;
}

function normalizeBytes32(value) {
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

async function simulateAndMaybeSendRaw({ provider, signer, submit, entry, stateOracle, resume, onPersist }) {
  validateStateProofEntry(entry, stateOracle);
  if (await isStateProofSatisfied(provider, entry)) return;
  await provider.call({ to: entry.to, data: entry.data, from: submit ? signer.address : undefined });
  const gas = await provider.estimateGas({ to: entry.to, data: entry.data, from: submit ? signer.address : undefined });
  if (!submit) return;
  if (resume.transactions[entry.id]?.receipt?.status === 1) return;
  const response = await signer.sendTransaction({ to: entry.to, data: entry.data, gasLimit: gas * 12n / 10n });
  resume.transactions[entry.id] = { hash: response.hash };
  await onPersist(resume);
  const receipt = await response.wait();
  if (receipt.status !== 1) throw new Error(`state proof ${entry.id} reverted`);
  resume.transactions[entry.id].receipt = { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  await onPersist(resume);
}

export function validateStateProofEntry(entry, stateOracle) {
  if (!entry.id || !entry.to || !entry.data) throw new Error("state proof entry requires id, to, and data");
  if (entry.to.toLowerCase() !== stateOracle.toLowerCase()) throw new Error(`state proof ${entry.id} targets a non-oracle contract`);
  if (!/^0x[0-9a-f]{8,}$/i.test(entry.data) || !ALLOWED_STATE_SELECTORS.has(entry.data.slice(0, 10).toLowerCase())) {
    throw new Error(`state proof ${entry.id} uses an unauthorized oracle method`);
  }
  if (entry.check?.to && entry.check.to.toLowerCase() !== stateOracle.toLowerCase()) {
    throw new Error(`state proof ${entry.id} uses a non-oracle completion check`);
  }
}

async function isStateProofSatisfied(provider, entry) {
  if (!entry.check?.to || !entry.check?.data || !entry.check?.expected) return false;
  const result = await provider.call({ to: entry.check.to, data: entry.check.data });
  return result.toLowerCase() === entry.check.expected.toLowerCase();
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const manifestPath = value("--manifest");
  const registryAddress = value("--registry") ?? process.env.WASH_TRADING_REGISTRY;
  const rpcUrl = value("--rpc-url") ?? process.env.ANTSEED_BASE_RPC_URL ?? process.env.BASE_RPC_URL;
  const submit = args.includes("--submit");
  const dryRun = args.includes("--dry-run");
  if (!manifestPath || !registryAddress || !rpcUrl || submit === dryRun) throw new Error("usage: node submit-wash-trading-proofs.mjs --manifest proof-results-v1.json --registry 0x... (--dry-run|--submit)");
  const resumePath = resolve(value("--resume") ?? `${manifestPath}.submission.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const stateManifestPath = value("--state-manifest");
  const stateManifest = stateManifestPath ? JSON.parse(await readFile(stateManifestPath, "utf8")) : null;
  const resume = await readJson(resumePath, { version: 1, transactions: {} });
  const results = await runSubmission({
    manifest,
    registryAddress,
    rpcUrl,
    submit,
    privateKey: submit ? process.env.SUBMITTER_PRIVATE_KEY : null,
    stateManifest,
    resume,
    onPersist: (valueToPersist) => writeFile(resumePath, `${JSON.stringify(valueToPersist, null, 2)}\n`),
  });
  for (const result of results) console.log(`${result.claimId} ${result.status}${result.gas ? ` gas=${result.gas}` : ""}`);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

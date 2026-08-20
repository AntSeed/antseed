#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet, keccak256, sha256 } from "ethers";

const REGISTRY_ABI = [
  "function closedCycleImageId() view returns (bytes32)",
  "function reciprocalImageId() view returns (bytes32)",
  "function coordinatedControlImageId() view returns (bytes32)",
  "function stateOracle() view returns (address)",
  "function consumedClaimIds(bytes32) view returns (bool)",
  "function submitClosedCycleProof(bytes seal,bytes journalData) returns (bool)",
  "function submitReciprocalProof(bytes seal,bytes journalData) returns (bool,bool)",
  "function submitCoordinatedControlProof(bytes seal,bytes journalData) returns (bool)",
];
const STATE_ORACLE_INTERFACE = new Interface([
  "function archiveBeaconRoot(uint256 ethereumTimestamp)",
  "function submitCheckpoint(bytes seal,bytes journalData)",
  "function beginHistoricalBackfill()",
  "function submitHistoricalChunk(bytes seal,bytes journalData)",
  "function materializeHistoricalBlocks(tuple(uint64 blockNumber,bytes32 blockHash,bytes32[14] siblings)[] proofs)",
]);
const ALLOWED_STATE_SELECTORS = new Set(
  STATE_ORACLE_INTERFACE.fragments.map((fragment) => STATE_ORACLE_INTERFACE.getFunction(fragment.name).selector.toLowerCase()),
);
const BLOCK_REFS = "tuple(uint64 number,bytes32 blockHash)[]";
const CLOSED_CYCLE_JOURNAL = `tuple(uint32 predicateVersion,bytes32 claimId,uint64 periodStartBlock,uint64 periodEndBlockExclusive,address seller,address funder,bytes32 cohortHash,uint32 cohortCount,uint128 qualifiedVolumeRaw,uint8 closureKind,uint32 closurePathCount,uint16 penaltyBps,${BLOCK_REFS} blockRefs)`;
const RECIPROCAL_JOURNAL = `tuple(uint32 predicateVersion,bytes32 claimId,uint64 periodStartBlock,uint64 periodEndBlockExclusive,address addressA,address addressB,uint32 settlementCountAToB,uint32 settlementCountBToA,uint128 volumeAToBRaw,uint128 volumeBToARaw,uint16 penaltyBps,${BLOCK_REFS} blockRefs)`;
const COORDINATED_CONTROL_JOURNAL = `tuple(uint32 predicateVersion,bytes32 claimId,uint64 periodStartBlock,uint64 periodEndBlockExclusive,address seller,bytes32 funderCohortHash,uint32 funderCount,bytes32 cohortHash,uint32 cohortCount,uint128 qualifiedCohortVolumeRaw,uint128 sellerPeriodVolumeRaw,uint16 penaltyBps,address[] penalizedBuyers,${BLOCK_REFS} blockRefs)`;
const PERIOD_START = 44_471_575n;
const PERIOD_END_EXCLUSIVE = 49_936_173n;
const MAX_PENALTY_GAS = 7_000_000n;
const PROOF_CONFIG = {
  P0_CLOSED_CYCLE: { journal: CLOSED_CYCLE_JOURNAL, image: "closedCycleImageId", method: "submitClosedCycleProof", proofType: 1n },
  P0_RECIPROCAL: { journal: RECIPROCAL_JOURNAL, image: "reciprocalImageId", method: "submitReciprocalProof", proofType: 2n },
  P1_COORDINATED_CONTROL: { journal: COORDINATED_CONTROL_JOURNAL, image: "coordinatedControlImageId", method: "submitCoordinatedControlProof", proofType: 3n },
};

export async function runSubmission({
  manifest,
  registryAddress,
  rpcUrl,
  submit = false,
  privateKey,
  stateManifest = null,
  resume = { version: 2, transactions: {} },
  onPersist = async () => {},
}) {
  validateManifest(manifest);
  if (manifest.securityMode !== "production") {
    throw new Error(`refusing ${manifest.securityMode} receipts; production receipts are required`);
  }
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 8_453n) throw new Error(`expected Base chain ID 8453, got ${network.chainId}`);
  if (await provider.getCode(registryAddress) === "0x") throw new Error("registry address has no bytecode");
  const signer = submit ? new Wallet(privateKey, provider) : provider;
  const registry = new Contract(registryAddress, REGISTRY_ABI, signer);
  const [closedCycleImageId, reciprocalImageId, coordinatedControlImageId, stateOracle] = await Promise.all([
    registry.closedCycleImageId(), registry.reciprocalImageId(), registry.coordinatedControlImageId(), registry.stateOracle(),
  ]);
  const images = { closedCycleImageId, reciprocalImageId, coordinatedControlImageId };

  for (const stateProof of stateManifest?.entries ?? []) {
    await simulateAndMaybeSendRaw({ provider, signer, submit, entry: stateProof, stateOracle, resume, onPersist });
  }

  const results = [];
  for (const entry of manifest.entries) {
    const decoded = decodeAndValidateEntry(entry, manifest.chainId);
    const config = PROOF_CONFIG[entry.claimType];
    if (normalizeBytes32(entry.imageId) !== normalizeBytes32(images[config.image])) {
      throw new Error(`${entry.claimId}: image ID mismatch`);
    }
    if (await registry.consumedClaimIds(entry.claimId)) {
      results.push({ claimId: entry.claimId, status: "consumed" });
      continue;
    }
    const transaction = await registry[config.method].populateTransaction(entry.seal, entry.journalBytes);
    await provider.call({ ...transaction, from: submit ? signer.address : undefined });
    const gas = await provider.estimateGas({ ...transaction, from: submit ? signer.address : undefined });
    if (gas > MAX_PENALTY_GAS) throw new Error(`${entry.claimId}: estimated gas ${gas} exceeds ${MAX_PENALTY_GAS}`);
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
    if (receipt.status !== 1) throw new Error(`${entry.claimId}: submission reverted`);
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

export function validateManifest(manifest) {
  if (manifest.version !== 3 || manifest.kind !== "antseed-wash-trading-proof-results") {
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
    if (sha256(entry.journalBytes).toLowerCase() !== entry.journalDigest.toLowerCase()) {
      throw new Error(`${entry.claimId}: journal digest mismatch`);
    }
    const normalized = entry.claimId.toLowerCase();
    if (claims.has(normalized)) throw new Error(`${entry.claimId}: duplicate claim ID`);
    claims.add(normalized);
  }
}

export function decodeAndValidateEntry(entry, chainId = 8_453) {
  const config = PROOF_CONFIG[entry.claimType];
  if (!config) throw new Error(`${entry.claimId}: unsupported claim type`);
  const decoded = AbiCoder.defaultAbiCoder().decode([config.journal], entry.journalBytes)[0];
  if (decoded.predicateVersion !== 3n || decoded.penaltyBps !== 9_000n) {
    throw new Error(`${entry.claimId}: invalid predicate version or penalty`);
  }
  if (decoded.periodStartBlock !== PERIOD_START || decoded.periodEndBlockExclusive !== PERIOD_END_EXCLUSIVE) {
    throw new Error(`${entry.claimId}: invalid fixed period`);
  }
  let expectedClaimId;
  if (entry.claimType === "P0_RECIPROCAL") {
    if (BigInt(decoded.addressA) >= BigInt(decoded.addressB)) throw new Error(`${entry.claimId}: pair is not normalized`);
    expectedClaimId = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "uint64", "uint64", "address", "address"],
      [chainId, config.proofType, decoded.periodStartBlock, decoded.periodEndBlockExclusive, decoded.addressA, decoded.addressB],
    ));
  } else if (entry.claimType === "P1_COORDINATED_CONTROL") {
    expectedClaimId = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "uint64", "uint64", "address", "bytes32", "bytes32"],
      [chainId, config.proofType, decoded.periodStartBlock, decoded.periodEndBlockExclusive, decoded.seller, decoded.funderCohortHash, decoded.cohortHash],
    ));
  } else {
    expectedClaimId = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "uint64", "uint64", "address", "address", "bytes32"],
      [chainId, config.proofType, decoded.periodStartBlock, decoded.periodEndBlockExclusive, decoded.seller, decoded.funder, decoded.cohortHash],
    ));
  }
  if (expectedClaimId.toLowerCase() !== entry.claimId.toLowerCase() || decoded.claimId.toLowerCase() !== entry.claimId.toLowerCase()) {
    throw new Error(`${entry.claimId}: journal claim ID mismatch`);
  }
  if (entry.claimType === "P1_COORDINATED_CONTROL") {
    validateSortedAddresses(decoded.penalizedBuyers, entry.claimId);
  }
  let previous = -1n;
  if (decoded.blockRefs.length === 0 || decoded.blockRefs.length > 256) throw new Error(`${entry.claimId}: invalid block reference count`);
  for (const blockRef of decoded.blockRefs) {
    if (blockRef.number <= previous || /^0x0{64}$/i.test(blockRef.blockHash)) throw new Error(`${entry.claimId}: invalid block references`);
    previous = blockRef.number;
  }
  return decoded;
}

function validateSortedAddresses(addresses, claimId) {
  if (addresses.length > 160) throw new Error(`${claimId}: too many penalized buyers`);
  let previous = 0n;
  for (const address of addresses) {
    const current = BigInt(address);
    if (current === 0n || current <= previous) throw new Error(`${claimId}: penalized buyers are not canonical`);
    previous = current;
  }
}

function normalizeBytes32(value) {
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

async function simulateAndMaybeSendRaw({ provider, signer, submit, entry, stateOracle, resume, onPersist }) {
  validateStateProofEntry(entry, stateOracle);
  if (await isStateProofSatisfied(provider, entry)) return;
  await provider.call({ to: entry.to, data: entry.data, from: submit ? signer.address : undefined });
  const gas = await provider.estimateGas({ to: entry.to, data: entry.data, from: submit ? signer.address : undefined });
  if (!submit || resume.transactions[entry.id]?.receipt?.status === 1) return;
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
  if (!manifestPath || !registryAddress || !rpcUrl || submit === dryRun) {
    throw new Error("usage: node submit-wash-trading-proofs.mjs --manifest proof-results-v3.json --registry 0x... (--dry-run|--submit)");
  }
  const resumePath = resolve(value("--resume") ?? `${manifestPath}.submission.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const stateManifestPath = value("--state-manifest");
  const stateManifest = stateManifestPath ? JSON.parse(await readFile(stateManifestPath, "utf8")) : null;
  const resume = await readJson(resumePath, { version: 2, transactions: {} });
  const results = await runSubmission({
    manifest, registryAddress, rpcUrl, submit,
    privateKey: submit ? process.env.SUBMITTER_PRIVATE_KEY : null,
    stateManifest, resume,
    onPersist: (next) => writeFile(resumePath, `${JSON.stringify(next, null, 2)}\n`),
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

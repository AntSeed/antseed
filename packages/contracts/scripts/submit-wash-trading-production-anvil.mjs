#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, ContractFactory, JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers";

const contractsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
const artifactDirectory = resolve(value("--artifact-dir") ?? "");
const rpcUrl = value("--rpc-url") ?? "http://127.0.0.1:8545";
const verifierAddress = getAddress(value("--sp1-verifier") ?? "0x397A5f7f3dBd538f23DE225B51f532c34448dA9B");
const blockhashStoreAddress = getAddress(
  value("--blockhash-store") ?? "0x78b69899C8cD252126cBB1A50171ec37286C3877",
);
const authenticationBatchSize = positiveInteger(value("--authentication-batch-size") ?? "8");
if (!args.includes("--submit-production-local") || !value("--artifact-dir")) {
  throw new Error("usage: submit-wash-trading-production-anvil.mjs --artifact-dir sellers --rpc-url URL --submit-production-local");
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(rpcUrl)) {
  throw new Error("production-shaped Anvil submission is restricted to loopback RPC URLs");
}

const artifacts = await loadArtifacts(artifactDirectory);
const configuration = validateArtifacts(artifacts);
const provider = new JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork();
if (network.chainId !== 8_453n) throw new Error(`expected chain ID 8453, got ${network.chainId}`);
if (await provider.getCode(verifierAddress) === "0x") {
  throw new Error(`SP1 verifier is not deployed at ${verifierAddress}; start Anvil with a Base mainnet fork`);
}
if (await provider.getCode(blockhashStoreAddress) === "0x") {
  throw new Error(`BlockhashStore is not deployed at ${blockhashStoreAddress}; start Anvil with a Base mainnet fork`);
}
const signer = new Wallet(
  process.env.ANVIL_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider,
);
let nonce = await provider.getTransactionCount(signer.address, "pending");

const batchAuthenticator = await deploy("WashTradingDevelopmentE2E.sol/WashTradingLocalBatchAuthenticator.json", []);
const registry = await deploy("AntseedWashTradingRegistry.sol/AntseedWashTradingRegistry.json", [
  verifierAddress,
  blockhashStoreAddress,
  configuration.aggregatorProgramVKey,
  configuration.closedLoopProgramVKey,
  configuration.reciprocalProgramVKey,
  configuration.periodStartBlock,
  configuration.periodEndBlock,
]);

let totalProvenWashVolume = 0n;
let totalGasUsed = 0n;
let totalAuthenticatedReferences = 0;
let totalAuthenticatedChunks = 0;
const startedAt = Date.now();
for (let artifactIndex = 0; artifactIndex < artifacts.length; artifactIndex += 1) {
  const artifact = artifacts[artifactIndex];
  const journal = decodeJournal(artifact.publicValues);
  process.stderr.write(`[${artifactIndex + 1}/${artifacts.length}] staging ${journal.seller}\n`);
  const submissionReceipt = await (await registry.stageSellerProof(
    artifact.publicValues,
    artifact.proofBytes,
    { nonce: nonce++ },
  )).wait();
  totalGasUsed += submissionReceipt.gasUsed;
  const proofId = keccak256(artifact.publicValues);

  for (let offset = 0; offset < artifact.blockAuthenticationChunks.length; offset += authenticationBatchSize) {
    const chunks = artifact.blockAuthenticationChunks.slice(offset, offset + authenticationBatchSize);
    const receipt = await (await batchAuthenticator.authenticateChunks(
      await registry.getAddress(),
      proofId,
      chunks.map((chunk) => chunk.index),
      chunks.map((chunk) => chunk.references),
      chunks.map((chunk) => chunk.proof),
      { nonce: nonce++ },
    )).wait();
    totalGasUsed += receipt.gasUsed;
    totalAuthenticatedChunks += chunks.length;
    totalAuthenticatedReferences += chunks.reduce((count, chunk) => count + chunk.references.length, 0);
  }

  const finalizationReceipt = await (await registry.finalizeSellerProof(proofId, { nonce: nonce++ })).wait();
  totalGasUsed += finalizationReceipt.gasUsed;
  const onchainVolume = await registry.provenWashVolume(journal.seller);
  const onchainEvidenceDigest = await registry.sellerEvidenceDigest(journal.seller);
  if (onchainVolume !== journal.provenWashVolume) throw new Error(`${journal.seller}: onchain wash volume mismatch`);
  if (onchainEvidenceDigest.toLowerCase() !== journal.evidenceDigest.toLowerCase()) {
    throw new Error(`${journal.seller}: onchain evidence digest mismatch`);
  }
  const authenticatedReferences = await registry.proofAuthenticatedBlockReferenceCount(proofId);
  if (authenticatedReferences !== journal.blockReferenceCount) {
    throw new Error(`${journal.seller}: authenticated block-reference count mismatch`);
  }
  totalProvenWashVolume += journal.provenWashVolume;
  process.stderr.write(
    `[${artifactIndex + 1}/${artifacts.length}] finalized ${journal.seller} volume=${journal.provenWashVolume}\n`,
  );
}

console.log(`WASH_TRADING_PRODUCTION_ANVIL_RESULT=${JSON.stringify({
  registry: await registry.getAddress(),
  verifier: verifierAddress,
  blockhashStore: blockhashStoreAddress,
  batchAuthenticator: await batchAuthenticator.getAddress(),
  sellerCount: artifacts.length,
  totalProvenWashVolumeRaw: totalProvenWashVolume.toString(),
  totalAuthenticatedReferences,
  totalAuthenticatedChunks,
  totalGasUsed: totalGasUsed.toString(),
  elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  transactionMode: "base-fork-real-sp1-and-chainlink-blockhash-store",
})}`);

async function deploy(relativeArtifact, constructorArguments) {
  const compiled = JSON.parse(await readFile(resolve(contractsDirectory, "out", relativeArtifact), "utf8"));
  const factory = new ContractFactory(compiled.abi, compiled.bytecode.object, signer);
  const contract = await factory.deploy(...constructorArguments, { nonce: nonce++ });
  await contract.waitForDeployment();
  return contract;
}

async function loadArtifacts(directory) {
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".request.json"))
    .sort();
  if (files.length === 0) throw new Error(`no seller proof artifacts in ${directory}`);
  return Promise.all(files.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
}

function validateArtifacts(candidates) {
  const sellers = new Set();
  let configuration;
  for (const candidate of candidates) {
    if (candidate?.version !== 2 || candidate.kind !== "antseed-wash-trading-seller-proof"
      || candidate.securityMode !== "production") {
      throw new Error("artifact directory contains a non-production seller proof");
    }
    for (const field of ["aggregatorProgramVKey", "closedLoopProgramVKey", "reciprocalProgramVKey", "publicValues", "proofBytes"]) {
      if (!/^0x[0-9a-f]+$/i.test(candidate[field] ?? "")) throw new Error(`${field} is invalid`);
    }
    if (!Array.isArray(candidate.blockAuthenticationChunks)
      || candidate.blockAuthenticationChunks.length !== candidate.blockAuthenticationChunkCount) {
      throw new Error(`${candidate.seller}: invalid block authentication chunks`);
    }
    const journal = decodeJournal(candidate.publicValues);
    validateJournal(candidate, journal);
    const seller = journal.seller.toLowerCase();
    if (sellers.has(seller)) throw new Error(`${journal.seller}: duplicate seller artifact`);
    sellers.add(seller);
    const current = {
      aggregatorProgramVKey: candidate.aggregatorProgramVKey.toLowerCase(),
      closedLoopProgramVKey: journal.closedLoopProgramVKey.toLowerCase(),
      reciprocalProgramVKey: journal.reciprocalProgramVKey.toLowerCase(),
      periodStartBlock: journal.periodStartBlock,
      periodEndBlock: journal.periodEndBlock,
    };
    configuration ??= current;
    if (JSON.stringify(current, bigintJson) !== JSON.stringify(configuration, bigintJson)) {
      throw new Error(`${journal.seller}: proof configuration differs from the batch`);
    }
  }
  return configuration;
}

function decodeJournal(publicValues) {
  const [journal] = AbiCoder.defaultAbiCoder().decode([
    "tuple(uint32 schemaVersion,uint64 chainId,uint64 periodStartBlock,uint64 periodEndBlock,bytes32 closedLoopProgramVKey,bytes32 reciprocalProgramVKey,address seller,uint128 provenWashVolume,bytes32 evidenceDigest,uint32 blockReferenceCount,uint32 blockAuthenticationChunkSize,uint32 blockAuthenticationChunkCount,bytes32 blockAuthenticationRoot)",
  ], publicValues);
  return {
    schemaVersion: journal.schemaVersion,
    chainId: journal.chainId,
    periodStartBlock: journal.periodStartBlock,
    periodEndBlock: journal.periodEndBlock,
    closedLoopProgramVKey: journal.closedLoopProgramVKey,
    reciprocalProgramVKey: journal.reciprocalProgramVKey,
    seller: getAddress(journal.seller),
    provenWashVolume: journal.provenWashVolume,
    evidenceDigest: journal.evidenceDigest,
    blockReferenceCount: journal.blockReferenceCount,
    blockAuthenticationChunkSize: journal.blockAuthenticationChunkSize,
    blockAuthenticationChunkCount: journal.blockAuthenticationChunkCount,
    blockAuthenticationRoot: journal.blockAuthenticationRoot,
  };
}

function validateJournal(artifact, journal) {
  if (journal.schemaVersion !== 1n || journal.chainId !== 8_453n
    || journal.seller !== getAddress(artifact.seller)
    || journal.provenWashVolume.toString() !== artifact.provenWashVolumeRaw
    || journal.periodStartBlock !== BigInt(artifact.periodStartBlock)
    || journal.periodEndBlock !== BigInt(artifact.periodEndBlock)
    || journal.closedLoopProgramVKey.toLowerCase() !== artifact.closedLoopProgramVKey.toLowerCase()
    || journal.reciprocalProgramVKey.toLowerCase() !== artifact.reciprocalProgramVKey.toLowerCase()
    || journal.evidenceDigest.toLowerCase() !== artifact.evidenceDigest.toLowerCase()
    || Number(journal.blockReferenceCount) !== artifact.blockReferenceCount
    || Number(journal.blockAuthenticationChunkSize) !== artifact.blockAuthenticationChunkSize
    || Number(journal.blockAuthenticationChunkCount) !== artifact.blockAuthenticationChunkCount
    || journal.blockAuthenticationRoot.toLowerCase() !== artifact.blockAuthenticationRoot.toLowerCase()) {
    throw new Error(`${artifact.seller}: seller journal does not match artifact metadata`);
  }
}

function positiveInteger(raw) {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("authentication batch size must be a positive integer");
  return Number(raw);
}

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

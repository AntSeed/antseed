#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, ContractFactory, JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers";

const contractsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
const artifactPath = value("--artifact");
const rpcUrl = value("--rpc-url") ?? "http://127.0.0.1:8545";
if (!artifactPath || !args.includes("--submit-development")) {
  throw new Error("usage: submit-wash-trading-development-anvil.mjs --artifact seller-proof.json --rpc-url URL --submit-development");
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(rpcUrl)) {
  throw new Error("development seller proof submission is restricted to loopback RPC URLs");
}

const artifact = JSON.parse(await readFile(resolve(artifactPath), "utf8"));
validateArtifact(artifact);
const journal = decodeJournal(artifact.publicValues);
validateJournal(artifact, journal);
const provider = new JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork();
if (network.chainId !== 8_453n) throw new Error(`expected chain ID 8453, got ${network.chainId}`);
const signer = new Wallet(
  process.env.ANVIL_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider,
);
let nonce = await provider.getTransactionCount(signer.address, "pending");

const verifier = await deploy("WashTradingDevelopmentE2E.sol/WashTradingDevelopmentVerifier.json", [
  artifact.sellerProgramVKey,
  keccak256(artifact.publicValues),
  keccak256(artifact.proofBytes),
]);
const blockhashStore = await deploy("WashTradingDevelopmentE2E.sol/WashTradingDevelopmentBlockhashStore.json", []);
for (const chunk of artifact.blockAuthenticationChunks) {
  await (await blockhashStore.setBlockhashes(
    chunk.references.map((reference) => reference.number),
    chunk.references.map((reference) => reference.blockHash),
    { nonce: nonce++ },
  )).wait();
}
const registry = await deploy("AntseedWashTradingRegistry.sol/AntseedWashTradingRegistry.json", [
  await verifier.getAddress(),
  await verifier.VERIFIER_HASH(),
  await blockhashStore.getAddress(),
  artifact.sellerProgramVKey,
  journal.periodStartBlock,
  journal.periodEndBlock,
]);

const submissionReceipt = await (await registry.stageSellerProof(
  artifact.publicValues,
  artifact.proofBytes,
  { nonce: nonce++ },
)).wait();
const proofId = keccak256(artifact.publicValues);
if (!await registry.proofStaged(proofId)) throw new Error("seller proof was not staged");
if (await registry.proofFinalized(proofId)) throw new Error("seller proof finalized before block authentication");
let authenticationGasUsed = 0n;
for (const chunk of artifact.blockAuthenticationChunks) {
  const receipt = await (await registry.authenticateBlockReferences(
    proofId,
    chunk.index,
    chunk.references,
    chunk.proof,
    { nonce: nonce++ },
  )).wait();
  authenticationGasUsed += receipt.gasUsed;
}
const finalizationReceipt = await (await registry.finalizeSellerProof(proofId, { nonce: nonce++ })).wait();

if (!await registry.proofFinalized(proofId)) throw new Error("seller proof was not finalized");
if (await registry.provenWashVolume(journal.seller) !== journal.provenWashVolume) {
  throw new Error("onchain wash volume mismatch");
}
if (await registry.sellerEvidenceDigest(journal.seller) !== journal.evidenceDigest) {
  throw new Error("onchain evidence digest mismatch");
}

console.log(`WASH_TRADING_DEVELOPMENT_RESULT=${JSON.stringify({
  registry: await registry.getAddress(),
  proofId,
  seller: journal.seller,
  provenWashVolumeRaw: journal.provenWashVolume.toString(),
  claimCount: artifact.claimCount,
  blockReferenceCount: Number(journal.blockReferenceCount),
  authenticatedBlockReferenceCount: Number(await registry.proofAuthenticatedBlockReferenceCount(proofId)),
  blockAuthenticationChunkCount: Number(journal.blockAuthenticationChunkCount),
  submissionGasUsed: submissionReceipt.gasUsed.toString(),
  authenticationGasUsed: authenticationGasUsed.toString(),
  finalizationGasUsed: finalizationReceipt.gasUsed.toString(),
  transactionMode: "staged-seller-proof-with-block-authentication",
})}`);

async function deploy(relativeArtifact, constructorArguments) {
  const compiled = JSON.parse(await readFile(resolve(contractsDirectory, "out", relativeArtifact), "utf8"));
  const factory = new ContractFactory(compiled.abi, compiled.bytecode.object, signer);
  const contract = await factory.deploy(...constructorArguments, { nonce: nonce++ });
  await contract.waitForDeployment();
  return contract;
}

function validateArtifact(candidate) {
  if (candidate?.version !== 3 || candidate.kind !== "antseed-wash-trading-seller-proof"
    || candidate.proofArchitecture !== "direct-seller-v1" || candidate.securityMode !== "development"
    || candidate.proved !== true || candidate.verified !== true) {
    throw new Error("artifact is not a development seller proof");
  }
  for (const field of ["sellerProgramVKey", "publicValues", "proofBytes"]) {
    if (!/^0x[0-9a-f]*$/i.test(candidate[field] ?? "")) throw new Error(`${field} is invalid`);
  }
  if (candidate.proofBytes === "0x") throw new Error("development proof bytes must be nonempty");
  if (!Array.isArray(candidate.blockAuthenticationChunks)
    || candidate.blockAuthenticationChunks.length !== candidate.blockAuthenticationChunkCount) {
    throw new Error("invalid block authentication chunks");
  }
}

function decodeJournal(publicValues) {
  const [journal] = AbiCoder.defaultAbiCoder().decode([
    "tuple(uint32 schemaVersion,uint64 chainId,uint64 periodStartBlock,uint64 periodEndBlock,address seller,uint128 provenWashVolume,bytes32 evidenceDigest,uint32 blockReferenceCount,uint32 blockAuthenticationChunkSize,uint32 blockAuthenticationChunkCount,bytes32 blockAuthenticationRoot)",
  ], publicValues);
  return {
    schemaVersion: journal.schemaVersion,
    chainId: journal.chainId,
    periodStartBlock: journal.periodStartBlock,
    periodEndBlock: journal.periodEndBlock,
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
  if (journal.schemaVersion !== 2n || journal.chainId !== 8_453n
    || journal.seller !== getAddress(artifact.seller)
    || journal.provenWashVolume.toString() !== artifact.provenWashVolumeRaw
    || journal.evidenceDigest.toLowerCase() !== artifact.evidenceDigest.toLowerCase()
    || Number(journal.blockReferenceCount) !== artifact.blockReferenceCount
    || Number(journal.blockAuthenticationChunkSize) !== artifact.blockAuthenticationChunkSize
    || Number(journal.blockAuthenticationChunkCount) !== artifact.blockAuthenticationChunkCount
    || journal.blockAuthenticationRoot.toLowerCase() !== artifact.blockAuthenticationRoot.toLowerCase()) {
    throw new Error("seller journal does not match artifact metadata");
  }
}

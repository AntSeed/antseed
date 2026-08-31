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
const calldataArtifactPath = value("--calldata-artifact");
const rpcUrl = value("--rpc-url") ?? "http://127.0.0.1:8545";
if (!artifactPath || !calldataArtifactPath || !args.includes("--submit-development")) {
  throw new Error("usage: submit-wash-trading-development-anvil.mjs --artifact aggregate.json --calldata-artifact calldata.json --rpc-url URL --submit-development");
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(rpcUrl)) {
  throw new Error("development aggregate submission is restricted to loopback RPC URLs");
}

const artifact = JSON.parse(await readFile(resolve(artifactPath), "utf8"));
validateArtifact(artifact);
const calldataArtifact = JSON.parse(await readFile(resolve(calldataArtifactPath), "utf8"));
validateCalldataArtifact(calldataArtifact, artifact);
const journal = decodeJournal(artifact.publicValues);
const provider = new JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork();
if (network.chainId !== 8_453n) throw new Error(`expected chain ID 8453, got ${network.chainId}`);
const signer = new Wallet(
  process.env.ANVIL_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider,
);
let nonce = await provider.getTransactionCount(signer.address, "pending");

const verifier = await deploy("WashTradingDevelopmentE2E.sol/WashTradingDevelopmentVerifier.json", [
  artifact.aggregatorProgramVKey,
  keccak256(artifact.publicValues),
  keccak256(artifact.proofBytes),
]);
const registry = await deploy("AntseedWashTradingRegistry.sol/AntseedWashTradingRegistry.json", [
  await verifier.getAddress(),
  artifact.aggregatorProgramVKey,
  journal.reportRoot,
  journal.manifestDigest,
  journal.periodStartBlock,
  journal.periodEndBlock,
  journal.sourceClaimCount,
  journal.sellers.length,
  journal.totalProvenWashVolume,
]);

const submissionReceipt = await (await signer.sendTransaction({
  to: await registry.getAddress(),
  data: calldataArtifact.calldata,
  nonce: nonce++,
})).wait();

if (!await registry.historicalResultSubmitted()) throw new Error("historical snapshot was not finalized");
if (await registry.totalProvenWashVolume() !== journal.totalProvenWashVolume) {
  throw new Error("historical total wash volume mismatch");
}
for (const result of journal.sellers) {
  if (await registry.provenWashVolume(result.seller) !== result.provenWashVolume) {
    throw new Error(`seller ${result.seller} volume mismatch`);
  }
  if (!await registry.isProvenWashTrader(result.seller)) {
    throw new Error(`seller ${result.seller} was not marked as proven`);
  }
}

let replayRejected = false;
try {
  await registry.submitHistoricalAggregate.staticCall(artifact.publicValues, artifact.proofBytes);
} catch {
  replayRejected = true;
}
if (!replayRejected) throw new Error("historical snapshot replay was accepted");

let alteredRejected = false;
try {
  const replacementByte = artifact.publicValues.endsWith("00") ? "01" : "00";
  const alteredValues = `${artifact.publicValues.slice(0, -2)}${replacementByte}`;
  const secondRegistry = await deploy("AntseedWashTradingRegistry.sol/AntseedWashTradingRegistry.json", [
    await verifier.getAddress(),
    artifact.aggregatorProgramVKey,
    journal.reportRoot,
    journal.manifestDigest,
    journal.periodStartBlock,
    journal.periodEndBlock,
    journal.sourceClaimCount,
    journal.sellers.length,
    journal.totalProvenWashVolume,
  ]);
  await secondRegistry.submitHistoricalAggregate.staticCall(alteredValues, artifact.proofBytes);
} catch {
  alteredRejected = true;
}
if (!alteredRejected) throw new Error("altered development public values were accepted");

console.log(`WASH_TRADING_DEVELOPMENT_RESULT=${JSON.stringify({
  registry: await registry.getAddress(),
  verifier: await verifier.getAddress(),
  childCount: artifact.childCount,
  sourceClaimCount: Number(journal.sourceClaimCount),
  sellerCount: journal.sellers.length,
  totalProvenWashVolumeRaw: journal.totalProvenWashVolume.toString(),
  blockReferenceCount: Number(journal.blockReferenceCount),
  gasUsed: submissionReceipt.gasUsed.toString(),
  transactionMode: "single-historical-aggregate",
})}`);

async function deploy(relativeArtifact, constructorArguments) {
  const compiled = JSON.parse(await readFile(resolve(contractsDirectory, "out", relativeArtifact), "utf8"));
  const factory = new ContractFactory(compiled.abi, compiled.bytecode.object, signer);
  const contract = await factory.deploy(...constructorArguments, { nonce: nonce++ });
  await contract.waitForDeployment();
  return contract;
}

function validateArtifact(candidate) {
  if (candidate?.kind !== "antseed-wash-trading-aggregate-proof" || candidate.securityMode !== "development") {
    throw new Error("artifact is not a development aggregate proof");
  }
  for (const field of ["aggregatorProgramVKey", "publicValues", "proofBytes"]) {
    if (!/^0x[0-9a-f]*$/i.test(candidate[field] ?? "")) throw new Error(`${field} is invalid`);
  }
  if (candidate.proofBytes === "0x") throw new Error("development proof bytes must be nonempty");
}

function validateCalldataArtifact(candidate, aggregate) {
  if (
    candidate?.kind !== "antseed-wash-trading-submit-historical-aggregate-calldata"
      || candidate.callSignature !== "submitHistoricalAggregate(bytes,bytes)"
      || candidate.calldata?.slice(0, 10).toLowerCase() !== "0x2a64a7e6"
      || candidate.aggregatorProgramId?.toLowerCase() !== aggregate.aggregatorProgramId.toLowerCase()
      || candidate.aggregatorProgramVKey?.toLowerCase() !== aggregate.aggregatorProgramVKey.toLowerCase()
      || candidate.publicValues?.toLowerCase() !== aggregate.publicValues.toLowerCase()
      || candidate.proofBytes?.toLowerCase() !== aggregate.proofBytes.toLowerCase()
  ) {
    throw new Error("calldata artifact does not match the aggregate proof");
  }
}

function decodeJournal(publicValues) {
  const [journal] = AbiCoder.defaultAbiCoder().decode([
    "tuple(uint32 schemaVersion,uint64 chainId,bytes32 reportRoot,bytes32 manifestDigest,uint64 periodStartBlock,uint64 periodEndBlock,uint32 sourceClaimCount,tuple(address seller,uint128 provenWashVolume)[] sellers,uint128 totalProvenWashVolume,uint32 blockReferenceCount)",
  ], publicValues);
  if (journal.schemaVersion !== 1n || journal.chainId !== 8_453n || journal.sellers.length === 0) {
    throw new Error("aggregate journal identity mismatch");
  }
  return {
    schemaVersion: journal.schemaVersion,
    chainId: journal.chainId,
    reportRoot: journal.reportRoot,
    manifestDigest: journal.manifestDigest,
    periodStartBlock: journal.periodStartBlock,
    periodEndBlock: journal.periodEndBlock,
    sourceClaimCount: journal.sourceClaimCount,
    sellers: journal.sellers.map((result) => ({
      seller: getAddress(result.seller),
      provenWashVolume: result.provenWashVolume,
    })),
    totalProvenWashVolume: journal.totalProvenWashVolume,
    blockReferenceCount: journal.blockReferenceCount,
  };
}

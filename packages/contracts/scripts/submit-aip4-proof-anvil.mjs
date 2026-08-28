#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ContractFactory, JsonRpcProvider, Wallet, getAddress } from "ethers";
import {
  computeBatchCommitments,
  computeExpectedBatchDigest,
  isLoopbackRpcUrl,
  runSubmission,
  validateManifest,
} from "./submit-wash-trading-proofs.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const manifestPath = value("--manifest");
  const rpcUrl = value("--rpc-url") ?? "http://127.0.0.1:8545";
  if (!manifestPath || !args.includes("--submit-local") || !isLoopbackRpcUrl(rpcUrl)) {
    throw new Error("usage: submit-aip4-proof-anvil.mjs --manifest result.json --rpc-url http://127.0.0.1:8545 --submit-local");
  }

  const sourceManifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  validateManifest(sourceManifest);
  if (sourceManifest.securityMode !== "development"
      || sourceManifest.entries.some((entry) => !new Set(["P0_CLOSED_LOOP", "P0_RECIPROCAL"]).has(entry.claimType))) {
    throw new Error("local P0 E2E requires development P0 proof artifacts");
  }

  const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await promisify(execFile)("forge", ["build", "--silent"], { cwd: contractsDir });
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 8_453n) throw new Error(`expected Anvil chain ID 8453, got ${network.chainId}`);
  const signer = new Wallet(
    process.env.ANVIL_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    provider,
  );
  let nextNonce = await provider.getTransactionCount(signer.address, "pending");

  const deploy = async (relativeArtifactPath, constructorArguments) => {
    const artifact = JSON.parse(await readFile(resolve(contractsDir, relativeArtifactPath), "utf8"));
    const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
    const contract = await factory.deploy(...constructorArguments, { nonce: nextNonce++ });
    await contract.waitForDeployment();
    return contract;
  };
  const verifier = await deploy("out/LocalProofE2E.sol/LocalProofE2EVerifier.json", []);
  const blockhashStore = await deploy("out/LocalProofE2E.sol/LocalProofE2EBlockhashStore.json", []);
  const manifest = prepareLocalManifest(sourceManifest, await blockhashStore.getAddress());
  const registry = await deploy("out/AntseedWashTradingRegistry.sol/AntseedWashTradingRegistry.json", [
    await verifier.getAddress(),
    await blockhashStore.getAddress(),
    manifest.batch.closedLoopVKey,
    manifest.batch.reciprocalVKey,
    manifest.batch.expectedBatchCount,
    manifest.batch.expectedBatchDigest,
  ]);

  const canonicalBlocks = new Map();
  for (const reference of manifest.entries.flatMap((entry) => entry.blockReferences)) {
    const prior = canonicalBlocks.get(reference.number);
    if (prior && prior.toLowerCase() !== reference.blockHash.toLowerCase()) {
      throw new Error(`conflicting block hash for ${reference.number}`);
    }
    canonicalBlocks.set(reference.number, reference.blockHash);
  }
  for (const [number, blockHash] of canonicalBlocks) {
    await (await blockhashStore.setCanonical(number, blockHash, { nonce: nextNonce++ })).wait();
  }
  for (const entry of manifest.entries) {
    await (await verifier.expect(entry.programVKey, entry.journalDigest, { nonce: nextNonce++ })).wait();
  }

  console.log(`verifier ${await verifier.getAddress()}`);
  console.log(`blockhash store ${await blockhashStore.getAddress()}`);
  console.log(`registry ${await registry.getAddress()}`);
  const submission = {
    manifest,
    registryAddress: await registry.getAddress(),
    rpcUrl,
    submit: true,
    privateKey: signer.privateKey,
    allowDevelopmentOnLoopback: true,
  };
  const results = await runSubmission(submission);
  for (const result of results) {
    console.log(`${result.status}${result.transactionHash ? ` ${result.transactionHash}` : ""}`);
  }
  const replay = await runSubmission(submission);
  if (replay[0]?.status !== "already-complete") throw new Error("P0 batch replay was not idempotent");
  console.log("already-complete");

  for (const subject of new Set(manifest.entries.flatMap((entry) => entry.subjects.map((value) => getAddress(value))))) {
    if (!await registry.isSellerWashTradingFlagged(subject)) throw new Error(`${subject} was not flagged`);
    const record = await registry.washRecords(subject);
    if (record.washVolume === 0n) throw new Error(`${subject} has an empty wash record`);
    console.log(`flagged ${subject} ${record.washVolume}/${record.settledVolume}`);
  }
}

export function prepareLocalManifest(sourceManifest, blockhashStore) {
  const manifest = structuredClone(sourceManifest);
  manifest.batch.blockhashStore = getAddress(blockhashStore);
  manifest.batch.commitments = computeBatchCommitments(manifest.entries);
  manifest.batch.expectedBatchCount = manifest.entries.length;
  manifest.batch.expectedBatchDigest = computeExpectedBatchDigest({
    chainId: manifest.chainId,
    closedLoopVKey: manifest.batch.closedLoopVKey,
    reciprocalVKey: manifest.batch.reciprocalVKey,
    blockhashStore: manifest.batch.blockhashStore,
    commitments: manifest.batch.commitments,
  });
  validateManifest(manifest);
  return manifest;
}

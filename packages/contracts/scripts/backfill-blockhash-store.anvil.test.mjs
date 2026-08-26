import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  encodeRlp,
  keccak256,
  sha256,
  toUtf8Bytes,
} from "ethers";
import { runBackfill } from "./backfill-blockhash-store.mjs";
import {
  computeBatchCommitments,
  computeExpectedBatchDigest,
  runSubmission,
} from "./submit-wash-trading-proofs.mjs";

const exec = promisify(execFile);
const BASE_BLOCKHASH_STORE = "0x78b69899C8cD252126cBB1A50171ec37286C3877";
const ANVIL_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BLOCKHASH_STORE_ABI = [
  "function getBlockhash(uint256 blockNumber) view returns (bytes32)",
  "function store(uint256 blockNumber)",
  "function storeVerifyHeader(uint256 blockNumber,bytes header)",
];
const WASH_JOURNAL = "tuple(uint8 predicateId,uint64 chainId,uint64 periodStartBlock,uint64 periodEndBlock,bytes32 claimId,tuple(address subject,uint128 washVolume,uint128 settledVolume)[] subjects,tuple(uint64 number,bytes32 blockHash)[] blockRefs)";
const BASE_FORK_BLOCK = 50_473_707;
const BASE_FORK_ANCHOR = 49_946_172;
const BASE_FORK_TARGET = BASE_FORK_ANCHOR - 1;

test("Anvil exposes unnecessary writes across an existing BlockhashStore anchor", { timeout: 60_000 }, async (context) => {
  const port = await availablePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = execFile("anvil", ["--port", String(port), "--chain-id", "8453", "--silent"]);
  context.after(() => anvil.kill("SIGTERM"));
  await waitForRpc(rpcUrl);

  const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
  const fixtureRoot = resolve(scriptsDirectory, "fixtures/blockhash-store");
  const buildRoot = await mkdtemp(resolve(tmpdir(), "antseed-blockhash-store-"));
  context.after(() => rm(buildRoot, { recursive: true, force: true }));
  const outDirectory = resolve(buildRoot, "out");
  await exec("forge", [
    "build",
    "--root", fixtureRoot,
    "--out", outDirectory,
    "--cache-path", resolve(buildRoot, "cache"),
    "--use", "0.8.24",
    "--silent",
  ]);
  const artifact = JSON.parse(await readFile(
    resolve(outDirectory, "LocalBlockhashStore.sol/LocalBlockhashStore.json"),
    "utf8",
  ));

  const provider = new JsonRpcProvider(rpcUrl);
  const deployedBytecode = withHexPrefix(artifact.deployedBytecode.object);
  await provider.send("anvil_setCode", [BASE_BLOCKHASH_STORE, deployedBytecode]);
  await provider.send("anvil_mine", ["0x0f"]);

  const headers = [];
  for (let blockNumber = 3; blockNumber <= 12; blockNumber += 1) {
    headers.push(await blockHeader(provider, blockNumber));
  }

  const signer = new Wallet(ANVIL_PRIVATE_KEY, provider);
  const store = new Contract(BASE_BLOCKHASH_STORE, BLOCKHASH_STORE_ABI, signer);
  await (await store.store(6, { nonce: 0 })).wait();
  await (await store.store(12, { nonce: 1 })).wait();

  const manifest = manifestWithRefs([
    { number: "3", blockHash: headers[0].hash },
    { number: "10", blockHash: headers[7].hash },
  ]);
  const planned = await runBackfill({ manifest, headers, rpcUrl });

  assert.equal(planned.status, "planned");
  assert.equal(planned.transactionCount, 8);
  assert.deepEqual(
    planned.plan.map((step) => Number(step.blockNumber)),
    [11, 10, 9, 8, 7, 5, 4, 3],
  );
  assert.deepEqual(
    planned.plan.filter((step) => !step.required).map((step) => Number(step.blockNumber)),
    [11, 9, 8, 7, 5, 4],
  );

  const submitted = await runBackfill({
    manifest,
    headers,
    rpcUrl,
    submit: true,
    privateKey: ANVIL_PRIVATE_KEY,
  });
  assert.equal(submitted.transactionCount, 8);
  assert.equal((await store.getBlockhash(3)).toLowerCase(), headers[0].hash);
  assert.equal((await store.getBlockhash(10)).toLowerCase(), headers[7].hash);
  for (const unnecessaryBlock of [7, 8, 9]) {
    assert.equal(
      (await store.getBlockhash(unnecessaryBlock)).toLowerCase(),
      headers[unnecessaryBlock - 3].hash,
    );
  }
});

test("forked Base backfills a real missing block through the deployed BlockhashStore", {
  timeout: 60_000,
  skip: !process.env.BASE_MAINNET_RPC_URL,
}, async (context) => {
  const port = await availablePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = execFile("anvil", [
    "--fork-url", process.env.BASE_MAINNET_RPC_URL,
    "--fork-block-number", String(BASE_FORK_BLOCK),
    "--port", String(port),
    "--silent",
  ]);
  context.after(() => anvil.kill("SIGTERM"));
  await waitForRpc(rpcUrl);

  const provider = new JsonRpcProvider(rpcUrl);
  const store = new Contract(BASE_BLOCKHASH_STORE, BLOCKHASH_STORE_ABI, provider);
  assert.equal(await storedHashOrNull(store, BASE_FORK_TARGET), null);

  const headers = await Promise.all([
    blockHeader(provider, BASE_FORK_TARGET),
    blockHeader(provider, BASE_FORK_ANCHOR),
  ]);
  assert.equal(
    (await store.getBlockhash(BASE_FORK_ANCHOR)).toLowerCase(),
    headers[1].hash,
  );

  const manifest = manifestWithRefs([
    { number: String(BASE_FORK_TARGET), blockHash: headers[0].hash },
  ]);
  const submitted = await runBackfill({
    manifest,
    headers,
    rpcUrl,
    submit: true,
    privateKey: ANVIL_PRIVATE_KEY,
  });

  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.transactionCount, 1);
  assert.equal(
    (await store.getBlockhash(BASE_FORK_TARGET)).toLowerCase(),
    headers[0].hash,
  );
});

test("Anvil backfills canonical blocks before production-shaped proof submission", { timeout: 120_000 }, async (context) => {
  const port = await availablePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = execFile("anvil", ["--port", String(port), "--chain-id", "8453", "--gas-limit", "1000000000", "--silent"]);
  context.after(() => anvil.kill("SIGTERM"));
  await waitForRpc(rpcUrl);

  const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
  const contractsDirectory = resolve(scriptsDirectory, "..");
  const buildRoot = await mkdtemp(resolve(tmpdir(), "antseed-aip4-e2e-"));
  context.after(() => rm(buildRoot, { recursive: true, force: true }));
  const contractsOut = resolve(buildRoot, "contracts-out");
  const fixtureOut = resolve(buildRoot, "fixture-out");
  await Promise.all([
    exec("forge", [
      "build",
      "--root", contractsDirectory,
      "--out", contractsOut,
      "--cache-path", resolve(buildRoot, "contracts-cache"),
      resolve(contractsDirectory, "test/mocks/LocalProofE2E.sol"),
      resolve(contractsDirectory, "integrity/AntseedWashTradingRegistry.sol"),
      resolve(contractsDirectory, "policies/AntseedWashTradingPointsPolicy.sol"),
      resolve(contractsDirectory, "policies/AntseedWashTradingRewardPolicy.sol"),
      "--silent",
    ]),
    exec("forge", [
      "build",
      "--root", resolve(scriptsDirectory, "fixtures/blockhash-store"),
      "--out", fixtureOut,
      "--cache-path", resolve(buildRoot, "fixture-cache"),
      "--use", "0.8.24",
      "--silent",
    ]),
  ]);

  const [storeArtifact, verifierArtifact, registryArtifact, pointsPolicyArtifact, rewardPolicyArtifact] = await Promise.all([
    readArtifact(fixtureOut, "LocalBlockhashStore.sol/LocalBlockhashStore.json"),
    readArtifact(contractsOut, "LocalProofE2E.sol/LocalProofE2EVerifier.json"),
    readArtifact(contractsOut, "AntseedWashTradingRegistry.sol/AntseedWashTradingRegistry.json"),
    readArtifact(contractsOut, "AntseedWashTradingPointsPolicy.sol/AntseedWashTradingPointsPolicy.json"),
    readArtifact(contractsOut, "AntseedWashTradingRewardPolicy.sol/AntseedWashTradingRewardPolicy.json"),
  ]);

  const provider = new JsonRpcProvider(rpcUrl);
  await provider.send("anvil_setCode", [BASE_BLOCKHASH_STORE, withHexPrefix(storeArtifact.deployedBytecode.object)]);
  await provider.send("anvil_mine", ["0x0f"]);
  const headers = await Promise.all([10, 11, 12].map((blockNumber) => blockHeader(provider, blockNumber)));

  const signer = new Wallet(ANVIL_PRIVATE_KEY, provider);
  const store = new Contract(BASE_BLOCKHASH_STORE, BLOCKHASH_STORE_ABI, signer);
  await (await store.store(12, { nonce: 0 })).wait();
  let nextNonce = 1;
  const deploy = async (artifact, constructorArguments) => {
    const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
    const contract = await factory.deploy(...constructorArguments, { nonce: nextNonce++ });
    await contract.waitForDeployment();
    return contract;
  };

  const verifier = await deploy(verifierArtifact, []);
  const manifest = productionManifest(headers[0]);
  const registry = await deploy(registryArtifact, [
    await verifier.getAddress(),
    BASE_BLOCKHASH_STORE,
    manifest.batch.closedLoopVKey,
    manifest.batch.reciprocalVKey,
    manifest.batch.expectedBatchCount,
    manifest.batch.expectedBatchDigest,
  ]);
  const pointsPolicy = await deploy(pointsPolicyArtifact, [await registry.getAddress()]);
  const rewardPolicy = await deploy(rewardPolicyArtifact, [await registry.getAddress()]);
  const submission = {
    manifest,
    registryAddress: await registry.getAddress(),
    rpcUrl,
    pointsPolicyAddress: await pointsPolicy.getAddress(),
    rewardPolicyAddress: await rewardPolicy.getAddress(),
  };

  await assert.rejects(runSubmission(submission), /blockhash not found|execution reverted/i);
  assert.equal(await registry.backfillComplete(), false);

  const initialPlan = await runBackfill({ manifest, headers, rpcUrl });
  assert.deepEqual(initialPlan.plan.map((step) => Number(step.blockNumber)), [11, 10]);
  await (await store.storeVerifyHeader(11, headers[2].rlp, { nonce: nextNonce++ })).wait();

  const resumedPlan = await runBackfill({ manifest, headers, rpcUrl });
  assert.deepEqual(resumedPlan.plan.map((step) => Number(step.blockNumber)), [10]);
  const backfill = await runBackfill({
    manifest,
    headers,
    rpcUrl,
    submit: true,
    privateKey: ANVIL_PRIVATE_KEY,
  });
  assert.equal(backfill.status, "submitted");
  assert.equal(backfill.transactionCount, 1);
  assert.equal((await store.getBlockhash(10)).toLowerCase(), headers[0].hash);

  await assert.rejects(runSubmission(submission), /unexpected proof/i);
  assert.equal(await registry.backfillComplete(), false);
  nextNonce = Number(BigInt(await provider.send("eth_getTransactionCount", [signer.address, "pending"])));
  await (await verifier.expect(manifest.entries[0].programVKey, manifest.entries[0].journalDigest, { nonce: nextNonce++ })).wait();

  const simulated = await runSubmission(submission);
  assert.equal(simulated[0].status, "simulated");
  const submitted = await runSubmission({ ...submission, submit: true, privateKey: ANVIL_PRIVATE_KEY });
  assert.equal(submitted[0].status, "submitted");
  assert.equal(await registry.backfillComplete(), true);
  assert.equal(await registry.claimJournalDigest(manifest.entries[0].claimId), manifest.entries[0].journalDigest);
  assert.equal((await registry.washRecords(manifest.entries[0].subjects[0])).washVolume, 2_500_000n);

  const replay = await runSubmission({ ...submission, submit: true, privateKey: ANVIL_PRIVATE_KEY });
  assert.equal(replay[0].status, "already-complete");
});

async function blockHeader(provider, blockNumber) {
  const block = await provider.send("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
  const fields = [
    block.parentHash,
    block.sha3Uncles,
    block.miner,
    block.stateRoot,
    block.transactionsRoot,
    block.receiptsRoot,
    block.logsBloom,
    rlpQuantity(block.difficulty),
    rlpQuantity(block.number),
    rlpQuantity(block.gasLimit),
    rlpQuantity(block.gasUsed),
    rlpQuantity(block.timestamp),
    block.extraData,
    block.mixHash,
    block.nonce,
  ];
  for (const field of [
    block.baseFeePerGas == null ? null : rlpQuantity(block.baseFeePerGas),
    block.withdrawalsRoot,
    block.blobGasUsed == null ? null : rlpQuantity(block.blobGasUsed),
    block.excessBlobGas == null ? null : rlpQuantity(block.excessBlobGas),
    block.parentBeaconBlockRoot,
    block.requestsHash,
  ]) {
    if (field != null) fields.push(field);
  }
  const rlp = encodeRlp(fields);
  assert.equal(keccak256(rlp).toLowerCase(), block.hash.toLowerCase());
  return { number: String(blockNumber), hash: block.hash.toLowerCase(), rlp };
}

function manifestWithRefs(blockReferences) {
  return {
    version: 2,
    kind: "antseed-wash-trading-proof-results",
    batch: { blockhashStore: BASE_BLOCKHASH_STORE },
    entries: blockReferences.map((reference, index) => ({
      claimId: `0x${String(index + 1).padStart(64, "0")}`,
      blockReferences: [reference],
    })),
  };
}

function productionManifest(blockHeaderReference) {
  const claimId = keccak256(toUtf8Bytes("anvil-production-shaped-claim"));
  const subject = "0x0000000000000000000000000000000000000010";
  const closedLoopVKey = keccak256(toUtf8Bytes("anvil-closed-loop-vkey"));
  const reciprocalVKey = keccak256(toUtf8Bytes("anvil-reciprocal-vkey"));
  const journalBytes = AbiCoder.defaultAbiCoder().encode([WASH_JOURNAL], [[
    1,
    8_453,
    44_471_575,
    49_936_172,
    claimId,
    [[subject, 2_500_000n, 10_000_000n]],
    [[BigInt(blockHeaderReference.number), blockHeaderReference.hash]],
  ]]);
  const entries = [{
    claimId,
    sourceClaimId: null,
    claimType: "P0_CLOSED_LOOP",
    subjects: [subject],
    metrics: {
      qualifiedVolumeRaw: "2500000",
      journalWashVolumeRaw: "2500000",
      authenticatedReceiptVolumeRaw: "2500000",
    },
    programVKey: closedLoopVKey,
    journalBytes,
    journalDigest: sha256(journalBytes),
    proofBytes: "0x01",
    blockReferences: [{ number: blockHeaderReference.number, blockHash: blockHeaderReference.hash }],
    instructionCount: 1,
  }];
  const commitments = computeBatchCommitments(entries);
  return {
    version: 2,
    kind: "antseed-wash-trading-proof-results",
    chainId: 8_453,
    securityMode: "production",
    batch: {
      domain: keccak256(toUtf8Bytes("ANTSEED_AIP4_BACKFILL_V1")),
      blockhashStore: BASE_BLOCKHASH_STORE,
      closedLoopVKey,
      reciprocalVKey,
      expectedBatchCount: entries.length,
      expectedBatchDigest: computeExpectedBatchDigest({
        closedLoopVKey,
        reciprocalVKey,
        blockhashStore: BASE_BLOCKHASH_STORE,
        commitments,
      }),
      commitments,
    },
    entries,
  };
}

function rlpQuantity(value) {
  const number = BigInt(value);
  if (number === 0n) return "0x";
  const hex = number.toString(16);
  return `0x${hex.length % 2 === 0 ? hex : `0${hex}`}`;
}

async function storedHashOrNull(store, blockNumber) {
  try {
    return await store.getBlockhash(blockNumber);
  } catch {
    return null;
  }
}

async function readArtifact(outDirectory, relativePath) {
  return JSON.parse(await readFile(resolve(outDirectory, relativePath), "utf8"));
}

function withHexPrefix(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  return address.port;
}

async function waitForRpc(rpcUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch { }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Anvil did not start");
}

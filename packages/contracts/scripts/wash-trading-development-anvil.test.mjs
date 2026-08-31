import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const contractsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.LOOP_PROOF_DIR) {
  throw new Error("LOOP_PROOF_DIR must point to the loop-proof checkout");
}
const proofDirectory = resolve(process.env.LOOP_PROOF_DIR);

test("complete 26-claim development aggregate submits end-to-end on Anvil", { timeout: 900_000 }, async (context) => {
  const artifact = resolve(proofDirectory, "out", "approved-development-proofs", "aggregate-proof.json");
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "antseed-wash-development-"));
  const calldataArtifact = resolve(outputDirectory, "submit-historical-aggregate-calldata.json");
  await run("node", [
    "scripts/generate-aggregate-calldata.mjs",
    "--aggregate", artifact,
    "--output", calldataArtifact,
  ], proofDirectory);
  const generated = JSON.parse(await readFile(artifact, "utf8"));
  const generatedCalldata = JSON.parse(await readFile(calldataArtifact, "utf8"));
  assert.equal(generated.securityMode, "development");
  assert.equal(generated.childCount, 26);
  assert.equal(generated.sourceClaimCount, 26);
  assert.equal(generated.sellerCount, 50);
  assert.equal(generated.provenWashVolumeRaw, "76636051035");
  assert.equal(generatedCalldata.callSignature, "submitHistoricalAggregate(bytes,bytes)");
  assert.equal(generatedCalldata.calldata.slice(0, 10), "0x2a64a7e6");

  await run("forge", [
    "build",
    "integrity/AntseedWashTradingRegistry.sol",
    "test/mocks/WashTradingDevelopmentE2E.sol",
  ], contractsDirectory);

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--chain-id", "8453", "--port", String(port), "--silent"], {
    cwd: contractsDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => anvil.kill("SIGTERM"));
  await waitForRpc(rpcUrl, anvil);

  const output = await run("node", [
    "scripts/submit-wash-trading-development-anvil.mjs",
    "--artifact", artifact,
    "--calldata-artifact", calldataArtifact,
    "--rpc-url", rpcUrl,
    "--submit-development",
  ], contractsDirectory);
  const marker = "WASH_TRADING_DEVELOPMENT_RESULT=";
  const resultLine = output.split("\n").find((line) => line.startsWith(marker));
  assert.ok(resultLine, `missing development result in output:\n${output}`);
  const result = JSON.parse(resultLine.slice(marker.length));
  assert.equal(result.childCount, 26);
  assert.equal(result.sourceClaimCount, 26);
  assert.equal(result.sellerCount, 50);
  assert.equal(result.totalProvenWashVolumeRaw, "76636051035");
  assert.ok(BigInt(result.gasUsed) > 0n);
  assert.equal(result.transactionMode, "single-historical-aggregate");
});

async function waitForRpc(rpcUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}`);
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
  throw new Error("anvil did not become ready");
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "1.94" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolveRun(stdout)
      : reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${stdout}\n${stderr}`)));
  });
}

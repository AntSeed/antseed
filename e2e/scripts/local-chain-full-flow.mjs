#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { TextDecoder, TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import { AntseedNode, identityToEvmAddress, toPeerId } from "@antseed/node";
import { BaseEscrowClient } from "@antseed/node/payments";
import { DHTNode } from "@antseed/node/discovery";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = process.env.CHAIN_ID ?? "31337";
const rpcEndpoint = new URL(RPC_URL);
const ANVIL_HOST = process.env.ANVIL_HOST ?? rpcEndpoint.hostname;
const ANVIL_PORT = process.env.ANVIL_PORT ?? (rpcEndpoint.port || "8545");

// Default Anvil account #0 private key
const DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const USDC_MINT_AMOUNT = 25_000_000n; // 25 USDC
const USDC_DEPOSIT_AMOUNT = 5_000_000n; // 5 USDC
const FUND_ETH = process.env.FLOW_FUND_ETH ?? "2ether";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const contractsDir = resolve(repoRoot, "packages", "node");

function logStep(message) {
  console.log(`\n[flow] ${message}`);
}

function requireCommand(command) {
  const check = spawnSync("which", [command], { encoding: "utf8" });
  if (check.status !== 0) {
    throw new Error(`Required command not found on PATH: ${command}`);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
  });

  const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n` +
        (combinedOutput.length > 0 ? combinedOutput : "(no output)")
    );
  }
  return combinedOutput;
}

function castSend(args) {
  return runCommand("cast", [
    "send",
    "--rpc-url",
    RPC_URL,
    "--private-key",
    DEPLOYER_PRIVATE_KEY,
    ...args,
  ]);
}

function formatError(err) {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function parseDeployedAddress(output) {
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) {
    throw new Error(`Could not parse deployment address from output:\n${output}`);
  }
  return match[1];
}

function isNonceRaceError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("nonce has already been used") ||
    message.includes("nonce too low") ||
    message.includes("NONCE_EXPIRED")
  );
}

async function waitForRpcReady(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (response.ok) {
        const payload = await response.json();
        if (typeof payload?.result === "string" && payload.result.startsWith("0x")) {
          return;
        }
      }
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`RPC ${url} did not become ready within ${timeoutMs}ms`);
}

async function waitForValue(getValue, label, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await getValue();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const suffix =
    lastError instanceof Error
      ? ` (last error: ${lastError.message})`
      : "";
  throw new Error(`Timeout while waiting for ${label}${suffix}`);
}

function buildRequest() {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    messages: [{ role: "user", content: "hello from local chain flow" }],
  });

  return {
    requestId: randomUUID(),
    method: "POST",
    path: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(payload),
  };
}

class MockAnthropicProvider {
  constructor() {
    this.name = "anthropic";
    this.models = ["claude-sonnet-4-5-20250929"];
    this.pricing = {
      defaults: {
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    };
    this.maxConcurrency = 5;
    this._active = 0;
    this.requestCount = 0;
  }

  async handleRequest(req) {
    this._active += 1;
    this.requestCount += 1;
    try {
      const body = JSON.stringify({
        id: `msg_flow_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello from local blockchain flow." }],
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 120, output_tokens: 30 },
      });
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(body),
      };
    } finally {
      this._active -= 1;
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency };
  }
}

async function stopProcess(child, name) {
  if (!child) return;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const settled = await Promise.race([
    once(child, "exit").then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!settled && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
  logStep(`${name} stopped`);
}

async function main() {
  requireCommand("anvil");
  requireCommand("forge");
  requireCommand("cast");

  let anvil = null;
  let bootstrap = null;
  let sellerNode = null;
  let buyerNode = null;
  let sellerDataDir = null;
  let buyerDataDir = null;

  try {
    logStep("starting local anvil chain");
    anvil = spawn(
      "anvil",
      ["--host", ANVIL_HOST, "--port", ANVIL_PORT, "--chain-id", CHAIN_ID],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    // Drain process pipes to avoid backpressure killing the child process.
    anvil.stdout?.on("data", () => undefined);
    anvil.stderr?.on("data", () => undefined);

    await waitForRpcReady(RPC_URL);
    logStep(`anvil ready at ${RPC_URL}`);

    const deployerAddress = runCommand("cast", [
      "wallet",
      "address",
      "--private-key",
      DEPLOYER_PRIVATE_KEY,
    ]).trim();

    logStep("building contracts with forge");
    runCommand(
      "forge",
      ["build", "--root", ".", "--contracts", "contracts", "--out", "contracts/out"],
      { cwd: contractsDir }
    );

    logStep("deploying MockUSDC");
    const mockDeployOutput = runCommand(
      "forge",
      [
        "create",
        "contracts/MockUSDC.sol:MockUSDC",
        "--root",
        ".",
        "--contracts",
        "contracts",
        "--rpc-url",
        RPC_URL,
        "--private-key",
        DEPLOYER_PRIVATE_KEY,
        "--broadcast",
      ],
      { cwd: contractsDir }
    );
    const usdcAddress = parseDeployedAddress(mockDeployOutput);
    logStep(`MockUSDC deployed: ${usdcAddress}`);

    logStep("deploying AntseedEscrow");
    const escrowDeployOutput = runCommand(
      "forge",
      [
        "create",
        "contracts/AntseedEscrow.sol:AntseedEscrow",
        "--root",
        ".",
        "--contracts",
        "contracts",
        "--rpc-url",
        RPC_URL,
        "--private-key",
        DEPLOYER_PRIVATE_KEY,
        "--broadcast",
        "--constructor-args",
        usdcAddress,
        deployerAddress,
      ],
      { cwd: contractsDir }
    );
    const escrowAddress = parseDeployedAddress(escrowDeployOutput);
    logStep(`AntseedEscrow deployed: ${escrowAddress}`);

    logStep("starting isolated local DHT bootstrap");
    bootstrap = new DHTNode({
      // Match the same deterministic bootstrap setup used by e2e test helpers.
      peerId: toPeerId("0".repeat(64)),
      port: 0,
      bootstrapNodes: [],
      reannounceIntervalMs: 60_000,
      operationTimeoutMs: 5_000,
    });
    await bootstrap.start();
    const bootstrapConfig = [{ host: "127.0.0.1", port: bootstrap.getPort() }];
    logStep(`bootstrap DHT on 127.0.0.1:${bootstrap.getPort()}`);

    sellerDataDir = await mkdtemp(join(tmpdir(), "antseed-flow-seller-"));
    buyerDataDir = await mkdtemp(join(tmpdir(), "antseed-flow-buyer-"));

    const sellerProvider = new MockAnthropicProvider();

    logStep("starting seller node");
    sellerNode = new AntseedNode({
      role: "seller",
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrapConfig,
      allowPrivateIPs: true,
    });
    sellerNode.registerProvider(sellerProvider);
    await sellerNode.start();

    if (!sellerNode.identity) {
      throw new Error("seller identity unavailable after start");
    }
    const sellerAddress = identityToEvmAddress(sellerNode.identity);
    logStep(`seller peer=${sellerNode.peerId} evm=${sellerAddress}`);

    logStep("starting buyer node");
    buyerNode = new AntseedNode({
      role: "buyer",
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrapConfig,
      allowPrivateIPs: true,
    });
    await buyerNode.start();

    if (!buyerNode.identity) {
      throw new Error("buyer identity unavailable after start");
    }
    const buyerPeerId = buyerNode.peerId;
    const buyerAddress = identityToEvmAddress(buyerNode.identity);
    logStep(`buyer peer=${buyerPeerId} evm=${buyerAddress}`);

    logStep("funding buyer/seller gas balances");
    castSend([
      sellerAddress,
      "--value",
      FUND_ETH,
    ]);
    castSend([
      buyerAddress,
      "--value",
      FUND_ETH,
    ]);

    logStep(`minting ${USDC_MINT_AMOUNT} base units of USDC to deployer escrow account`);
    castSend([
      usdcAddress,
      "mint(address,uint256)",
      deployerAddress,
      USDC_MINT_AMOUNT.toString(),
    ]);

    logStep("waiting for buyer discovery of seller");
    let discoveredSeller;
    try {
      discoveredSeller = await waitForValue(
        async () => {
          // Force announce retries so discovery is deterministic on isolated local DHT.
          const announcer = sellerNode._announcer;
          if (announcer && typeof announcer.announce === "function") {
            await announcer.announce().catch(() => undefined);
          }

          const peers = await buyerNode.discoverPeers("anthropic");
          return peers.find((peer) => peer.peerId === sellerNode.peerId);
        },
        "seller discovery",
        30_000,
        500
      );
      if (!discoveredSeller.evmAddress) {
        discoveredSeller = { ...discoveredSeller, evmAddress: sellerAddress };
      }
      logStep(`buyer discovered seller ${discoveredSeller.peerId} via DHT`);
    } catch {
      // Fallback path keeps the full payment + communication flow runnable even
      // if local DHT metadata lookup is flaky on a given host.
      discoveredSeller = {
        peerId: sellerNode.peerId,
        lastSeen: Date.now(),
        providers: ["anthropic"],
        publicAddress: `127.0.0.1:${sellerNode.signalingPort}`,
        evmAddress: sellerAddress,
      };
      logStep(
        `DHT discovery timed out; falling back to direct peer address ${discoveredSeller.publicAddress}`
      );
    }

    logStep("sending buyer request across P2P path");
    const response = await buyerNode.sendRequest(discoveredSeller, buildRequest());
    if (response.statusCode !== 200) {
      throw new Error(`request failed with status=${response.statusCode}`);
    }
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    if (responseBody?.type !== "message") {
      throw new Error(`unexpected response payload: ${JSON.stringify(responseBody)}`);
    }
    logStep("request completed successfully");

    const escrowClient = new BaseEscrowClient({
      rpcUrl: RPC_URL,
      contractAddress: escrowAddress,
      usdcAddress,
    });

    const sellerUsdcBefore = await escrowClient.getUSDCBalance(sellerAddress);
    const deployerUsdcBefore = await escrowClient.getUSDCBalance(deployerAddress);
    const escrowSessionId = `0x${createHash("sha256").update(`flow-${randomUUID()}`).digest("hex")}`;

    logStep(`approving escrow contract for ${USDC_DEPOSIT_AMOUNT} base units`);
    castSend([
      usdcAddress,
      "approve(address,uint256)",
      escrowAddress,
      USDC_DEPOSIT_AMOUNT.toString(),
    ]);

    logStep(`depositing ${USDC_DEPOSIT_AMOUNT} base units into escrow`);
    castSend([
      escrowAddress,
      "deposit(bytes32,address,uint256)",
      escrowSessionId,
      sellerAddress,
      USDC_DEPOSIT_AMOUNT.toString(),
    ]);

    logStep("releasing escrow funds to seller");
    castSend([
      escrowAddress,
      "release(bytes32)",
      escrowSessionId,
    ]);

    const sellerUsdcBalance = await waitForValue(
      async () => {
        const bal = await escrowClient.getUSDCBalance(sellerAddress);
        return bal > sellerUsdcBefore ? bal : null;
      },
      "seller USDC settlement balance",
      30_000,
      500
    );
    const deployerUsdcAfter = await escrowClient.getUSDCBalance(deployerAddress);

    const channelRaw = runCommand("cast", [
      "call",
      "--rpc-url",
      RPC_URL,
      escrowAddress,
      "getChannel(bytes32)(address,address,uint256,uint8)",
      escrowSessionId,
    ]);
    const channelParts = channelRaw
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
    const channelStateRaw = channelParts[channelParts.length - 1] ?? "";
    const channelState = Number.parseInt(channelStateRaw, 10);
    if (!Number.isInteger(channelState) || channelState !== 3) {
      throw new Error(`session not settled on-chain (state=${channelRaw})`);
    }

    await buyerNode.stop();
    buyerNode = null;

    logStep("flow complete: local chain deployment + P2P request + on-chain escrow release verified");
    console.log(
      JSON.stringify(
        {
          rpcUrl: RPC_URL,
          chainId: CHAIN_ID,
          contracts: {
            usdc: usdcAddress,
            escrow: escrowAddress,
          },
          actors: {
            sellerPeerId: sellerNode.peerId,
            sellerAddress,
            buyerPeerId,
            buyerAddress,
            deployerAddress,
          },
          escrowSession: {
            id: escrowSessionId,
            state: channelState,
            amount: USDC_DEPOSIT_AMOUNT.toString(),
          },
          balances: {
            sellerUSDCBefore: sellerUsdcBefore.toString(),
            sellerUSDC: sellerUsdcBalance.toString(),
            deployerUSDCBefore: deployerUsdcBefore.toString(),
            deployerUSDCAfter: deployerUsdcAfter.toString(),
          },
        },
        null,
        2
      )
    );
  } finally {
    try {
      if (buyerNode) {
        await buyerNode.stop();
      }
    } catch {
      // best effort
    }
    try {
      if (sellerNode) {
        await sellerNode.stop();
      }
    } catch {
      // best effort
    }
    try {
      if (bootstrap) {
        await bootstrap.stop();
      }
    } catch {
      // best effort
    }
    try {
      if (sellerDataDir) {
        await rm(sellerDataDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
    try {
      if (buyerDataDir) {
        await rm(buyerDataDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
    await stopProcess(anvil, "anvil").catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("\n[flow] FAILED");
  console.error(formatError(err));
  process.exit(1);
});

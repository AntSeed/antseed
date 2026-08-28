#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isLoopbackRpcUrl, runSubmission } from "./submit-wash-trading-proofs.mjs";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const manifestPath = value("--manifest");
const registryAddress = value("--registry");
const rpcUrl = value("--rpc-url");
if (!manifestPath || !registryAddress || !rpcUrl || !args.includes("--submit-development") || !isLoopbackRpcUrl(rpcUrl)) {
  throw new Error("usage: submit-development-proof-local.mjs --manifest development-result.json --registry 0x... --rpc-url http://127.0.0.1:8545 --submit-development");
}
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.securityMode !== "development" || manifest.entries?.length !== 1) throw new Error("local development submission requires exactly one development receipt");
const resumePath = resolve(value("--resume") ?? `${manifestPath}.local-submission.json`);
const resume = await readJson(resumePath);
const results = await runSubmission({
  manifest,
  registryAddress,
  rpcUrl,
  submit: true,
  privateKey: process.env.ANVIL_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  allowDevelopmentOnLoopback: true,
  resume,
  onPersist: (next) => writeJsonAtomic(resumePath, next),
});
for (const result of results) {
  console.log(`${result.status} ${result.claimCount} claim(s)${result.transactionHash ? ` ${result.transactionHash}` : ""}`);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeJsonAtomic(path, valueToWrite) {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(valueToWrite, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

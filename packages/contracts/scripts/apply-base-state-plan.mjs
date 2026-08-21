#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyStatePlan, statePlanDigest } from "./state-plan.mjs";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const planPath = value("--plan");
const rpcUrl = value("--rpc-url") ?? process.env.BASE_RPC_URL;
const modes = ["validate-only", "fork-submit", "submit"].filter((mode) => args.includes(`--${mode}`));
if (!planPath || !rpcUrl || modes.length !== 1) {
  throw new Error("usage: node apply-base-state-plan.mjs --plan state-plan.json --rpc-url URL (--validate-only|--fork-submit|--submit)");
}
const mode = modes[0];
const plan = JSON.parse(await readFile(planPath, "utf8"));
const resumePath = resolve(value("--resume") ?? `${planPath}.resume.json`);
const resume = await readJson(resumePath);
const privateKey = mode === "fork-submit"
  ? process.env.ANVIL_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  : process.env.SUBMITTER_PRIVATE_KEY;
const digest = statePlanDigest(plan);
const outcome = await applyStatePlan({
  plan,
  rpcUrl,
  mode,
  privateKey,
  confirmPlanDigest: value("--confirm-plan-digest"),
  resume,
  onPersist: (next) => writeJsonAtomic(resumePath, next),
});
console.log(`planDigest ${digest}`);
for (const result of outcome.results) console.log(`${result.id} ${result.status}${result.transactionHash ? ` ${result.transactionHash}` : ""}`);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeJsonAtomic(path, valueToWrite) {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(valueToWrite, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

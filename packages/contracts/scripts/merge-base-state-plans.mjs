#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { getAddress } from "ethers";
import { statePlanDigest, validateStatePlan } from "./state-plan.mjs";

export function mergeStatePlans(plans) {
  if (!Array.isArray(plans) || plans.length === 0) throw new Error("no state plans supplied");
  for (const plan of plans) validateStatePlan(plan);
  const oracle = getAddress(plans[0].oracle);
  if (plans.some((plan) => plan.chainId !== plans[0].chainId || getAddress(plan.oracle) !== oracle)) throw new Error("state plans use different chains or oracles");
  const entries = plans.flatMap((plan) => plan.entries).map((entry, order) => ({ ...entry, order }));
  const merged = { version: 1, kind: "antseed-base-state-plan", chainId: plans[0].chainId, oracle, entries };
  validateStatePlan(merged);
  return merged;
}

const args = process.argv.slice(2);
if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  const planPaths = args.flatMap((arg, index) => arg === "--plan" ? [args[index + 1]] : []).filter(Boolean);
  const outIndex = args.indexOf("--out");
  const out = outIndex < 0 ? null : args[outIndex + 1];
  if (planPaths.length === 0 || !out) throw new Error("usage: merge-base-state-plans.mjs --plan accumulator.json [--plan additional.json] --out state-plan.json");
  const plans = await Promise.all(planPaths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const merged = mergeStatePlans(plans);
  await writeFile(out, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`statePlanDigest ${statePlanDigest(merged)}`);
}

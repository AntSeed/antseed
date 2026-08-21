import assert from "node:assert/strict";
import test from "node:test";
import { Interface, AbiCoder } from "ethers";
import { mergeStatePlans } from "./merge-base-state-plans.mjs";

const ORACLE = "0x0000000000000000000000000000000000000001";
const TRANSACTION = new Interface(["function beginHistoricalBackfill()"]);
const CHECK = new Interface(["function historicalBackfillStarted() view returns (bool)"]);

test("state plan merge preserves input sequence and renumbers globally", () => {
  const merged = mergeStatePlans([plan("one"), plan("two")]);
  assert.deepEqual(merged.entries.map((entry) => [entry.id, entry.order]), [["one", 0], ["two", 1]]);
});

function plan(id) {
  return {
    version: 1,
    kind: "antseed-base-state-plan",
    chainId: 8_453,
    oracle: ORACLE,
    entries: [{
      id,
      order: 0,
      purpose: id,
      to: ORACLE,
      value: "0x0",
      data: TRANSACTION.encodeFunctionData("beginHistoricalBackfill"),
      checks: [{ to: ORACLE, data: CHECK.encodeFunctionData("historicalBackfillStarted"), expected: AbiCoder.defaultAbiCoder().encode(["bool"], [true]) }],
    }],
  };
}

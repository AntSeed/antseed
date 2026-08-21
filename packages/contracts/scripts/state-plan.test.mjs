import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, keccak256 } from "ethers";
import { applyStatePlan, initializeResume, statePlanDigest, validateStatePlan } from "./state-plan.mjs";

const ORACLE = "0x0000000000000000000000000000000000000001";
const TRANSACTIONS = new Interface(["function beginHistoricalBackfill()"]);
const CHECKS = new Interface(["function historicalBackfillStarted() view returns (bool)"]);
const TRUE = AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
const FALSE = AbiCoder.defaultAbiCoder().encode(["bool"], [false]);

test("strict state plan rejects legacy, reordered, unsafe, and unchecked entries", () => {
  assert.throws(() => validateStatePlan({ chainId: 8_453, oracle: ORACLE, transactions: [] }), /invalid fields/);
  const reordered = validPlan();
  reordered.entries[0].order = 1;
  assert.throws(() => validateStatePlan(reordered), /noncontiguous/);
  const unsafe = validPlan();
  unsafe.entries[0].value = "0x1";
  assert.throws(() => validateStatePlan(unsafe), /sends value/);
  const unchecked = validPlan();
  unchecked.entries[0].checks = [];
  assert.throws(() => validateStatePlan(unchecked), /no completion checks/);
  const unauthorized = validPlan();
  unauthorized.entries[0].data = "0x095ea7b300000000";
  assert.throws(() => validateStatePlan(unauthorized), /unauthorized/);
  const malformed = validPlan();
  malformed.entries[0].data = new Interface(["function archiveBeaconRoot(uint256)"]).getFunction("archiveBeaconRoot").selector;
  assert.throws(() => validateStatePlan(malformed), /malformed or unauthorized calldata/);
  const oversizedCheck = validPlan();
  oversizedCheck.entries[0].checks[0].expected += "00";
  assert.throws(() => validateStatePlan(oversizedCheck), /not valid hex/);
});

test("resume files are bound to the exact canonical plan", () => {
  const plan = validPlan();
  const resume = initializeResume(plan);
  assert.equal(resume.planDigest, statePlanDigest(plan));
  const changed = validPlan();
  changed.entries[0].purpose = "changed";
  assert.throws(() => initializeResume(changed, resume), /does not match/);
});

test("completion checks skip before simulation and sending", async () => {
  let calls = 0;
  const provider = baseProvider({
    call: async () => { calls += 1; return TRUE; },
    estimateGas: async () => { throw new Error("estimate must not run"); },
  });
  const outcome = await applyStatePlan({
    plan: validPlan(), provider, rpcUrl: "http://127.0.0.1:8545", signer: { address: ORACLE },
    mode: "submit", confirmPlanDigest: statePlanDigest(validPlan()),
  });
  assert.equal(calls, 2);
  assert.deepEqual(outcome.results, [{ id: "historical-backfill:begin", status: "satisfied" }]);
});

test("fork execution persists and verifies exact completion", async () => {
  let completed = false;
  let persisted = 0;
  const provider = baseProvider({
    call: async ({ data }) => data === validPlan().entries[0].checks[0].data ? (completed ? TRUE : FALSE) : "0x",
    estimateGas: async () => 100_000n,
  });
  const signer = {
    address: "0x0000000000000000000000000000000000000002",
    sendTransaction: async () => ({
      hash: `0x${"1".repeat(64)}`,
      nonce: 7,
      wait: async () => {
        completed = true;
        return { status: 1, blockNumber: 9, gasUsed: 80_000n };
      },
    }),
  };
  const outcome = await applyStatePlan({
    plan: validPlan(), provider, rpcUrl: "http://localhost:8545", signer, mode: "fork-submit",
    onPersist: async () => { persisted += 1; },
  });
  assert.equal(persisted, 2);
  assert.equal(outcome.results[0].status, "submitted");
  assert.equal(outcome.resume.transactions["historical-backfill:begin"].calldataHash.length, 66);
});

test("interrupted execution refetches and verifies the recorded transaction", async () => {
  const plan = validPlan();
  const transactionHash = `0x${"2".repeat(64)}`;
  const resume = initializeResume(plan);
  let checks = 0;
  let transactionReads = 0;
  let receiptReads = 0;
  resume.transactions[plan.entries[0].id] = {
    hash: transactionHash,
    nonce: 7,
    to: ORACLE,
    calldataHash: keccak256(plan.entries[0].data),
    receipt: { status: 0, blockNumber: 1, gasUsed: "1" },
  };
  const provider = baseProvider({
    call: async () => { checks += 1; return checks === 1 ? FALSE : TRUE; },
    getTransaction: async () => { transactionReads += 1; return { to: ORACLE, data: plan.entries[0].data, nonce: 7, value: 0n }; },
    getTransactionReceipt: async () => { receiptReads += 1; return { status: 1, blockNumber: 9, gasUsed: 80_000n }; },
  });
  const outcome = await applyStatePlan({
    plan, provider, rpcUrl: "http://localhost:8545", signer: { address: ORACLE }, mode: "fork-submit", resume,
  });
  assert.equal(transactionReads, 1);
  assert.equal(receiptReads, 1);
  assert.equal(outcome.results[0].status, "resumed");
  assert.equal(outcome.resume.transactions[plan.entries[0].id].receipt.status, 1);
});

test("completed rerun sends zero transactions", async () => {
  let sends = 0;
  const provider = baseProvider({
    call: async () => TRUE,
    estimateGas: async () => { throw new Error("estimate must not run"); },
  });
  const signer = {
    address: "0x0000000000000000000000000000000000000002",
    sendTransaction: async () => { sends += 1; throw new Error("send must not run"); },
  };
  const outcome = await applyStatePlan({
    plan: validPlan(), provider, rpcUrl: "http://localhost:8545", signer, mode: "fork-submit",
  });
  assert.equal(sends, 0);
  assert.equal(outcome.results[0].status, "satisfied");
});

function validPlan() {
  return {
    version: 1,
    kind: "antseed-base-state-plan",
    chainId: 8_453,
    oracle: ORACLE,
    entries: [{
      id: "historical-backfill:begin",
      order: 0,
      purpose: "begin historical backfill",
      to: ORACLE,
      value: "0x0",
      data: TRANSACTIONS.encodeFunctionData("beginHistoricalBackfill"),
      checks: [{
        to: ORACLE,
        data: CHECKS.encodeFunctionData("historicalBackfillStarted"),
        expected: TRUE,
      }],
    }],
  };
}

function baseProvider(overrides) {
  return {
    getNetwork: async () => ({ chainId: 8_453n }),
    getCode: async () => "0x01",
    ...overrides,
  };
}

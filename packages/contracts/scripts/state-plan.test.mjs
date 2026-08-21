import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, keccak256, sha256 } from "ethers";
import { applyStatePlan, initializeResume, statePlanDigest, validateStatePlan } from "./state-plan.mjs";

const ORACLE = "0x0000000000000000000000000000000000000001";
const TRANSACTIONS = new Interface([
  "function submitHistoricalAccumulator(bytes proofBytes,bytes publicValues)",
  "function materializeHistoricalBlocks(tuple(uint64 blockNumber,bytes32 blockHash,bytes32[14] blockSiblings,bytes32 epochFirstParentHash,bytes32 epochEndBlockHash,bytes32[] mountainSiblings,bytes32[] peaks,uint32 targetPeakIndex)[] proofs)",
]);
const CHECKS = new Interface([
  "function historicalCoverageComplete() view returns (bool)",
  "function historicalEndBlock() view returns (uint64)",
  "function historicalEpochCount() view returns (uint32)",
  "function historicalMmrRoot() view returns (bytes32)",
  "function historicalJournalDigest() view returns (bytes32)",
  "function canonicalBlockHashes(uint64 blockNumber) view returns (bytes32)",
]);
const ABI_CODER = AbiCoder.defaultAbiCoder();
const TRUE = ABI_CODER.encode(["bool"], [true]);
const FALSE = ABI_CODER.encode(["bool"], [false]);
const MMR_ROOT = `0x${"ab".repeat(32)}`;
const JOURNAL_DATA = ABI_CODER.encode([
  "tuple(uint32 version,uint64 chainId,bytes32 epochRecursionVKey,uint64 startBlockNumber,uint64 endBlockNumber,uint64 anchorBlockNumber,bytes32 anchorBlockHash,uint64 blockCount,uint32 epochSize,uint32 epochCount,bytes32 mmrRoot)",
], [[3, 8_453, `0x${"11".repeat(32)}`, 44_469_557, 49_941_812, 49_941_812, `0x${"22".repeat(32)}`, 5_472_256, 16_384, 334, MMR_ROOT]]);

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
  assert.throws(() => validateStatePlan(malformed), /unauthorized selector/);
  const oversizedCheck = validPlan();
  oversizedCheck.entries[0].checks[0].expected += "00";
  assert.throws(() => validateStatePlan(oversizedCheck), /not valid hex/);
  const weakAccumulatorCheck = validPlan();
  weakAccumulatorCheck.entries[0].checks.pop();
  assert.throws(() => validateStatePlan(weakAccumulatorCheck), /do not exactly bind/);
});

test("resume files are bound to the exact canonical plan", () => {
  const plan = validPlan();
  const resume = initializeResume(plan);
  assert.equal(resume.planDigest, statePlanDigest(plan));
  const changed = validPlan();
  changed.entries[0].purpose = "changed";
  assert.throws(() => initializeResume(changed, resume), /does not match/);
});

test("materialization checks bind every exact block number and hash", () => {
  const plan = materializationPlan();
  assert.equal(validateStatePlan(plan), plan);
  plan.entries[0].checks[0].expected = `0x${"44".repeat(32)}`;
  assert.throws(() => validateStatePlan(plan), /do not exactly bind/);
});

test("completion checks skip before simulation and sending", async () => {
  let calls = 0;
  const provider = baseProvider({
    call: async ({ data }) => { calls += 1; return expectedCheckResult(validPlan(), data); },
    estimateGas: async () => { throw new Error("estimate must not run"); },
  });
  const outcome = await applyStatePlan({
    plan: validPlan(), provider, rpcUrl: "http://127.0.0.1:8545", signer: { address: ORACLE },
    mode: "submit", confirmPlanDigest: statePlanDigest(validPlan()),
  });
  assert.equal(calls, 10);
  assert.deepEqual(outcome.results, [{ id: "historical-accumulator", status: "satisfied" }]);
});

test("fork execution persists and verifies exact completion", async () => {
  let completed = false;
  let persisted = 0;
  const provider = baseProvider({
    call: async ({ data }) => {
      const expected = expectedCheckResult(validPlan(), data);
      return expected == null ? "0x" : completed ? expected : FALSE;
    },
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
  assert.equal(outcome.resume.transactions["historical-accumulator"].calldataHash.length, 66);
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
    call: async ({ data }) => {
      const expected = expectedCheckResult(plan, data);
      if (expected == null) return "0x";
      checks += 1;
      return checks === 1 ? FALSE : expected;
    },
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
    call: async ({ data }) => expectedCheckResult(validPlan(), data),
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
      id: "historical-accumulator",
      order: 0,
      purpose: "submit historical accumulator",
      to: ORACLE,
      value: "0x0",
      data: TRANSACTIONS.encodeFunctionData("submitHistoricalAccumulator", ["0x12", JOURNAL_DATA]),
      checks: accumulatorChecks(),
    }],
  };
}

function materializationPlan() {
  const blockNumber = 44_469_557;
  const blockHash = `0x${"33".repeat(32)}`;
  const proof = {
    blockNumber,
    blockHash,
    blockSiblings: Array(14).fill(`0x${"00".repeat(32)}`),
    epochFirstParentHash: `0x${"11".repeat(32)}`,
    epochEndBlockHash: `0x${"22".repeat(32)}`,
    mountainSiblings: [],
    peaks: [MMR_ROOT],
    targetPeakIndex: 0,
  };
  return {
    version: 1,
    kind: "antseed-base-state-plan",
    chainId: 8_453,
    oracle: ORACLE,
    entries: [{
      id: "historical-materialization-0",
      order: 0,
      purpose: "materialize one block",
      to: ORACLE,
      value: "0x0",
      data: TRANSACTIONS.encodeFunctionData("materializeHistoricalBlocks", [[proof]]),
      checks: [{
        to: ORACLE,
        data: CHECKS.encodeFunctionData("canonicalBlockHashes", [blockNumber]),
        expected: ABI_CODER.encode(["bytes32"], [blockHash]),
      }],
    }],
  };
}

function accumulatorChecks() {
  return [
    ["historicalCoverageComplete", TRUE],
    ["historicalEndBlock", ABI_CODER.encode(["uint64"], [49_941_812])],
    ["historicalEpochCount", ABI_CODER.encode(["uint32"], [334])],
    ["historicalMmrRoot", ABI_CODER.encode(["bytes32"], [MMR_ROOT])],
    ["historicalJournalDigest", ABI_CODER.encode(["bytes32"], [sha256(JOURNAL_DATA)])],
  ].map(([name, expected]) => ({ to: ORACLE, data: CHECKS.encodeFunctionData(name), expected }));
}

function expectedCheckResult(plan, data) {
  return plan.entries.flatMap((entry) => entry.checks).find((check) => check.data === data)?.expected ?? null;
}

function baseProvider(overrides) {
  return {
    getNetwork: async () => ({ chainId: 8_453n }),
    getCode: async () => "0x01",
    ...overrides,
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { Interface, AbiCoder, sha256 } from "ethers";
import { mergeStatePlans } from "./merge-base-state-plans.mjs";

const ORACLE = "0x0000000000000000000000000000000000000001";
const TRANSACTION = new Interface(["function submitHistoricalAccumulator(bytes seal,bytes journalData)"]);
const CHECK = new Interface([
  "function historicalCoverageComplete() view returns (bool)",
  "function historicalEndBlock() view returns (uint64)",
  "function historicalEpochCount() view returns (uint32)",
  "function historicalMmrRoot() view returns (bytes32)",
  "function historicalJournalDigest() view returns (bytes32)",
]);
const ABI_CODER = AbiCoder.defaultAbiCoder();
const MMR_ROOT = `0x${"ab".repeat(32)}`;
const JOURNAL_DATA = ABI_CODER.encode([
  "tuple(uint32 version,uint64 chainId,bytes32 epochImageId,uint64 startBlockNumber,uint64 endBlockNumber,uint64 anchorBlockNumber,bytes32 anchorBlockHash,uint64 blockCount,uint32 epochSize,uint32 epochCount,bytes32 mmrRoot)",
], [[2, 8_453, `0x${"11".repeat(32)}`, 44_469_557, 49_941_812, 49_941_812, `0x${"22".repeat(32)}`, 5_472_256, 16_384, 334, MMR_ROOT]]);

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
      data: TRANSACTION.encodeFunctionData("submitHistoricalAccumulator", ["0x12", JOURNAL_DATA]),
      checks: [
        ["historicalCoverageComplete", ABI_CODER.encode(["bool"], [true])],
        ["historicalEndBlock", ABI_CODER.encode(["uint64"], [49_941_812])],
        ["historicalEpochCount", ABI_CODER.encode(["uint32"], [334])],
        ["historicalMmrRoot", ABI_CODER.encode(["bytes32"], [MMR_ROOT])],
        ["historicalJournalDigest", ABI_CODER.encode(["bytes32"], [sha256(JOURNAL_DATA)])],
      ].map(([name, expected]) => ({ to: ORACLE, data: CHECK.encodeFunctionData(name), expected })),
    }],
  };
}

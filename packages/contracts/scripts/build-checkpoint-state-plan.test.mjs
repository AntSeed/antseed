import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AbiCoder } from "ethers";
import { buildCheckpointStatePlan } from "./build-checkpoint-state-plan.mjs";

const ORACLE = "0x0000000000000000000000000000000000000001";
const JOURNAL = "tuple(tuple(uint256 id,bytes32 digest,bytes32 configID) ethereumCommitment,uint64 chainId,address anchorStateRegistry,address game,uint8 intermediateRootIndex,uint64 checkpointBlockNumber,bytes32 checkpointBlockHash,bytes32 outputRoot,tuple(uint64 number,bytes32 blockHash)[] canonicalBlocks)";

test("checkpoint artifacts produce archived-root and exact checkpoint entries", async () => {
  const journal = AbiCoder.defaultAbiCoder().encode([JOURNAL], [[
    [123n, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`], 8_453,
    "0x0000000000000000000000000000000000000010", "0x0000000000000000000000000000000000000020",
    1, 46_302_990, `0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`,
    [[46_302_990, `0x${"3".repeat(64)}`]],
  ]]);
  const files = new Map([["journal.hex", Buffer.from(`${journal}\n`)], ["seal.hex", Buffer.from("0x12\n")]]);
  const manifest = {
    version: 1,
    kind: "antseed-checkpoint-proof-artifacts",
    chainId: 8_453,
    proofs: [{
      index: 0,
      checkpointBlockNumber: 46_302_990,
      journalFile: "journal.hex",
      sealFile: "seal.hex",
      journalSha256: digest(files.get("journal.hex")),
      sealSha256: digest(files.get("seal.hex")),
      status: "proven",
    }],
  };
  const plan = await buildCheckpointStatePlan({ manifest, oracle: ORACLE, loadArtifact: async (file) => files.get(file) });
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[0].id, "checkpoint:archive:123");
  assert.equal(plan.entries[1].checks.length, 2);
});

function digest(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

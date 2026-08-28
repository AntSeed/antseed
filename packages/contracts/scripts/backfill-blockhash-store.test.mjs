import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "ethers";
import { buildBackfillPlan, collectRequiredBlockRefs, validateHeaderBundle } from "./backfill-blockhash-store.mjs";

const RLP = "0xc0";
const HASH = keccak256(RLP);

test("collectRequiredBlockRefs deduplicates exact block references", () => {
  const manifest = manifestWithRefs([
    [{ number: "100", blockHash: HASH }],
    [{ number: "100", blockHash: HASH }, { number: "101", blockHash: HASH }],
  ]);
  assert.deepEqual(collectRequiredBlockRefs(manifest), [
    { number: 100n, blockHash: HASH },
    { number: 101n, blockHash: HASH },
  ]);
});

test("collectRequiredBlockRefs rejects conflicting hashes", () => {
  const manifest = manifestWithRefs([
    [{ number: "100", blockHash: HASH }],
    [{ number: "100", blockHash: `0x${"1".repeat(64)}` }],
  ]);
  assert.throws(() => collectRequiredBlockRefs(manifest), /conflicting hashes/);
});

test("validateHeaderBundle checks RLP hashes and consecutive numbering", () => {
  const headers = validateHeaderBundle([
    { number: "100", hash: HASH, rlp: RLP },
    { number: "101", hash: HASH, rlp: RLP },
  ]);
  assert.equal(headers.size, 2);
  assert.throws(() => validateHeaderBundle([{ number: "100", hash: `0x${"2".repeat(64)}`, rlp: RLP }]), /RLP hash mismatch/);
  assert.throws(() => validateHeaderBundle([
    { number: "100", hash: HASH, rlp: RLP },
    { number: "102", hash: HASH, rlp: RLP },
  ]), /strictly consecutive/);
});

test("buildBackfillPlan walks backward from a stored child header", () => {
  const headers = validateHeaderBundle([
    { number: "100", hash: HASH, rlp: RLP },
    { number: "101", hash: HASH, rlp: RLP },
    { number: "102", hash: HASH, rlp: RLP },
  ]);
  const plan = buildBackfillPlan([{ number: 100n, blockHash: HASH }], headers, new Set(["102"]), 1_000n);
  assert.deepEqual(plan.map((step) => [step.method, step.blockNumber]), [
    ["storeVerifyHeader", 101n],
    ["storeVerifyHeader", 100n],
  ]);
  assert.equal(plan[1].required, true);
});

function manifestWithRefs(refGroups) {
  return {
    version: 2,
    kind: "antseed-wash-trading-proof-results",
    entries: refGroups.map((blockReferences, index) => ({ claimId: `0x${String(index + 1).padStart(64, "0")}`, blockReferences })),
  };
}

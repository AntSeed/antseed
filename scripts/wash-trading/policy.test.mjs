import assert from "node:assert/strict";
import test from "node:test";
import { FINAL_VERDICT_THRESHOLDS, meetsRatio } from "./policy.mjs";

test("policy thresholds use exact integer boundaries", () => {
  assert.equal(meetsRatio(500n, 1_000n, FINAL_VERDICT_THRESHOLDS.minimumCohortSellerVolumeBps), true);
  assert.equal(meetsRatio(499n, 1_000n, FINAL_VERDICT_THRESHOLDS.minimumCohortSellerVolumeBps), false);
  assert.equal(meetsRatio(800n, 1_000n, FINAL_VERDICT_THRESHOLDS.minimumReciprocityBps), true);
  assert.equal(meetsRatio(799n, 1_000n, FINAL_VERDICT_THRESHOLDS.minimumReciprocityBps), false);
  assert.equal(meetsRatio(990n, 1_000n, FINAL_VERDICT_THRESHOLDS.minimumDependentSellerShareBps), true);
  assert.equal(meetsRatio(989n, 1_000n, FINAL_VERDICT_THRESHOLDS.minimumDependentSellerShareBps), false);
});

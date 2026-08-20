import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, sha256 } from "ethers";
import { decodeAndValidateEntry, validateManifest, validateStateProofEntry } from "./submit-wash-trading-proofs.mjs";

test("submission manifest rejects missing and duplicate claims", () => {
  const manifest = validManifest();
  manifest.entries[0].seal = "0x";
  assert.throws(() => validateManifest(manifest), /seal missing/);

  const duplicate = validManifest();
  duplicate.entries.push({ ...duplicate.entries[0] });
  assert.throws(() => validateManifest(duplicate), /duplicate claim ID/);
});

test("submission manifest rejects unknown claim types", () => {
  const manifest = validManifest();
  manifest.entries[0].claimType = "P0_ATTACKER_CONTROLLED";
  assert.throws(() => validateManifest(manifest), /unsupported claim type/);
});

test("submission rejects cohort journals mislabeled as another claim type", () => {
  const entry = validManifest().entries[0];
  entry.claimType = "P0_CLOSED_LOOP";
  assert.throws(() => decodeAndValidateEntry(entry, `0x${"2".repeat(64)}`), /journal claim type mismatch/);
});

test("state proof manifest only permits checkpoint-oracle calls", () => {
  const oracle = "0x0000000000000000000000000000000000000001";
  const checkpoint = new Interface(["function submitCheckpoint(bytes,bytes)"])
    .encodeFunctionData("submitCheckpoint", ["0x12", "0x34"]);
  assert.doesNotThrow(() => validateStateProofEntry({ id: "checkpoint", to: oracle, data: checkpoint }, oracle));
  assert.throws(
    () => validateStateProofEntry({ id: "drain", to: "0x0000000000000000000000000000000000000002", data: checkpoint }, oracle),
    /non-oracle/,
  );
  assert.throws(
    () => validateStateProofEntry({ id: "approve", to: oracle, data: "0x095ea7b300000000" }, oracle),
    /unauthorized/,
  );
});

function validManifest() {
  const claimId = `0x${"1".repeat(64)}`;
  const reportRoot = `0x${"2".repeat(64)}`;
  const journalBytes = AbiCoder.defaultAbiCoder().encode([
    "tuple(uint32 predicateVersion,uint8 claimType,bytes32 claimId,bytes32 reportRoot,address seller,uint16 penaltyBps,uint32 linkedBuyerCount,uint128 qualifiedVolumeRaw,tuple(uint64 number,bytes32 blockHash)[] blockRefs)",
  ], [[1, 2, claimId, reportRoot, "0x0000000000000000000000000000000000000001", 9_000, 3, 1_000_000_000, [[1, `0x${"3".repeat(64)}`]]]]);
  return {
    version: 1,
    kind: "antseed-wash-trading-proof-results",
    chainId: 8_453,
    reportRoot,
    securityMode: "production",
    entries: [{
      claimId,
      claimType: "P1_COORDINATED_CONTROL",
      imageId: "4".repeat(64),
      seal: "0x01",
      journalBytes,
      journalDigest: sha256(journalBytes),
    }],
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, keccak256, sha256 } from "ethers";
import { decodeAndValidateEntry, validateManifest, validateStateProofEntry } from "./submit-wash-trading-proofs.mjs";

const CLOSED = "tuple(uint32 predicateVersion,bytes32 claimId,uint64 periodStartBlock,uint64 periodEndBlockExclusive,address seller,address funder,bytes32 cohortHash,uint32 cohortCount,uint128 qualifiedVolumeRaw,uint8 closureKind,uint32 closurePathCount,tuple(uint64 number,bytes32 blockHash)[] blockRefs)";

test("submission manifest rejects missing, duplicate, and analysis-only claims", () => {
  const missing = validManifest();
  missing.entries[0].seal = "0x";
  assert.throws(() => validateManifest(missing), /seal missing/);

  const duplicate = validManifest();
  duplicate.entries.push({ ...duplicate.entries[0] });
  assert.throws(() => validateManifest(duplicate), /duplicate claim ID/);

  const analysisOnly = validManifest();
  analysisOnly.entries[0].enforceable = false;
  assert.throws(() => validateManifest(analysisOnly), /analysis-only/);
});

test("submission rejects unknown types and claim ID mismatches", () => {
  const unknown = validManifest();
  unknown.entries[0].claimType = "P0_ATTACKER_CONTROLLED";
  assert.throws(() => validateManifest(unknown), /unsupported claim type/);

  const mismatch = validManifest().entries[0];
  mismatch.claimId = `0x${"9".repeat(64)}`;
  assert.throws(() => decodeAndValidateEntry(mismatch), /claim ID mismatch/);
});

test("submission decodes self-funded closed-cycle journals", () => {
  const entry = validManifest({ selfFunded: true }).entries[0];
  const decoded = decodeAndValidateEntry(entry);

  assert.equal(decoded.seller, decoded.funder);
  assert.equal(decoded.closureKind, 3n);
  assert.equal(decoded.closurePathCount, 3n);
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

function validManifest({ selfFunded = false } = {}) {
  const seller = "0x0000000000000000000000000000000000000010";
  const funder = selfFunded ? seller : "0x0000000000000000000000000000000000000020";
  const cohortHash = `0x${"3".repeat(64)}`;
  const claimId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint8", "uint64", "uint64", "address", "address", "bytes32"],
    [8_453, 1, 44_471_575, 49_936_173, seller, funder, cohortHash],
  ));
  const journalBytes = AbiCoder.defaultAbiCoder().encode([CLOSED], [[
    3, claimId, 44_471_575, 49_936_173, seller, funder, cohortHash, 3, 1_000_000_000,
    selfFunded ? 3 : 1, selfFunded ? 3 : 1, [[1, `0x${"4".repeat(64)}`]],
  ]]);
  return {
    version: 1,
    kind: "antseed-wash-trading-proof-results",
    chainId: 8_453,
    securityMode: "production",
    entries: [{
      claimId,
      claimType: "P0_CLOSED_LOOP",
      imageId: "5".repeat(64),
      seal: "0x01",
      journalBytes,
      journalDigest: sha256(journalBytes),
    }],
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, sha256 } from "ethers";
import { decodeAndValidateEntry, initializeSubmissionResume, isLoopbackRpcUrl, validateManifest } from "./submit-wash-trading-proofs.mjs";

const WASH_JOURNAL = "tuple(uint8 predicateId,uint64 chainId,uint64 periodStartBlock,uint64 periodEndBlock,bytes32 claimId,tuple(address subject,uint128 washVolume,uint128 settledVolume)[] subjects,tuple(uint64 number,bytes32 blockHash)[] blockRefs)";

test("submission manifest rejects missing, duplicate, and legacy-shaped claims", () => {
  const missing = validManifest();
  missing.entries[0].proofBytes = "0x";
  assert.throws(() => validateManifest(missing), /SP1 proof bytes missing/);

  const duplicate = validManifest();
  duplicate.entries.push({ ...duplicate.entries[0] });
  assert.throws(() => validateManifest(duplicate), /duplicate claim ID/);

  const legacy = validManifest();
  legacy.entries[0][["se", "al"].join("")] = legacy.entries[0].proofBytes;
  assert.throws(() => validateManifest(legacy), /invalid fields/);
});

test("submission rejects unknown types and subject mismatches", () => {
  const unknown = validManifest();
  unknown.entries[0].claimType = "P0_ATTACKER_CONTROLLED";
  assert.throws(() => validateManifest(unknown), /unsupported claim type/);

  const mismatch = validManifest().entries[0];
  mismatch.subjects = ["0x0000000000000000000000000000000000000099"];
  assert.throws(() => decodeAndValidateEntry(mismatch), /subjects mismatch/);
});

test("submission decodes the wash journal", () => {
  const entry = validManifest().entries[0];
  const decoded = decodeAndValidateEntry(entry);

  assert.deepEqual(decoded.subjects, ["0x0000000000000000000000000000000000000010"]);
  assert.equal(decoded.blockRefs.length, 1);
  assert.equal(decoded.blockRefs[0].number, 1n);
});

test("submission resumes are bound to the exact manifest and registry", () => {
  const manifest = validManifest();
  const registry = "0x0000000000000000000000000000000000000040";
  const resume = initializeSubmissionResume(manifest, registry);
  assert.equal(resume.chainId, 8_453);
  const changed = validManifest({ seller: "0x0000000000000000000000000000000000000011" });
  assert.throws(() => initializeSubmissionResume(changed, registry, resume), /does not match/);
  assert.throws(() => initializeSubmissionResume(manifest, "0x0000000000000000000000000000000000000041", resume), /does not match/);
});

test("development submission is restricted to loopback RPC URLs", () => {
  assert.equal(isLoopbackRpcUrl("http://127.0.0.1:8545"), true);
  assert.equal(isLoopbackRpcUrl("http://localhost:8545"), true);
  assert.equal(isLoopbackRpcUrl("https://mainnet.base.org"), false);
});

function validManifest({ seller = "0x0000000000000000000000000000000000000010" } = {}) {
  const claimId = `0x${"1".repeat(64)}`;
  const journalBytes = AbiCoder.defaultAbiCoder().encode([WASH_JOURNAL], [[
    1,
    8_453,
    44_471_575,
    49_936_172,
    claimId,
    [[seller, 9000_000_000n, 10000_000_000n]],
    [[1, `0x${"4".repeat(64)}`]],
  ]]);
  return {
    version: 2,
    kind: "antseed-wash-trading-proof-results",
    chainId: 8_453,
    securityMode: "production",
    entries: [{
      claimId,
      claimType: "P0_CLOSED_LOOP",
      subjects: [seller],
      metrics: {
        cohortCount: 3,
        qualifiedVolumeRaw: "1000000000",
        closureKind: 1,
        closurePathCount: 1,
      },
      programVKey: `0x${"5".repeat(64)}`,
      proofBytes: "0x01",
      journalBytes,
      journalDigest: sha256(journalBytes),
      instructionCount: null,
    }],
  };
}

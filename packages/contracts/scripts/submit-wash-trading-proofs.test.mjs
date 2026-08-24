import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, sha256 } from "ethers";
import {
  computeBatchCommitments,
  computeExpectedBatchDigest,
  decodeAndValidateEntry,
  initializeSubmissionResume,
  isLoopbackRpcUrl,
  validateManifest,
} from "./submit-wash-trading-proofs.mjs";

const WASH_JOURNAL = "tuple(uint8 predicateId,uint64 chainId,uint64 periodStartBlock,uint64 periodEndBlock,bytes32 claimId,tuple(address subject,uint128 washVolume,uint128 settledVolume)[] subjects,tuple(uint64 number,bytes32 blockHash)[] blockRefs)";

test("submission manifest rejects missing, duplicate, and legacy-shaped claims", () => {
  const missing = validManifest();
  missing.entries[0].proofBytes = "0x";
  assert.throws(() => validateManifest(missing), /SP1 proof bytes missing/);

  const duplicate = validManifest();
  duplicate.entries.push({ ...duplicate.entries[0] });
  duplicate.batch.expectedBatchCount = 2;
  duplicate.batch.commitments.push({ ...duplicate.batch.commitments[0] });
  assert.throws(() => validateManifest(duplicate), /strictly claim-ID ordered/);

  const legacy = validManifest();
  legacy.entries[0].seal = legacy.entries[0].proofBytes;
  assert.throws(() => validateManifest(legacy), /invalid fields/);
});

test("submission rejects unknown types, subject mismatches, and journal claim mismatches", () => {
  const unknown = validManifest();
  unknown.entries[0].claimType = "P0_ATTACKER_CONTROLLED";
  assert.throws(() => validateManifest(unknown), /unsupported claim type/);

  const mismatch = validManifest().entries[0];
  mismatch.subjects = ["0x0000000000000000000000000000000000000099"];
  assert.throws(() => decodeAndValidateEntry(mismatch), /subjects mismatch/);

  const claimMismatch = validManifest().entries[0];
  claimMismatch.claimId = `0x${"2".repeat(64)}`;
  assert.throws(() => decodeAndValidateEntry(claimMismatch), /journal claim ID mismatch/);
});

test("submission decodes journal volumes and block references", () => {
  const entry = validManifest().entries[0];
  const decoded = decodeAndValidateEntry(entry);

  assert.equal(decoded.subjects[0].subject, "0x0000000000000000000000000000000000000010");
  assert.equal(decoded.subjects[0].washVolume, 9_000_000_000n);
  assert.equal(decoded.blockRefs.length, 1);
  assert.equal(decoded.blockRefs[0].number, 44_471_575n);
});

test("batch digest binds ordered commitments, vkeys, and BlockhashStore", () => {
  const manifest = validManifest();
  const digest = computeExpectedBatchDigest({
    chainId: manifest.chainId,
    closedLoopVKey: manifest.batch.closedLoopVKey,
    reciprocalVKey: manifest.batch.reciprocalVKey,
    blockhashStore: manifest.batch.blockhashStore,
    commitments: computeBatchCommitments(manifest.entries),
  });
  assert.equal(digest, manifest.batch.expectedBatchDigest);

  const changed = structuredClone(manifest);
  changed.batch.blockhashStore = "0x0000000000000000000000000000000000000041";
  assert.notEqual(computeExpectedBatchDigest({
    chainId: changed.chainId,
    closedLoopVKey: changed.batch.closedLoopVKey,
    reciprocalVKey: changed.batch.reciprocalVKey,
    blockhashStore: changed.batch.blockhashStore,
    commitments: changed.batch.commitments,
  }), digest);
});

test("submission resumes bind the exact manifest and registry", () => {
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
  const blockHash = `0x${"4".repeat(64)}`;
  const journalBytes = AbiCoder.defaultAbiCoder().encode([WASH_JOURNAL], [[
    1,
    8_453,
    44_471_575,
    49_936_172,
    claimId,
    [[seller, 9_000_000_000n, 10_000_000_000n]],
    [[44_471_575, blockHash]],
  ]]);
  const closedLoopVKey = `0x${"5".repeat(64)}`;
  const reciprocalVKey = `0x${"6".repeat(64)}`;
  const blockhashStore = "0x78b69899C8cD252126cBB1A50171ec37286C3877";
  const entries = [{
    claimId,
    sourceClaimId: null,
    claimType: "P0_CLOSED_LOOP",
    subjects: [seller],
    metrics: {
      cohortCount: 3,
      qualifiedVolumeRaw: "9000000000",
      journalWashVolumeRaw: "9000000000",
      authenticatedReceiptVolumeRaw: "9000000000",
      closureKind: 1,
      closurePathCount: 1,
    },
    programVKey: closedLoopVKey,
    proofBytes: "0x01",
    journalBytes,
    journalDigest: sha256(journalBytes),
    blockReferences: [{ number: "44471575", blockHash }],
    instructionCount: null,
  }];
  const commitments = computeBatchCommitments(entries);
  const expectedBatchDigest = computeExpectedBatchDigest({
    closedLoopVKey,
    reciprocalVKey,
    blockhashStore,
    commitments,
  });
  return {
    version: 2,
    kind: "antseed-wash-trading-proof-results",
    chainId: 8_453,
    securityMode: "production",
    batch: {
      domain: "0xd08151eda8d43b337e7be442882171ae56c6de2cb89b3d4838432499c6aabcb5",
      blockhashStore,
      closedLoopVKey,
      reciprocalVKey,
      expectedBatchCount: 1,
      expectedBatchDigest,
      commitments,
    },
    entries,
  };
}

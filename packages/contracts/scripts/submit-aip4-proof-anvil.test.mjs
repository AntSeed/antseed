import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, sha256 } from "ethers";
import {
  computeBatchCommitments,
  computeExpectedBatchDigest,
} from "./submit-wash-trading-proofs.mjs";
import { prepareLocalManifest } from "./submit-aip4-proof-anvil.mjs";

const WASH_JOURNAL = "tuple(uint8 predicateId,uint64 chainId,uint64 periodStartBlock,uint64 periodEndBlock,bytes32 claimId,tuple(address subject,uint128 washVolume,uint128 settledVolume)[] subjects,tuple(uint64 number,bytes32 blockHash)[] blockRefs)";

test("local P0 manifest rebinds the BlockhashStore and atomic digest", () => {
  const manifest = developmentManifest();
  const localStore = "0x0000000000000000000000000000000000000042";
  const rebound = prepareLocalManifest(manifest, localStore);

  assert.equal(rebound.securityMode, "development");
  assert.equal(rebound.batch.blockhashStore, localStore);
  assert.notEqual(rebound.batch.expectedBatchDigest, manifest.batch.expectedBatchDigest);
  assert.equal(rebound.batch.expectedBatchDigest, computeExpectedBatchDigest({
    chainId: rebound.chainId,
    closedLoopVKey: rebound.batch.closedLoopVKey,
    reciprocalVKey: rebound.batch.reciprocalVKey,
    blockhashStore: localStore,
    commitments: rebound.batch.commitments,
  }));
  assert.equal(manifest.batch.blockhashStore, "0x0000000000000000000000000000000000000040");
});

function developmentManifest() {
  const claimId = `0x${"1".repeat(64)}`;
  const blockHash = `0x${"4".repeat(64)}`;
  const journalBytes = AbiCoder.defaultAbiCoder().encode([WASH_JOURNAL], [[
    1,
    8_453,
    44_471_575,
    49_936_172,
    claimId,
    [["0x0000000000000000000000000000000000000010", 9_000_000_000n, 10_000_000_000n]],
    [[44_471_575, blockHash]],
  ]]);
  const closedLoopVKey = `0x${"5".repeat(64)}`;
  const reciprocalVKey = `0x${"6".repeat(64)}`;
  const blockhashStore = "0x0000000000000000000000000000000000000040";
  const entries = [{
    claimId,
    sourceClaimId: null,
    claimType: "P0_CLOSED_LOOP",
    subjects: ["0x0000000000000000000000000000000000000010"],
    metrics: {
      qualifiedVolumeRaw: "9000000000",
      journalWashVolumeRaw: "9000000000",
      authenticatedReceiptVolumeRaw: "9000000000",
    },
    programVKey: closedLoopVKey,
    journalBytes,
    journalDigest: sha256(journalBytes),
    proofBytes: "0x01",
    blockReferences: [{ number: "44471575", blockHash }],
    instructionCount: 1,
  }];
  const commitments = computeBatchCommitments(entries);
  return {
    version: 2,
    kind: "antseed-wash-trading-proof-results",
    chainId: 8_453,
    securityMode: "development",
    batch: {
      domain: "0xd08151eda8d43b337e7be442882171ae56c6de2cb89b3d4838432499c6aabcb5",
      blockhashStore,
      closedLoopVKey,
      reciprocalVKey,
      expectedBatchCount: 1,
      expectedBatchDigest: computeExpectedBatchDigest({
        closedLoopVKey,
        reciprocalVKey,
        blockhashStore,
        commitments,
      }),
      commitments,
    },
    entries,
  };
}

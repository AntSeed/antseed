import assert from "node:assert/strict";
import test from "node:test";
import {
  clusterBlockNumbers,
  mergeBackfillRanges,
  normalizeHash,
  positiveInteger,
  stableDigest,
  uniqueBlockReferences,
} from "./wash-trading-blockhash-backfill-lib.mjs";

const hash = (nibble) => `0x${nibble.repeat(64)}`;

test("deduplicates and sorts authenticated block references", () => {
  const artifacts = [
    {
      blockAuthenticationChunks: [
        { references: [{ number: 30, blockHash: hash("a") }, { number: 10, blockHash: hash("b") }] },
      ],
    },
    {
      blockAuthenticationChunks: [
        { references: [{ number: 10, blockHash: hash("B") }, { number: 20, blockHash: hash("c") }] },
      ],
    },
  ];

  assert.deepEqual(uniqueBlockReferences(artifacts), [
    { number: 10, blockHash: hash("b") },
    { number: 20, blockHash: hash("c") },
    { number: 30, blockHash: hash("a") },
  ]);
});

test("rejects conflicting hashes for one Base block", () => {
  const artifacts = [{
    blockAuthenticationChunks: [{
      references: [
        { number: 10, blockHash: hash("a") },
        { number: 10, blockHash: hash("b") },
      ],
    }],
  }];

  assert.throws(() => uniqueBlockReferences(artifacts), /conflicting hash for Base block 10/);
});

test("clusters only across gaps within the configured bound", () => {
  assert.deepEqual(clusterBlockNumbers([10, 11, 14, 40], 3), [
    { startBlock: 10, endBlock: 14, requiredReferenceCount: 3 },
    { startBlock: 40, endBlock: 40, requiredReferenceCount: 1 },
  ]);
  assert.deepEqual(clusterBlockNumbers([], 3), []);
});

test("merges adjacent backfill ranges under the highest anchor", () => {
  assert.deepEqual(mergeBackfillRanges([
    { startBlock: 21, endBlock: 30, anchorBlock: 31, anchorHash: hash("d"), requiredReferenceCount: 3 },
    { startBlock: 40, endBlock: 42, anchorBlock: 43, anchorHash: hash("e"), requiredReferenceCount: 1 },
    { startBlock: 10, endBlock: 20, anchorBlock: 21, anchorHash: hash("c"), requiredReferenceCount: 2 },
  ]), [
    { startBlock: 10, endBlock: 30, anchorBlock: 31, anchorHash: hash("d"), requiredReferenceCount: 5 },
    { startBlock: 40, endBlock: 42, anchorBlock: 43, anchorHash: hash("e"), requiredReferenceCount: 1 },
  ]);
});

test("pins plan approval to deterministic serialized content", () => {
  const plan = { version: 1, ranges: [{ startBlock: 10, endBlock: 20 }], live: false };
  assert.equal(stableDigest(plan), "0x829cf5a231653587c5c5efc917652e00367f255b71d51d2109cbd1527cadb609");
  assert.notEqual(stableDigest({ ...plan, live: true }), stableDigest(plan));
});

test("validates numeric and bytes32 inputs", () => {
  assert.equal(positiveInteger("200", "batch size"), 200);
  assert.throws(() => positiveInteger("0", "batch size"), /must be a positive integer/);
  assert.equal(normalizeHash(hash("A")), hash("a"));
  assert.throws(() => normalizeHash("0x1234"), /invalid bytes32/);
});

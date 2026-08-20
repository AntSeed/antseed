import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyScanStatus, filterTraceToPeriod, parseArguments, parseSellerLabelsCsv, traceArtifactExceedsPeriodLimit, validateResumeOptions } from "../wash-trading-scan.mjs";

test("full-history scan requires no arguments", () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(["--"]), {});
});

test("parses focused scan, labels, and runtime controls", () => {
  const seller = "0x0000000000000000000000000000000000000001";
  assert.deepEqual(parseArguments(["--from", "2026-01-01", "--to", "2026-08-11", "--seller", seller, "--seller-labels", "/tmp/labels.csv", "--rpc-url", "https://rpc.example.test", "--blockscout-concurrency", "4", "--max-auxiliary-transfers", "10000"]), {
    from: "2026-01-01",
    to: "2026-08-11",
    seller,
    sellerLabels: "/tmp/labels.csv",
    rpcUrl: "https://rpc.example.test",
    blockscoutConcurrency: 4,
    maxAuxiliaryTransfers: 10000,
  });
});

test("parses quoted seller presentation labels", () => {
  const seller = "0x0000000000000000000000000000000000000001";
  const labels = parseSellerLabelsCsv(`"address","display_name","note"\n"${seller}","Seller, One","quoted"\n`);
  assert.deepEqual([...labels], [[seller, "Seller, One"]]);
});

test("rejects conflicting output and resume options", () => {
  assert.throws(() => parseArguments(["--output", "/tmp/new", "--resume", "/tmp/old"]), /cannot be used together/);
});

test("proof export requires an exact block period", () => {
  assert.throws(() => parseArguments(["--proof-output", "/tmp/bundle.json"]), /requires --start-block/);
  assert.deepEqual(parseArguments(["--proof-output", "/tmp/bundle.json", "--start-block", "10", "--end-block-exclusive", "20"]), {
    proofOutput: "/tmp/bundle.json",
    startBlock: 10,
    endBlockExclusive: 20,
  });
});

test("resume rejects immutable input changes but allows runtime tuning", () => {
  const manifest = {
    version: 1,
    scoringVersion: "conservative-v2",
    request: { from: null, to: null, seller: null },
    sources: { antscan: "https://antscan.co", blockscout: "https://base.blockscout.com" },
  };
  assert.doesNotThrow(() => validateResumeOptions({ blockscoutConcurrency: 1, rpcUrl: "https://rpc.example.test" }, manifest));
  assert.throws(() => validateResumeOptions({ from: "2026-01-01" }, manifest), /cannot change when resuming/);
});

test("reused token traces are filtered while first-ever native funding is preserved", () => {
  const trace = filterTraceToPeriod({
    complete: true,
    inboundUsdc: [{ timestamp: 99 }, { timestamp: 100 }, { timestamp: 199 }, { timestamp: 200 }],
    outboundUsdc: [{ timestamp: 150 }],
    firstNativeFunding: { timestamp: 50 },
  }, { from: 100, to: 200 });
  assert.deepEqual(trace.inboundUsdc, [{ timestamp: 100 }, { timestamp: 199 }]);
  assert.deepEqual(trace.outboundUsdc, [{ timestamp: 150 }]);
  assert.deepEqual(trace.firstNativeFunding, { timestamp: 50 });
  assert.deepEqual(trace.query, { fromTimestamp: 100, toTimestamp: 200 });
});

test("reused high-volume traces become lightweight skipped summaries", () => {
  const trace = filterTraceToPeriod({
    address: "0x0000000000000000000000000000000000000001",
    complete: true,
    inboundUsdc: [{ timestamp: 100 }, { timestamp: 101 }],
    outboundUsdc: [{ timestamp: 102 }],
  }, { from: 100, to: 200 }, 2);
  assert.equal(trace.complete, false);
  assert.deepEqual(trace.inboundUsdc, []);
  assert.deepEqual(trace.outboundUsdc, []);
  assert.deepEqual(trace.skipped, { reason: "high_volume_address", maxTransfers: 2, observedTransfers: 3 });
});

test("large saved artifacts are counted by period without JSON parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-trace-limit-"));
  const path = join(directory, "trace.json");
  await writeFile(path, JSON.stringify({
    inboundUsdc: [{ timestamp: 99 }, { timestamp: 100 }, { timestamp: 150 }],
    outboundUsdc: [{ timestamp: 199 }, { timestamp: 200 }],
  }));
  try {
    assert.equal(await traceArtifactExceedsPeriodLimit(path, { from: 100, to: 200 }, 2), true);
    assert.equal(await traceArtifactExceedsPeriodLimit(path, { from: 100, to: 200 }, 3), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("intentional high-volume skips produce bounded rather than retryable status", () => {
  assert.deepEqual(classifyScanStatus(true, [
    { complete: true },
    { complete: false, skipped: { reason: "high_volume_address" } },
  ]), {
    status: "bounded",
    incompleteTraces: 1,
    retryableIncompleteTraces: 0,
    highVolumeSkippedTraces: 1,
  });
  assert.equal(classifyScanStatus(true, [{ complete: false }]).status, "partial");
  assert.equal(classifyScanStatus(true, [{ complete: true }]).status, "complete");
});

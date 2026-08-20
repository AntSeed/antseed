import assert from "node:assert/strict";
import test from "node:test";
import { buildProofBundle } from "./proof-bundle.mjs";

const SELLER = "0x1000000000000000000000000000000000000000";
const FUNDER = "0x2000000000000000000000000000000000000000";
const BUYERS = [3, 4, 5].map((digit) => `0x${String(digit).repeat(40)}`);

test("proof bundle is deterministic and preserves direct Flash-style evidence", () => {
  const input = fixture();
  const first = buildProofBundle(input);
  input.fundingRecords.reverse();
  input.sellerReports[0].buyers.reverse();
  const second = buildProofBundle(input);
  assert.equal(first.reportRoot, second.reportRoot);
  assert.deepEqual(first.claimCounts, { P0_CLOSED_LOOP: 1, P1_COORDINATED_CONTROL: 0, P0_RECIPROCAL: 0, total: 1 });
  assert.equal(first.claims[0].dependencies.filter((entry) => entry.evidenceType === "DIRECT_SELLER_FUNDER").length, 1);
});

test("direct-link report code without a locator fails closed", () => {
  const input = fixture();
  input.sellerReports[0].strongestCohort.affiliations.sellerFunder = [];
  assert.throws(() => buildProofBundle(input), /without an exported direct transfer/);
});

function fixture() {
  const settlementsByBuyer = new Map(BUYERS.map((buyer, index) => [buyer, [{
    amountRaw: "400000000",
    timestamp: 100 + index,
    txHash: `0x${String(index + 1).padStart(64, "0")}`,
    blockNumber: 100 + index,
    transactionIndex: 0,
    logIndex: index,
  }]]));
  const sellerReports = [{
    seller: SELLER,
    stats: { volumeRaw: "1200000000", volumeUsdc: 1_200 },
    buyers: BUYERS.map((buyer) => ({ buyer, volumeRaw: "400000000" })),
    evidence: [{ code: "common_funder_concentration" }, { code: "seller_funder_transfer_link" }],
    strongestCohort: {
      funder: FUNDER,
      buyers: BUYERS,
      buyerCount: 3,
      volumeRaw: "1200000000",
      volumeUsdc: 1_200,
      volumeShare: 1,
      affiliations: {
        sellerFunder: [{ from: SELLER, to: FUNDER, amountRaw: "1000000", txHash: `0x${"a".repeat(64)}`, blockNumber: 90, logIndex: 0, timestamp: 90 }],
        sellerBuyer: [],
        sellerFunderIndirect: [],
      },
    },
    networkSignals: { nativeFunderCohorts: [], reciprocalPairs: [] },
  }];
  return {
    scan: { scanId: "scan", version: 1, scoringVersion: "score", networkAnalysisVersion: "network" },
    sellerReports,
    networkAnalysis: { reciprocalPairs: [] },
    settlementAccumulator: { sellerTotals: new Map([[SELLER, { settlementsByBuyer }]]) },
    fundingRecords: BUYERS.map((buyer, index) => ({ buyer, funder: FUNDER, amountRaw: "1000000", kind: "direct", txHash: `0x${String(index + 20).padStart(64, "0")}`, blockNumber: 80 + index, logIndex: 0, timestamp: 80 + index })),
    addressTraces: new Map(),
    startBlock: 1,
    endBlockExclusive: 1_000,
    contracts: { usdc: "0x0", channels: "0x1", deposits: "0x2" },
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeNetwork,
  annotateSellerReports,
  detectReciprocalPairs,
} from "./network-analysis.mjs";
import { accumulateSettlementPage, createSettlementAccumulator } from "./core.mjs";

const period = { from: 1_700_000_000, to: 1_701_000_000 };
const funder = address(900);
const sellerA = address(1);
const sellerB = address(2);
const sellerC = address(3);
const buyers = [address(101), address(102), address(103), address(104)];

test("network analysis reproduces first-native-funder cohort semantics", () => {
  const accumulator = createSettlementAccumulator();
  accumulateSettlementPage(accumulator, [
    settlement(buyers[0], sellerA, 10_000_000n, 10),
    settlement(buyers[1], sellerA, 20_000_000n, 20),
    settlement(buyers[2], sellerB, 30_000_000n, 30),
    settlement(buyers[3], sellerA, 0n, 40),
  ], period);
  const traces = new Map(buyers.map((buyer, index) => [buyer, trace(buyer, funder, 100 + index * 30, "2500000000000000")]));
  const analysis = analyzeNetwork({ settlementAccumulator: accumulator, addressTraces: traces, period });

  assert.equal(analysis.coverage.positiveVolumeBuyers, 3);
  assert.equal(analysis.coverage.buyersWithFirstNativeFunding, 3);
  assert.equal(analysis.fundingCohorts.length, 1);
  assert.deepEqual(analysis.fundingCohorts[0], {
    funder,
    buyersCreated: 3,
    buyers: buyers.slice(0, 3),
    averageSellersPerBuyer: 1,
    exclusiveBuyers: 3,
    exclusiveShare: 1,
    volumeRaw: "60000000",
    volumeUsdc: 60,
    shape: "dedicated",
    topSellers: [
      { seller: sellerA, displayName: null, buyers: 2, buyerAddresses: buyers.slice(0, 2), exclusiveBuyers: 2, volumeRaw: "30000000", volumeUsdc: 30 },
      { seller: sellerB, displayName: null, buyers: 1, buyerAddresses: [buyers[2]], exclusiveBuyers: 1, volumeRaw: "30000000", volumeUsdc: 30 },
    ],
  });
  assert.equal(analysis.fundingBatches.length, 1);
  assert.equal(analysis.fundingBatches[0].buyersFunded, 3);
  assert.equal(analysis.fundingBatches[0].weight, "TRIAGE_ONLY");
});

test("reciprocal pairs are edge-level and enforce volume balance plus settlement count", () => {
  const accumulator = createSettlementAccumulator();
  const items = [];
  for (let index = 0; index < 60; index += 1) {
    items.push(settlement(sellerA, sellerB, 100_000n, index));
    items.push(settlement(sellerB, sellerA, 99_000n, index));
  }
  for (let index = 0; index < 49; index += 1) {
    items.push(settlement(sellerA, sellerC, 100_000n, 100 + index));
    items.push(settlement(sellerC, sellerA, 100_000n, 100 + index));
  }
  items.push(settlement(sellerA, sellerA, 10_000_000n, 500));
  accumulateSettlementPage(accumulator, items, period);

  const pairs = detectReciprocalPairs({ settlementAccumulator: accumulator });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].settlements, 120);
  assert.equal(pairs[0].reciprocity, 0.99);
  assert.equal(pairs[0].grossVolumeUsdc, 11.94);
  assert.deepEqual([pairs[0].walletA, pairs[0].walletB], [sellerA, sellerB]);
});

test("funding batches use a fixed window rather than chaining adjacent transfers", () => {
  const accumulator = createSettlementAccumulator();
  accumulateSettlementPage(accumulator, buyers.map((buyer, index) => settlement(buyer, sellerA, 1_000_000n, index)), period);
  const traces = new Map([
    [buyers[0], trace(buyers[0], funder, 0, "1")],
    [buyers[1], trace(buyers[1], funder, 3_000, "1")],
    [buyers[2], trace(buyers[2], funder, 6_000, "1")],
    [buyers[3], trace(buyers[3], funder, 9_000, "1")],
  ]);
  const thresholds = {
    minimumFunderCohortBuyers: 3,
    mixedExclusiveShare: 0.5,
    dedicatedExclusiveShare: 1,
    minimumFundingBatchBuyers: 2,
    fundingBatchWindowSeconds: 7_200,
    minimumReciprocalSettlements: 100,
    minimumReciprocity: 0.8,
    minimumFlowThroughSettlements: 100,
    minimumFlowThroughBalance: 0.8,
  };
  const analysis = analyzeNetwork({ settlementAccumulator: accumulator, addressTraces: traces, period, thresholds });
  assert.deepEqual(analysis.fundingBatches.map((batch) => batch.buyersFunded), [3]);
});

test("seller reports receive network signals without changing score tiers", () => {
  const accumulator = createSettlementAccumulator();
  accumulateSettlementPage(accumulator, [
    settlement(buyers[0], sellerA, 10_000_000n, 10),
    settlement(buyers[1], sellerA, 20_000_000n, 20),
    settlement(buyers[2], sellerA, 30_000_000n, 30),
  ], period);
  const traces = new Map(buyers.slice(0, 3).map((buyer, index) => [buyer, trace(buyer, funder, 100 + index, "1")]));
  const analysis = analyzeNetwork({ settlementAccumulator: accumulator, addressTraces: traces, period });
  const [report] = annotateSellerReports([{ seller: sellerA, tier: "LOW", score: 0 }], analysis);
  assert.equal(report.tier, "LOW");
  assert.equal(report.score, 0);
  assert.equal(report.networkSignals.nativeFunderCohorts[0].funder, funder);
  assert.deepEqual(report.networkSignals.nativeFunderCohorts[0].buyerAddresses, buyers.slice(0, 3));
  assert.equal(report.networkSignals.fundingBatches[0].batchBuyers, 3);
});

function settlement(buyer, seller, amount, offset) {
  return {
    buyer,
    seller,
    deltaUsdc: amount.toString(),
    platformFeeUsdc: "0",
    inputTokens: "0",
    outputTokens: "0",
    timestamp: period.from + offset,
    txHash: `0x${String(offset).padStart(64, "0")}`,
    channelId: `0x${String(offset + 1).padStart(64, "0")}`,
  };
}

function trace(addressValue, from, offset, amountWei) {
  return {
    address: addressValue,
    complete: true,
    inboundUsdc: [],
    outboundUsdc: [],
    firstNativeFunding: {
      from,
      amountWei,
      timestamp: period.from + offset,
      txHash: `0x${String(offset).padStart(64, "0")}`,
    },
    errors: [],
  };
}

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  accumulateSettlementPage,
  accumulateServiceSalesPage,
  analyzeSeller,
  buildAnalysisContext,
  createSettlementAccumulator,
  createServiceSalesAccumulator,
  detectSellerFunderRelayPaths,
  detectSellerPassThroughPaths,
  resolveHistoricalPeriod,
  selectDirectFunderTraceCandidates,
  selectRelayTraceCandidates,
} from "./core.mjs";

const seller = address(1);
const otherSeller = address(2);
const funder = address(900);
const buyers = Array.from({ length: 5 }, (_, index) => address(100 + index));
const period = {
  from: 1_700_000_000,
  to: 1_701_000_000,
  fromIso: "2023-11-14T22:13:20.000Z",
  toIso: "2023-11-26T12:00:00.000Z",
  allHistory: true,
  fromSource: "earliest-indexed-antseed-activity",
  toSource: "scan-start",
};

test("resolves all-history boundaries from the earliest indexed event", () => {
  const resolved = resolveHistoricalPeriod({
    sellers: [{ firstSeenAt: 1_700_000_100 }],
    channels: [{ openedAt: 1_700_000_050 }],
    firstDeposits: [{ timestamp: 1_700_000_025 }],
    accounts: [{ firstSeenAt: 1_700_000_075 }],
    settlementEarliest: 1_700_000_010,
    scanStartedAt: 1_701_000_000_000,
  });
  assert.equal(resolved.from, 1_700_000_010);
  assert.equal(resolved.to, 1_701_000_000);
  assert.equal(resolved.allHistory, true);
});

test("date overrides replace only the requested period boundary", () => {
  const resolved = resolveHistoricalPeriod({
    sellers: [{ firstSeenAt: 1_700_000_100 }],
    settlementEarliest: 1_700_000_010,
    fromOverride: 1_700_100_000,
    scanStartedAt: 1_701_000_000_000,
  });
  assert.equal(resolved.from, 1_700_100_000);
  assert.equal(resolved.to, 1_701_000_000);
  assert.equal(resolved.fromSource, "cli-override");
  assert.equal(resolved.toSource, "scan-start");
});

test("settlement aggregation preserves integer USDC totals before formatting", () => {
  const accumulator = createSettlementAccumulator();
  const amount = 9_007_199_254_740_993n;
  accumulateSettlementPage(accumulator, [
    settlement(buyers[0], seller, amount, period.from + 1),
    settlement(buyers[0], seller, amount, period.from + 2),
  ], period);
  assert.equal(accumulator.sellerTotals.get(seller).volumeRaw, amount * 2n);
});

test("service sales aggregate realized model pricing", () => {
  const accumulator = createServiceSalesAccumulator();
  const serviceId = `0x${"ab".repeat(32)}`;
  accumulateServiceSalesPage(accumulator, [{
    id: "service-sale",
    seller,
    buyer: buyers[0],
    serviceId,
    deltaAmountUsdc: "5000000",
    deltaInputTokens: "700000",
    deltaCachedInputTokens: "100000",
    deltaOutputTokens: "200000",
    deltaRequestCount: "10",
    timestamp: period.from + 1,
  }], period);
  const context = coordinatedContext({ complete: true });
  context.serviceSalesBySeller = accumulator.bySeller;
  context.serviceCatalogBySeller = new Map([[seller, new Map([[serviceId, {
    service: "example-model",
    provider: "openai",
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 12,
    observedAt: "2026-08-12T00:00:00.000Z",
  }]])]]);
  const report = analyzeSeller(seller, context);
  assert.equal(report.modelSales[0].model, "example-model");
  assert.equal(report.modelSales[0].volumeUsdc, 5);
  assert.equal(report.modelSales[0].realizedUsdPerMillionTotalTokens, 5);
  assert.equal(report.modelSales[0].realizedUsdPerRequest, 0.5);
});

test("seller payments link to later buyer deposits and seller usage", () => {
  const accumulator = createSettlementAccumulator();
  accumulateSettlementPage(accumulator, [{
    ...settlement(buyers[0], seller, 5_000_000n, period.from + 300),
    txHash: tx(300),
    channelId: tx(301),
  }], period);
  const sellerTrace = completeTrace(seller);
  sellerTrace.outboundUsdc.push({
    from: seller,
    to: buyers[0],
    amountRaw: "20000000",
    timestamp: period.from + 100,
    txHash: tx(100),
    logIndex: 0,
  });
  const context = buildAnalysisContext({
    sellers: [{ address: seller }],
    channels: [channel({ buyer: buyers[0], index: 0, openedAt: period.from + 250 })],
    firstDeposits: [],
    settlementAccumulator: accumulator,
    fundingRecords: [{
      buyer: buyers[0],
      funder: buyers[0],
      amountRaw: "20000000",
      timestamp: period.from + 200,
      txHash: tx(200),
      kind: "protocol_deposit",
    }],
    addressTraces: new Map([[seller, sellerTrace], [buyers[0], completeTrace(buyers[0])]]),
    period,
    protocolDepositsComplete: true,
  });
  const report = analyzeSeller(seller, context);
  assert.equal(report.sellerFundFlows.returnPathSummary.pathCount, 1);
  assert.equal(report.sellerFundFlows.returnPathSummary.exactAmountMatches, 1);
  assert.equal(report.sellerFundFlows.returnPathSummary.followedBySellerUsage, 1);
  assert.deepEqual(report.sellerFundFlows.returnPaths[0], {
    buyer: buyers[0],
    seller,
    classification: "strong_temporal_match",
    sellerPaymentRaw: "20000000",
    sellerPaymentUsdc: 20,
    sellerPaymentAt: period.from + 100,
    sellerPaymentTx: tx(100),
    depositRaw: "20000000",
    depositUsdc: 20,
    depositAt: period.from + 200,
    depositTx: tx(200),
    depositFunder: buyers[0],
    exactDepositAmountMatch: true,
    depositDelaySeconds: 100,
    firstSellerUsageRaw: "5000000",
    firstSellerUsageUsdc: 5,
    firstSellerUsageAt: period.from + 300,
    firstSellerUsageTx: tx(300),
    usageDelaySeconds: 100,
    lifetimeSellerVolumeUsdc: 5,
    caveat: "Sequence and amount correlation only; fungible USDC identity is not proven.",
  });
});

test("repeated seller payouts through a relay detect an indirect cohort-funder path", () => {
  const relay = address(700);
  const intermediary = address(701);
  const sellerTrace = completeTrace(seller);
  const relayTrace = completeTrace(relay);
  const funderTrace = completeTrace(funder);
  for (let index = 0; index < 3; index += 1) {
    const amountRaw = BigInt(200_000_000 + index * 10_000_000);
    sellerTrace.outboundUsdc.push(transfer(seller, relay, amountRaw, period.from + index * 1_000, index * 3));
    relayTrace.outboundUsdc.push(transfer(relay, intermediary, amountRaw, period.from + index * 1_000 + 20, index * 3 + 1));
    funderTrace.inboundUsdc.push(transfer(intermediary, funder, amountRaw - 14_000n, period.from + index * 1_000 + 60, index * 3 + 2));
  }
  const paths = detectSellerFunderRelayPaths({
    seller,
    funder,
    sellerTrace,
    addressTraces: new Map([[seller, sellerTrace], [relay, relayTrace], [funder, funderTrace]]),
  });
  assert.equal(paths.length, 3);
  assert.equal(paths[0].relay, relay);
  assert.equal(paths[0].intermediary, intermediary);
  assert.ok(paths.every((path) => path.forwardedShare > 0.999));
});

test("relay detection rejects unrelated or materially different downstream transfers", () => {
  const relay = address(710);
  const intermediary = address(711);
  const sellerTrace = completeTrace(seller);
  const relayTrace = completeTrace(relay);
  const funderTrace = completeTrace(funder);
  sellerTrace.outboundUsdc.push(transfer(seller, relay, 200_000_000n, period.from, 1));
  relayTrace.outboundUsdc.push(transfer(relay, intermediary, 200_000_000n, period.from + 10, 2));
  funderTrace.inboundUsdc.push(transfer(intermediary, funder, 100_000_000n, period.from + 20, 3));
  const paths = detectSellerFunderRelayPaths({
    seller,
    funder,
    sellerTrace,
    addressTraces: new Map([[seller, sellerTrace], [relay, relayTrace], [funder, funderTrace]]),
  });
  assert.deepEqual(paths, []);
});

test("repeated material seller payouts forwarded to one destination are classified as pass-through paths", () => {
  const recipient = address(712);
  const destination = address(713);
  const sellerTrace = completeTrace(seller);
  const recipientTrace = completeTrace(recipient);
  for (let index = 0; index < 3; index += 1) {
    const amountRaw = BigInt(500_000_000 + index * 100_000_000);
    sellerTrace.outboundUsdc.push(transfer(seller, recipient, amountRaw, period.from + index * 1_000, index * 2));
    recipientTrace.outboundUsdc.push(transfer(recipient, destination, amountRaw, period.from + index * 1_000 + 180, index * 2 + 1));
  }
  const paths = detectSellerPassThroughPaths({
    seller,
    sellerTrace,
    addressTraces: new Map([[seller, sellerTrace], [recipient, recipientTrace]]),
  });
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => path.recipient === recipient && path.destination === destination));
  assert.ok(paths.every((path) => path.forwardedShare === 1 && path.delaySeconds === 180));
});

test("pass-through detection rejects one-off and immaterial routes", () => {
  const recipient = address(714);
  const destination = address(715);
  const sellerTrace = completeTrace(seller);
  const recipientTrace = completeTrace(recipient);
  sellerTrace.outboundUsdc.push(transfer(seller, recipient, 50_000_000n, period.from, 1));
  recipientTrace.outboundUsdc.push(transfer(recipient, destination, 50_000_000n, period.from + 30, 2));
  sellerTrace.outboundUsdc.push(transfer(seller, recipient, 40_000_000n, period.from + 1_000, 3));
  recipientTrace.outboundUsdc.push(transfer(recipient, destination, 40_000_000n, period.from + 1_030, 4));
  assert.deepEqual(detectSellerPassThroughPaths({
    seller,
    sellerTrace,
    addressTraces: new Map([[seller, sellerTrace], [recipient, recipientTrace]]),
  }), []);
});

test("dominant relay candidates are selected generically and bounded per seller", () => {
  const sellerTrace = completeTrace(seller);
  const largeRepeated = address(720);
  const secondRepeated = address(721);
  const tinyRepeated = address(722);
  const oneOff = address(723);
  sellerTrace.outboundUsdc.push(
    transfer(seller, largeRepeated, 200_000_000n, period.from, 1),
    transfer(seller, largeRepeated, 200_000_000n, period.from + 1, 2),
    transfer(seller, secondRepeated, 100_000_000n, period.from + 2, 3),
    transfer(seller, secondRepeated, 100_000_000n, period.from + 3, 4),
    transfer(seller, tinyRepeated, 1_000n, period.from + 4, 5),
    transfer(seller, tinyRepeated, 1_000n, period.from + 5, 6),
    transfer(seller, oneOff, 900_000_000n, period.from + 6, 7),
  );
  assert.deepEqual(selectRelayTraceCandidates({
    sellers: [seller],
    addressTraces: new Map([[seller, sellerTrace]]),
    maxPerSeller: 2,
  }), [largeRepeated, secondRepeated].sort());
});

test("direct funder tracing selects only shared material cohort sources", () => {
  const sharedFunder = address(730);
  const tinySharedFunder = address(731);
  const soloFunder = address(732);
  const records = [
    ...buyers.slice(0, 3).map((buyer, index) => ({ buyer, funder: sharedFunder, amountRaw: "50000000", timestamp: period.from + index })),
    ...buyers.slice(0, 3).map((buyer, index) => ({ buyer, funder: tinySharedFunder, amountRaw: "1000", timestamp: period.from + index })),
    { buyer: buyers[0], funder: soloFunder, amountRaw: "500000000", timestamp: period.from },
  ];
  assert.deepEqual(selectDirectFunderTraceCandidates({ records }), [sharedFunder]);
  assert.deepEqual(selectDirectFunderTraceCandidates({ records, excludedAddresses: new Set([sharedFunder]) }), []);
});

test("Flash-like coordinated usage becomes critical without claiming seller ownership", () => {
  const report = analyzeSeller(seller, coordinatedContext({ complete: true }));
  assert.equal(report.tier, "CRITICAL");
  assert.equal(report.label, "critical coordinated-usage risk");
  assert.ok(report.score >= 75);
  assert.equal(report.familyScores.sellerAffiliation, 0);
  assert.ok(report.evidence.some((entry) => entry.code === "repeated_equal_funding_waves"));
  assert.equal(report.fundingProvenance.sourceCount, 1);
  assert.equal(report.fundingProvenance.sources[0].funder, funder);
  assert.equal(report.fundingProvenance.sources[0].buyerCount, buyers.length);
  assert.equal(report.fundingProvenance.sources[0].fundedAmountUsdc, 250);
  assert.equal(report.strongestCohort.reopenCadence.medianBuyerGapSeconds, 300);
  assert.equal(report.strongestCohort.reopenCadence.medianWithin60Share, 0);
  assert.ok(report.buyers.every((buyer) => buyer.medianReopenGapSeconds === 300));
  assert.equal(report.dependenceAnalysis.coordinatedVolumeEstimate.buyerCount, buyers.length);
  assert.equal(report.dependenceAnalysis.thresholds.find((entry) => entry.threshold === 0.99).buyerCount, buyers.length);
  assert.equal(report.dependenceAnalysis.bins.reduce((total, entry) => total + entry.buyerCount, 0), buyers.length);
  assert.equal(report.sellerFundFlows.status, "complete");
  assert.equal(report.sellerFundFlows.affiliatedRecipientCount, 0);
});

test("a generic repeated relay path contributes seller-link evidence to the analyzed seller", () => {
  const relay = address(740);
  const intermediary = address(741);
  const context = coordinatedContext({ complete: true });
  const sellerTrace = context.addressTraces.get(seller);
  const funderTrace = context.addressTraces.get(funder);
  const relayTrace = completeTrace(relay);
  for (let index = 0; index < 3; index += 1) {
    const amountRaw = BigInt(300_000_000 + index * 10_000_000);
    sellerTrace.outboundUsdc.push(transfer(seller, relay, amountRaw, period.from + index * 1_000, index * 3));
    relayTrace.outboundUsdc.push(transfer(relay, intermediary, amountRaw, period.from + index * 1_000 + 20, index * 3 + 1));
    funderTrace.inboundUsdc.push(transfer(intermediary, funder, amountRaw - 20_000n, period.from + index * 1_000 + 60, index * 3 + 2));
  }
  context.addressTraces.set(relay, relayTrace);
  const report = analyzeSeller(seller, context);
  assert.equal(report.familyScores.sellerAffiliation, 5);
  assert.equal(report.label, "possible wash-trading pattern with seller-link evidence");
  assert.equal(report.sellerFundFlows.indirectFunderSummary.pathCount, 3);
  assert.equal(report.sellerFundFlows.recipients.find((recipient) => recipient.recipient === relay)?.relation, "relay_to_buyer_funder");
  assert.ok(report.evidence.some((entry) => entry.code === "seller_funder_relay_path"));
});

test("incomplete external evidence prevents critical classification and remains provisional", () => {
  const report = analyzeSeller(seller, coordinatedContext({ complete: false }));
  assert.equal(report.tier, "HIGH");
  assert.equal(report.provisional, true);
  assert.equal(report.completeness.status, "unavailable");
  assert.ok(report.cautions.some((entry) => entry.includes("critical classification is disabled")));
});

test("a common funder alone cannot produce high or critical risk", () => {
  const accumulator = createSettlementAccumulator();
  const settlements = buyers.slice(0, 3).map((buyer, index) => settlement(buyer, seller, 100_000_000n, period.from + 100 + index));
  accumulateSettlementPage(accumulator, settlements, period);
  const channels = buyers.slice(0, 3).flatMap((buyer, buyerIndex) => Array.from({ length: 7 }, (_, index) => channel({
    buyer,
    index,
    openedAt: period.from + buyerIndex * 50_000 + index * 4_000,
    requestCount: buyerIndex * 20 + index,
    settlementCount: buyerIndex + 1,
    maxAmountUsdc: String((buyerIndex + 1) * 1_000_000),
  })));
  const fundingRecords = buyers.slice(0, 3).map((buyer, index) => ({ buyer, funder, amountRaw: "10000000", timestamp: period.from - 10_000 - index * 1_000, txHash: tx(index), kind: "protocol_deposit" }));
  const traces = new Map([[seller, completeTrace(seller)], ...buyers.slice(0, 3).map((buyer) => [buyer, completeTrace(buyer)])]);
  const context = buildAnalysisContext({ sellers: [{ address: seller }], channels, firstDeposits: [], settlementAccumulator: accumulator, fundingRecords, addressTraces: traces, period, protocolDepositsComplete: true });
  const report = analyzeSeller(seller, context);
  assert.ok(["LOW", "MEDIUM"].includes(report.tier));
});

test("independent buyers with independent funding remain low risk", () => {
  const accumulator = createSettlementAccumulator();
  const settlements = buyers.slice(0, 3).map((buyer, index) => settlement(buyer, seller, 10_000_000n, period.from + index));
  accumulateSettlementPage(accumulator, settlements, period);
  const channels = buyers.slice(0, 3).map((buyer, index) => channel({ buyer, index, openedAt: period.from + index * 100_000, requestCount: index * 10 + 1 }));
  const fundingRecords = buyers.slice(0, 3).map((buyer, index) => ({ buyer, funder: address(950 + index), amountRaw: "10000000", timestamp: period.from - index * 50_000, txHash: tx(index), kind: "protocol_deposit" }));
  const traces = new Map([[seller, completeTrace(seller)], ...buyers.slice(0, 3).map((buyer) => [buyer, completeTrace(buyer)])]);
  const context = buildAnalysisContext({ sellers: [{ address: seller }], channels, firstDeposits: [], settlementAccumulator: accumulator, fundingRecords, addressTraces: traces, period, protocolDepositsComplete: true });
  assert.equal(analyzeSeller(seller, context).tier, "LOW");
});

function coordinatedContext({ complete }) {
  const accumulator = createSettlementAccumulator();
  const settlements = [];
  for (const buyer of buyers) {
    settlements.push(settlement(buyer, seller, 100_000_000n, period.from + 100));
    settlements.push(settlement(buyer, otherSeller, 1_000_000n, period.from + 200));
  }
  accumulateSettlementPage(accumulator, settlements, period);

  const channels = buyers.flatMap((buyer, buyerIndex) => Array.from({ length: 20 }, (_, index) => channel({
    buyer,
    index,
    openedAt: period.from + index * 600 + buyerIndex * 8,
    requestCount: 10,
    settlementCount: 2,
    maxAmountUsdc: "1000000",
  })));
  const fundingRecords = [];
  for (let wave = 0; wave < 5; wave += 1) {
    for (let buyerIndex = 0; buyerIndex < buyers.length; buyerIndex += 1) {
      fundingRecords.push({
        buyer: buyers[buyerIndex],
        funder,
        amountRaw: "10000000",
        timestamp: period.from - 10_000 + wave * 1_000 + buyerIndex * 8,
        txHash: tx(wave * 10 + buyerIndex),
        kind: "protocol_deposit",
      });
    }
  }
  const traces = new Map([[seller, completeTrace(seller)], [funder, completeTrace(funder)]]);
  for (const buyer of buyers) traces.set(buyer, complete ? completeTrace(buyer) : { ...completeTrace(buyer), complete: false, errors: ["rate limited"] });
  return buildAnalysisContext({
    sellers: [{ address: seller }],
    channels,
    firstDeposits: [],
    settlementAccumulator: accumulator,
    fundingRecords,
    addressTraces: traces,
    period,
    protocolDepositsComplete: complete,
  });
}

function settlement(buyer, targetSeller, amount, timestamp) {
  return { id: tx(timestamp + Number(amount % 97n)), buyer, seller: targetSeller, deltaUsdc: amount.toString(), platformFeeUsdc: "0", inputTokens: "10", outputTokens: "20", timestamp };
}

function channel({ buyer, index, openedAt, requestCount = 10, settlementCount = 2, maxAmountUsdc = "1000000" }) {
  return {
    id: `${buyer}-${index}`,
    buyer,
    seller,
    openedAt,
    closedAt: openedAt + 300,
    lastSettledAt: openedAt + 250,
    requestCount,
    settlementCount,
    maxAmountUsdc,
  };
}

function completeTrace(addressValue) {
  return { address: addressValue, complete: true, inboundUsdc: [], outboundUsdc: [], firstNativeFunding: null, errors: [] };
}

function transfer(from, to, amountRaw, timestamp, index) {
  return { from, to, amountRaw: amountRaw.toString(), timestamp, txHash: tx(10_000 + index), logIndex: index };
}

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function tx(value) {
  return `0x${Math.abs(value).toString(16).padStart(64, "0")}`;
}

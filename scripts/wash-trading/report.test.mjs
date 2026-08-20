import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyFinalVerdict, summarizePriorityVolumes, writeScanArtifacts } from "./report.mjs";

test("summarizePriorityVolumes uses attributed P1 cohort volume", () => {
  const base = sellerFixture();
  const cohortBuyers = [
    "0x0000000000000000000000000000000000000011",
    "0x0000000000000000000000000000000000000012",
    "0x0000000000000000000000000000000000000013",
  ];
  const p1Seller = {
    ...base,
    stats: { ...base.stats, volumeUsdc: 1_500 },
    dependenceAnalysis: { ...base.dependenceAnalysis, thresholds: [{ threshold: 0.99, sellerVolumeUsdc: 1_200 }] },
    buyers: cohortBuyers.map((buyer, index) => ({
      buyer,
      volumeRaw: ["400000000", "350000000", "250000000"][index],
      volumeUsdc: [400, 350, 250][index],
    })),
    networkSignals: { reciprocalPairs: [], nativeFunderCohorts: [{ funder: "0x1", buyers: 3, buyerAddresses: cohortBuyers, volumeUsdc: 1_000 }] },
  };
  const summary = summarizePriorityVolumes([base, p1Seller], networkFixture());

  assert.equal(summary.totalSettledVolumeUsdc, 1_510);
  assert.deepEqual(summary.suspectedSettledVolumeUsdc, {
    P0: 19.9,
    P1: 1_000,
    combinedP0P1: 1_019.9,
  });
  assert.deepEqual(summary.findingCounts, { P0: 1, P1: 1 });
  assert.match(summary.caveat, /not definitive measurements of wash trading/);
});

test("classifyFinalVerdict returns only P0 or P1 findings", () => {
  const base = sellerFixture();
  assert.equal(classifyFinalVerdict(base), null);

  const reciprocal = classifyFinalVerdict({
    ...base,
    tier: "LOW",
    networkSignals: { reciprocalPairs: [{ walletA: base.seller }], nativeFunderCohorts: [] },
  });
  assert.equal(reciprocal.confidence, "CONFIRMED");
  assert.equal(reciprocal.priority, "P0");

  const nativeControl = classifyFinalVerdict({
    ...base,
    tier: "LOW",
    stats: { ...base.stats, volumeUsdc: 1_500 },
    networkSignals: { reciprocalPairs: [], nativeFunderCohorts: [{ funder: "0x1", buyers: 3, volumeUsdc: 1_000 }] },
  });
  assert.equal(nativeControl.confidence, "STRONG_LEAD");
  assert.equal(nativeControl.priority, "P1");

  const primaryUsdcSeller = {
    ...base,
    tier: "LOW",
    stats: { ...base.stats, volumeUsdc: 2_000 },
    strongestCohort: { ...base.strongestCohort, buyerCount: 3, volumeUsdc: 1_500, volumeShare: 0.75 },
    networkSignals: { reciprocalPairs: [], nativeFunderCohorts: [] },
  };
  const primaryUsdcControl = classifyFinalVerdict(primaryUsdcSeller);
  assert.equal(primaryUsdcControl.confidence, "STRONG_LEAD");
  assert.equal(primaryUsdcControl.priority, "P1");

  const closedLoop = classifyFinalVerdict({
    ...primaryUsdcSeller,
    evidence: [...primaryUsdcSeller.evidence, { code: "seller_funder_transfer_link" }],
  });
  assert.equal(closedLoop.confidence, "STRONG_LEAD");
  assert.equal(closedLoop.priority, "P0");

  assert.equal(classifyFinalVerdict({
    ...base,
    tier: "LOW",
    networkSignals: { reciprocalPairs: [], nativeFunderCohorts: [] },
  }), null);
  assert.equal(classifyFinalVerdict({
    ...base,
    tier: "LOW",
    stats: { ...base.stats, volumeUsdc: 5_000 },
    networkSignals: { reciprocalPairs: [], nativeFunderCohorts: [{ funder: "0x1", buyers: 1, volumeUsdc: 4_000 }] },
  }), null);
  assert.equal(classifyFinalVerdict({ ...base, tier: "LOW", networkSignals: undefined }), null);
});

test("P1 attribution counts buyers shared by ETH and USDC cohorts once", () => {
  const base = sellerFixture();
  const cohortBuyers = [
    "0x0000000000000000000000000000000000000011",
    "0x0000000000000000000000000000000000000012",
    "0x0000000000000000000000000000000000000013",
  ];
  const seller = {
    ...base,
    stats: { ...base.stats, volumeUsdc: 2_000, buyers: 3 },
    buyers: cohortBuyers.map((buyer, index) => ({
      buyer,
      volumeRaw: ["600000000", "500000000", "400000000"][index],
      volumeUsdc: [600, 500, 400][index],
    })),
    strongestCohort: {
      ...base.strongestCohort,
      buyers: cohortBuyers,
      buyerCount: 3,
      volumeUsdc: 1_500,
      volumeShare: 0.75,
    },
    networkSignals: {
      reciprocalPairs: [],
      nativeFunderCohorts: [{ funder: "0x1", buyers: 3, buyerAddresses: cohortBuyers, volumeUsdc: 1_500 }],
    },
  };

  const verdict = classifyFinalVerdict(seller);
  assert.equal(verdict.priority, "P1");
  assert.equal(verdict.attributedBuyerCount, 3);
  assert.equal(verdict.attributedVolumeRaw, "1500000000");
  assert.equal(verdict.attributedVolumeUsdc, 1_500);
});

test("dashboard artifacts work without runtime fetch calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antseed-wash-report-"));
  try {
    const artifacts = await writeScanArtifacts(directory, scanFixture(), [sellerFixture()], networkFixture());
    const html = await readFile(artifacts.reportPath, "utf8");
    const data = await readFile(join(directory, "assets", "report-data.js"), "utf8");
    const summary = JSON.parse(await readFile(artifacts.summaryPath, "utf8"));
    const fundersCsv = await readFile(artifacts.fundersPath, "utf8");
    const reciprocalPairsCsv = await readFile(artifacts.reciprocalPairsPath, "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /\.\/assets\/report-data\.js/);
    assert.match(html, /Buyer funding control/);
    assert.match(html, /Funding source to buyers to seller graph/);
    assert.doesNotMatch(html, /Median reopen gap/);
    assert.doesNotMatch(html, /Repeated funding waves scatter chart/);
    assert.doesNotMatch(html, /Cumulative seller volume by buyer dependence/);
    assert.match(html, /Seller money-flow links/);
    assert.match(html, /Observed circular-funding sequences/);
    assert.equal((html.match(/Observed circular-funding sequences/g) ?? []).length, 1);
    assert.match(html, /sequence-group/);
    assert.match(html, /Seller payment → buyer deposit → seller usage/);
    assert.match(html, /Direct payment → deposit paths/);
    assert.match(html, /Repeated multi-hop path into the buyer-cohort funder/);
    assert.match(html, /combine seller-outflow paths that reach the buyer-cohort funder/);
    assert.match(html, /near-total forward to cohort funder/);
    assert.match(html, /Downstream sequence/);
    assert.match(html, /matched path/);
    assert.match(html, /pathsByRelay/);
    assert.match(html, /USDC is fungible/);
    assert.match(html, /Models sold and realized pricing/);
    assert.match(html, /Realized \$\/request/);
    assert.match(html, /Model-attributed settled revenue/);
    assert.match(html, /data-coverage figures, not performance scores/);
    assert.doesNotMatch(html, /Revenue coverage/);
    assert.match(html, /Current advertised input \/ output/);
    assert.match(html, /Seller \/ verdict \/ why flagged/);
    assert.match(html, /Flagged \/ total volume/);
    assert.match(html, /Attributed cohort/);
    assert.match(html, /<th>Reciprocity<\/th>/);
    assert.match(html, /reason-tag/);
    assert.match(html, /\.reason-tag,\.reason-tag\.graph,\.reason-tag\.confirmed/);
    assert.match(html, /reason-tooltip/);
    assert.match(html, /data-reason/);
    assert.match(html, /showReasonTooltip/);
    assert.match(html, /addEventListener\('mouseover'/);
    assert.match(html, /Shared first ETH funder/);
    assert.match(html, /Shared primary USDC funder/);
    assert.doesNotMatch(html, />Shared first funder</);
    assert.doesNotMatch(html, />Shared funder</);
    assert.match(html, /Reciprocal payments/);
    assert.match(html, /Seller–funder money link/);
    assert.match(html, /Seller–buyer money link/);
    assert.match(html, /Money returns through relays/);
    assert.doesNotMatch(html, /P2|P3|P2_P3/);
    assert.doesNotMatch(html, /Timed together/);
    assert.doesNotMatch(html, /add\('Exact-value funding'/);
    assert.match(html, /≥99% seller-dependent \/ total seller volume/);
    assert.match(html, /confirmed pair gross \/ combined seller volume/);
    assert.match(html, /Reciprocal loop wallet pair/);
    assert.doesNotMatch(html, /<th>Seller screen<\/th>/);
    assert.doesNotMatch(html, /Not applicable<br>edge-level graph verdict/);
    assert.match(html, /\.sort\(\(a,b\)=>b\.suspectedVolumeUsdc-a\.suspectedVolumeUsdc/);
    assert.match(html, /s\.finalVerdict\.confidence!==\'CONFIRMED\'/);
    assert.match(html, /history\.pushState\(\{antseedSeller:true\}/);
    assert.match(html, /addEventListener\('popstate',syncSellerRoute\)/);
    assert.match(html, /Total settled volume/);
    assert.match(html, /P0 suspected volume/);
    assert.match(html, /P1 attributed volume/);
    assert.match(html, /Combined P0–P1 flagged volume/);
    assert.match(html, /Final P0–P1 verdicts/);
    assert.match(html, /id="methodology-open"/);
    assert.match(html, /How this report detects suspected wash trading/);
    assert.match(html, /100 combined settlements/);
    assert.match(html, /80% volume reciprocity/);
    assert.match(html, /3 buyers/);
    assert.match(html, /\$1,000 settled volume/);
    assert.match(html, /50% of seller volume/);
    assert.match(html, /P0–P1 reason labels/);
    assert.match(html, /Exact implemented rule/);
    assert.doesNotMatch(html, /Exact-value native funding batches/);
    assert.match(html, /openMethodology/);
    assert.match(html, /closeMethodology/);
    assert.match(html, /Supporting network evidence/);
    assert.match(html, /First native-funder cohorts/);
    assert.doesNotMatch(html, /<h3>Confirmed reciprocal settlement pairs<\/h3>/);
    assert.match(html, /s\.strongestCohort\.buyerCount/);
    assert.doesNotMatch(html, /s\.strongestCohort\.buyers\+' buyers'/);
    assert.match(html, /findingEvidenceCodes/);
    assert.match(html, /finding\.verdict\.priority===els\.verdict\.value/);
    assert.match(html, /Suspected coordinated \/ wash-trading volume/);
    assert.match(html, /Suspected seller-dependent volume share/);
    assert.match(html, /Suspected near-exclusive buyers/);
    assert.match(html, /material P1 cohort settlements \/ total seller volume/);
    assert.match(html, /p1Sources/);
    assert.match(html, /P1 attributed volume share/);
    assert.match(html, /overlapping ETH and USDC cohorts count once/);
    assert.doesNotMatch(html, /Buyer dependence and funding patterns/);
    assert.doesNotMatch(html, /flow-through|reopen|similarity/i);
    assert.match(html, /not a definitive measurement of wash trading/);
    assert.doesNotMatch(html, /\bfetch\s*\(/);
    const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new Function(inlineScript));
    assert.match(data, /^window\.__ANTSEED_WASH_SCAN__=/);
    assert.match(data, /0000000000000000000000000000000000000004/);
    assert.match(data, /0000000000000000000000000000000000000005/);
    assert.match(data, /Fixture Seller/);
    assert.match(data, /"volumeSummary"/);
    assert.match(data, /"networkAnalysis"/);
    assert.match(data, /"finalVerdict":null/);
    assert.doesNotMatch(data, /P2|P3|P2_P3|flowThrough|fundingBatches/);
    assert.match(data, /P1 attributed volume sums unique settlements/);
    assert.doesNotThrow(() => new Function(data));
    assert.deepEqual(summary.volumeSummary.suspectedSettledVolumeUsdc, {
      P0: 19.9,
      P1: 0,
      combinedP0P1: 19.9,
    });
    assert.deepEqual(summary.volumeSummary.findingCounts, { P0: 1, P1: 0 });
    assert.equal(summary.volumeSummary.totalSettledVolumeUsdc, 10);
    assert.equal(summary.networkAnalysis.counts.reciprocalPairs, 1);
    assert.match(fundersCsv, /^"funder","buyers_created"/);
    assert.match(fundersCsv, /Fixture Seller/);
    assert.match(reciprocalPairsCsv, /^"wallet_a","wallet_b"/);
    assert.match(reciprocalPairsCsv, /"101","0\.990"/);
    assert.equal(summary.sellers[0].displayName, "Fixture Seller");
    assert.ok(await readFile(join(directory, "sellers", `${sellerFixture().seller}.json`), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function scanFixture() {
  return {
    version: 1,
    kind: "antseed-historical-wash-trading-scan",
    scanId: "fixture",
    scoringVersion: "conservative-v2",
    generatedAt: "2026-08-11T00:00:00.000Z",
    status: "complete",
    period: { from: 1, to: 2, fromIso: "1970-01-01T00:00:01.000Z", toIso: "1970-01-01T00:00:02.000Z", allHistory: true },
    sources: { antscan: "https://antscan.co", blockscout: "https://base.blockscout.com" },
    counts: { buyers: 1 },
  };
}

function networkFixture() {
  const fixtureSeller = sellerFixture().seller;
  const walletA = "0x0000000000000000000000000000000000000006";
  const walletB = "0x0000000000000000000000000000000000000007";
  return {
    version: "network-graph-v1",
    thresholds: { minimumFunderCohortBuyers: 3 },
    coverage: { positiveVolumeBuyers: 3, buyersWithFirstNativeFunding: 3, firstNativeFundingShare: 1 },
    counts: { fundingCohorts: 1, fundingBatches: 1, reciprocalPairs: 1, reciprocalWallets: 2, flowThroughWallets: 0 },
    findings: [{ decisiveSignal: "settlement_reciprocity", grossVolumeUsdc: 20, settlementCount: 101 }],
    caveats: ["Fixture caveat."],
    fundingCohorts: [{
      funder: "0x0000000000000000000000000000000000000002",
      buyersCreated: 3,
      buyers: ["0x0000000000000000000000000000000000000003"],
      averageSellersPerBuyer: 1,
      exclusiveBuyers: 3,
      exclusiveShare: 1,
      volumeRaw: "10000000",
      volumeUsdc: 10,
      shape: "dedicated",
      topSellers: [{ seller: fixtureSeller, displayName: "Fixture Seller", buyers: 3, exclusiveBuyers: 3, volumeRaw: "10000000", volumeUsdc: 10 }],
    }],
    fundingBatches: [{
      funder: "0x0000000000000000000000000000000000000002",
      amountWei: "1000000000000000",
      buyersFunded: 3,
      buyers: ["0x0000000000000000000000000000000000000003"],
      exclusiveBuyers: 3,
      exclusiveShare: 1,
      firstAt: 1,
      lastAt: 2,
      spanSeconds: 1,
      volumeRaw: "10000000",
      volumeUsdc: 10,
      sellers: [{ seller: fixtureSeller, displayName: "Fixture Seller", buyers: 3, exclusiveBuyers: 3, volumeRaw: "10000000", volumeUsdc: 10 }],
      weight: "TRIAGE_ONLY",
    }],
    reciprocalPairs: [{
      walletA,
      walletAName: null,
      walletB,
      walletBName: null,
      volumeAToBRaw: "10000000",
      volumeAToBUsdc: 10,
      volumeBToARaw: "9900000",
      volumeBToAUsdc: 9.9,
      grossVolumeRaw: "19900000",
      grossVolumeUsdc: 19.9,
      settlements: 101,
      reciprocity: 0.99,
      firstAt: 1,
      lastAt: 2,
      confidence: "CONFIRMED",
    }],
    flowThroughWallets: [],
  };
}

function sellerFixture() {
  const seller = "0x0000000000000000000000000000000000000001";
  return {
    version: 1,
    seller,
    displayName: "Fixture Seller",
    peerId: seller.slice(2),
    tier: "MEDIUM",
    label: "review recommended",
    score: 30,
    maxAssessableScore: 100,
    provisional: false,
    completeness: { status: "complete", protocolDepositsComplete: true, cohortAddressesComplete: 1, cohortAddressesTotal: 1 },
    familyScores: { fundingControl: 12, temporalCoordination: 0, behavioralSimilarity: 0, buyerDependence: 18, sellerAffiliation: 0 },
    evidence: [{ family: "fundingControl", code: "common_funder_concentration", points: 12, summary: "Shared funding", metrics: {} }],
    cautions: [],
    stats: { volumeUsdc: 10, buyers: 1, channels: 1, requests: 1, firstActivityAt: 1, lastActivityAt: 2 },
    strongestCohort: { funder: "0x0000000000000000000000000000000000000002", buyers: ["0x0000000000000000000000000000000000000003"], volumeShare: 1, synchronizedChannelShare: 0, reopenCadence: { buyersWithReopens: 1, medianBuyerGapSeconds: 4, medianWithin60Share: 1 }, similarities: { channelProfile: 1 }, fundingWaves: [] },
    fundingProvenance: {
      status: "complete",
      totalBuyers: 1,
      fundedBuyers: 1,
      sourceCount: 1,
      sharedSourceCount: 0,
      sharedSourceBuyers: 0,
      sharedSourceBuyerShare: 0,
      sources: [{
        funder: "0x0000000000000000000000000000000000000002",
        buyers: ["0x0000000000000000000000000000000000000003"],
        buyerCount: 1,
        fundedAmountRaw: "10000000",
        fundedAmountUsdc: 10,
        fundingTransactions: 1,
        sellerVolumeUsdc: 10,
        sellerVolumeShare: 1,
        firstAt: 1,
        lastAt: 1,
        completeness: { status: "complete", completeBuyers: 1, totalBuyers: 1 },
        buyerFlows: [{ buyer: "0x0000000000000000000000000000000000000003", amountRaw: "10000000", amountUsdc: 10, transactions: 1, firstAt: 1, lastAt: 1, kinds: ["protocol_deposit"], sellerVolumeUsdc: 10, sellerShare: 1, channels: 1 }],
      }],
    },
    dependenceAnalysis: {
      coordinatedVolumeEstimate: { basis: "dominant_common_funder_cohort", volumeUsdc: 10, sellerVolumeShare: 1, buyerCount: 1, caveat: "Not definitive." },
      thresholds: [{ threshold: 0.99, buyerCount: 1, buyerShare: 1, sellerVolumeUsdc: 10, sellerVolumeShare: 1 }],
      bins: [{ minimum: 0.99, maximum: 1.000001, label: "≥99%", buyerCount: 1, buyerShare: 1, sellerVolumeUsdc: 10, sellerVolumeShare: 1 }],
    },
    sellerFundFlows: {
      status: "complete",
      complete: true,
      errors: [],
      outboundTotalUsdc: 100,
      recipientCount: 1,
      affiliatedRecipientCount: 0,
      affiliatedOutboundUsdc: 0,
      indirectFunderSummary: {
        dominantFunder: "0x0000000000000000000000000000000000000002",
        pathCount: 1,
        relayCount: 1,
        intermediaryCount: 1,
        sellerPaymentsUsdc: 100,
        forwardedToFunderUsdc: 99.99,
        averageForwardedShare: 0.9999,
      },
      indirectFunderPaths: [{
        seller,
        relay: "0x0000000000000000000000000000000000000004",
        intermediary: "0x0000000000000000000000000000000000000005",
        funder: "0x0000000000000000000000000000000000000002",
        sellerPaymentUsdc: 100,
        sellerPaymentTx: `0x${"01".repeat(32)}`,
        relayForwardUsdc: 100,
        relayForwardTx: `0x${"02".repeat(32)}`,
        relayDelaySeconds: 20,
        funderReceiptUsdc: 99.99,
        funderReceiptTx: `0x${"03".repeat(32)}`,
        funderDelaySeconds: 40,
        retainedUsdc: 0.01,
        forwardedShare: 0.9999,
      }],
      returnPathSummary: { buyerCount: 0, pathCount: 0, exactAmountMatches: 0, followedBySellerUsage: 0 },
      returnPaths: [],
      recipients: [{
        recipient: "0x0000000000000000000000000000000000000004",
        amountRaw: "100000000",
        amountUsdc: 100,
        transactions: 3,
        firstAt: 1,
        lastAt: 2,
        relation: "relay_to_buyer_funder",
        affiliated: true,
        examples: [],
      }],
    },
    buyers: [{ buyer: "0x0000000000000000000000000000000000000003", volumeUsdc: 10, sellerShare: 1, channels: 1, medianReopenGapSeconds: 4, reopenWithin60Share: 1, otherSellers: [] }],
    externalLinks: { antscan: `https://antscan.co/account/${seller}`, blockscout: `https://base.blockscout.com/address/${seller}` },
  };
}

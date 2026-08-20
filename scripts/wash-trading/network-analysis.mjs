import { normalizeAddress, timestampSeconds } from "./core.mjs";

export const NETWORK_ANALYSIS_VERSION = "network-graph-v1";

export const NETWORK_THRESHOLDS = Object.freeze({
  minimumFunderCohortBuyers: 3,
  mixedExclusiveShare: 0.5,
  dedicatedExclusiveShare: 1,
  minimumFundingBatchBuyers: 3,
  fundingBatchWindowSeconds: 2 * 60 * 60,
  minimumReciprocalSettlements: 100,
  minimumReciprocity: 0.8,
  minimumFlowThroughSettlements: 100,
  minimumFlowThroughBalance: 0.8,
});

export function analyzeNetwork({
  settlementAccumulator,
  addressTraces,
  sellerProfilesBySeller = new Map(),
  period,
  thresholds = NETWORK_THRESHOLDS,
}) {
  const positiveBuyers = positiveBuyerRows(settlementAccumulator);
  const nativeFundingByBuyer = firstNativeFundingByBuyer(addressTraces, positiveBuyers, period);
  const fundingCohorts = analyzeNativeFunderCohorts({
    positiveBuyers,
    nativeFundingByBuyer,
    sellerProfilesBySeller,
    thresholds,
  });
  const fundingBatches = detectNativeFundingBatches({
    positiveBuyers,
    nativeFundingByBuyer,
    sellerProfilesBySeller,
    thresholds,
  });
  const reciprocalPairs = detectReciprocalPairs({ settlementAccumulator, sellerProfilesBySeller, thresholds });
  const reciprocalAddresses = new Set(reciprocalPairs.flatMap((pair) => [pair.walletA, pair.walletB]));
  const flowThroughWallets = detectFlowThroughWallets({
    settlementAccumulator,
    sellerProfilesBySeller,
    excludedAddresses: reciprocalAddresses,
    thresholds,
  });

  const reciprocalVolumeRaw = reciprocalPairs.reduce((total, pair) => total + BigInt(pair.grossVolumeRaw), 0n);
  const reciprocalSettlementCount = reciprocalPairs.reduce((total, pair) => total + pair.settlements, 0);
  const reciprocalMembers = [...reciprocalAddresses].sort();

  return {
    version: NETWORK_ANALYSIS_VERSION,
    thresholds,
    coverage: {
      positiveVolumeBuyers: positiveBuyers.size,
      buyersWithFirstNativeFunding: nativeFundingByBuyer.size,
      firstNativeFundingShare: positiveBuyers.size === 0 ? null : nativeFundingByBuyer.size / positiveBuyers.size,
    },
    counts: {
      fundingCohorts: fundingCohorts.length,
      fundingBatches: fundingBatches.length,
      reciprocalPairs: reciprocalPairs.length,
      reciprocalWallets: reciprocalMembers.length,
      flowThroughWallets: flowThroughWallets.length,
    },
    fundingCohorts,
    fundingBatches,
    reciprocalPairs,
    flowThroughWallets,
    findings: reciprocalPairs.length === 0 ? [] : [{
      id: "reciprocal-settlement-loops",
      confidence: "CONFIRMED",
      decisiveSignal: "settlement_reciprocity",
      memberAddresses: reciprocalMembers,
      pairCount: reciprocalPairs.length,
      settlementCount: reciprocalSettlementCount,
      grossVolumeRaw: reciprocalVolumeRaw.toString(),
      grossVolumeUsdc: usdcNumber(reciprocalVolumeRaw),
      summary: `${reciprocalPairs.length} wallet pairs settle in both directions at near-equal volume`,
      caveat: "This finding is edge-level. It does not rely on seller names, reputation, or per-seller score.",
    }],
    caveats: [
      "Native-funder dedication is a network-shape signal; exchange, paymaster, router, and treasury infrastructure must be labeled before enforcement.",
      "Exact-value funding batches are triage evidence only because amounts and timing are inexpensive to randomize.",
      "Flow-through rows are review candidates, not verdicts; legitimate sellers may also buy services from the network.",
    ],
  };
}

export function analyzeNativeFunderCohorts({
  positiveBuyers,
  nativeFundingByBuyer,
  sellerProfilesBySeller = new Map(),
  thresholds = NETWORK_THRESHOLDS,
}) {
  const grouped = new Map();
  for (const [buyer, funding] of nativeFundingByBuyer) {
    const usage = positiveBuyers.get(buyer);
    if (!usage) continue;
    const cohort = getOrCreate(grouped, funding.funder, () => ({
      funder: funding.funder,
      buyers: [],
      volumeRaw: 0n,
      sellerTotals: new Map(),
      sellerBuyerSets: new Map(),
      sellerExclusiveBuyerSets: new Map(),
    }));
    cohort.buyers.push(buyer);
    cohort.volumeRaw += usage.volumeRaw;
    for (const [seller, volumeRaw] of usage.sellers) {
      cohort.sellerTotals.set(seller, (cohort.sellerTotals.get(seller) ?? 0n) + volumeRaw);
      getOrCreate(cohort.sellerBuyerSets, seller, () => new Set()).add(buyer);
      if (usage.sellers.size === 1) getOrCreate(cohort.sellerExclusiveBuyerSets, seller, () => new Set()).add(buyer);
    }
  }

  return [...grouped.values()]
    .filter((cohort) => cohort.buyers.length >= thresholds.minimumFunderCohortBuyers)
    .map((cohort) => {
      const exclusiveBuyers = cohort.buyers.filter((buyer) => positiveBuyers.get(buyer).sellers.size === 1).length;
      const exclusiveShare = exclusiveBuyers / cohort.buyers.length;
      const averageSellersPerBuyer = cohort.buyers.reduce(
        (total, buyer) => total + positiveBuyers.get(buyer).sellers.size,
        0,
      ) / cohort.buyers.length;
      return {
        funder: cohort.funder,
        buyersCreated: cohort.buyers.length,
        buyers: [...cohort.buyers].sort(),
        averageSellersPerBuyer,
        exclusiveBuyers,
        exclusiveShare,
        volumeRaw: cohort.volumeRaw.toString(),
        volumeUsdc: usdcNumber(cohort.volumeRaw),
        shape: cohortShape(exclusiveShare, thresholds),
        topSellers: sellerDistribution({
          sellerTotals: cohort.sellerTotals,
          sellerBuyerSets: cohort.sellerBuyerSets,
          sellerExclusiveBuyerSets: cohort.sellerExclusiveBuyerSets,
          sellerProfilesBySeller,
        }),
      };
    })
    .sort((left, right) => right.buyersCreated - left.buyersCreated || right.volumeUsdc - left.volumeUsdc);
}

export function detectNativeFundingBatches({
  positiveBuyers,
  nativeFundingByBuyer,
  sellerProfilesBySeller = new Map(),
  thresholds = NETWORK_THRESHOLDS,
}) {
  const byFunderAndAmount = new Map();
  for (const [buyer, funding] of nativeFundingByBuyer) {
    const usage = positiveBuyers.get(buyer);
    if (!usage) continue;
    const key = `${funding.funder}:${funding.amountWei}`;
    getOrCreate(byFunderAndAmount, key, () => []).push({ buyer, funding, usage });
  }

  const batches = [];
  for (const records of byFunderAndAmount.values()) {
    records.sort((left, right) => left.funding.timestamp - right.funding.timestamp || left.buyer.localeCompare(right.buyer));
    let batch = [];
    for (const record of records) {
      if (batch.length > 0 && record.funding.timestamp - batch[0].funding.timestamp > thresholds.fundingBatchWindowSeconds) {
        pushFundingBatch(batches, batch, sellerProfilesBySeller, thresholds);
        batch = [];
      }
      batch.push(record);
    }
    pushFundingBatch(batches, batch, sellerProfilesBySeller, thresholds);
  }

  return batches.sort((left, right) => right.buyersFunded - left.buyersFunded
    || right.volumeUsdc - left.volumeUsdc
    || left.firstAt - right.firstAt);
}

export function detectReciprocalPairs({
  settlementAccumulator,
  sellerProfilesBySeller = new Map(),
  thresholds = NETWORK_THRESHOLDS,
}) {
  const pairs = [];
  const seen = new Set();
  for (const [walletB, sellerTotal] of settlementAccumulator.sellerTotals) {
    for (const [walletA, volumeAToB] of sellerTotal.buyers) {
      if (walletA === walletB) continue;
      const pairKey = [walletA, walletB].sort().join(":");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const reverseSeller = settlementAccumulator.sellerTotals.get(walletA);
      const volumeBToA = reverseSeller?.buyers.get(walletB) ?? 0n;
      if (volumeAToB <= 0n || volumeBToA <= 0n) continue;
      const settlementsAToB = sellerTotal.settlementsByBuyer.get(walletA) ?? [];
      const settlementsBToA = reverseSeller.settlementsByBuyer.get(walletB) ?? [];
      const settlements = settlementsAToB.length + settlementsBToA.length;
      const reciprocity = ratioBigInt(minBigInt(volumeAToB, volumeBToA), maxBigInt(volumeAToB, volumeBToA));
      if (settlements < thresholds.minimumReciprocalSettlements || reciprocity < thresholds.minimumReciprocity) continue;
      const [orderedA, orderedB] = [walletA, walletB].sort();
      const aToB = orderedA === walletA ? volumeAToB : volumeBToA;
      const bToA = orderedA === walletA ? volumeBToA : volumeAToB;
      const timestamps = [...settlementsAToB, ...settlementsBToA].map((entry) => entry.timestamp).filter(Number.isFinite);
      pairs.push({
        walletA: orderedA,
        walletAName: sellerProfilesBySeller.get(orderedA)?.displayName ?? null,
        walletB: orderedB,
        walletBName: sellerProfilesBySeller.get(orderedB)?.displayName ?? null,
        volumeAToBRaw: aToB.toString(),
        volumeAToBUsdc: usdcNumber(aToB),
        volumeBToARaw: bToA.toString(),
        volumeBToAUsdc: usdcNumber(bToA),
        grossVolumeRaw: (aToB + bToA).toString(),
        grossVolumeUsdc: usdcNumber(aToB + bToA),
        settlements,
        reciprocity,
        firstAt: timestamps.length === 0 ? null : Math.min(...timestamps),
        lastAt: timestamps.length === 0 ? null : Math.max(...timestamps),
        confidence: "CONFIRMED",
      });
    }
  }
  return pairs.sort((left, right) => right.settlements - left.settlements || right.grossVolumeUsdc - left.grossVolumeUsdc);
}

export function detectFlowThroughWallets({
  settlementAccumulator,
  sellerProfilesBySeller = new Map(),
  excludedAddresses = new Set(),
  thresholds = NETWORK_THRESHOLDS,
}) {
  const rows = [];
  for (const [wallet, sold] of settlementAccumulator.sellerTotals) {
    if (excludedAddresses.has(wallet)) continue;
    const boughtRaw = settlementAccumulator.buyerTotals.get(wallet) ?? 0n;
    if (sold.volumeRaw <= 0n || boughtRaw <= 0n) continue;
    const outgoing = settlementAccumulator.buyerSellerTotals.get(wallet) ?? new Map();
    const settlementsBought = [...outgoing.keys()].reduce(
      (total, seller) => total + (settlementAccumulator.sellerTotals.get(seller)?.settlementsByBuyer.get(wallet)?.length ?? 0),
      0,
    );
    const settlements = sold.settlements + settlementsBought;
    const balance = ratioBigInt(minBigInt(sold.volumeRaw, boughtRaw), maxBigInt(sold.volumeRaw, boughtRaw));
    if (settlements < thresholds.minimumFlowThroughSettlements || balance < thresholds.minimumFlowThroughBalance) continue;
    const topInbound = [...sold.buyers.entries()].sort(compareRawDescending)[0] ?? null;
    const topOutbound = [...outgoing.entries()].sort(compareRawDescending)[0] ?? null;
    rows.push({
      wallet,
      displayName: sellerProfilesBySeller.get(wallet)?.displayName ?? null,
      soldVolumeRaw: sold.volumeRaw.toString(),
      soldVolumeUsdc: usdcNumber(sold.volumeRaw),
      boughtVolumeRaw: boughtRaw.toString(),
      boughtVolumeUsdc: usdcNumber(boughtRaw),
      balance,
      settlements,
      buyers: sold.buyers.size,
      sellersPurchasedFrom: outgoing.size,
      strongestInbound: topInbound && { wallet: topInbound[0], volumeUsdc: usdcNumber(topInbound[1]) },
      strongestOutbound: topOutbound && { wallet: topOutbound[0], volumeUsdc: usdcNumber(topOutbound[1]) },
      confidence: "WATCH",
    });
  }
  return rows.sort((left, right) => right.settlements - left.settlements || right.soldVolumeUsdc - left.soldVolumeUsdc);
}

export function annotateSellerReports(sellerReports, networkAnalysis) {
  const signalsBySeller = new Map();
  const signal = (seller) => getOrCreate(signalsBySeller, seller, () => ({
    nativeFunderCohorts: [],
    fundingBatches: [],
    reciprocalPairs: [],
    flowThrough: null,
  }));

  for (const cohort of networkAnalysis.fundingCohorts) {
    for (const seller of cohort.topSellers) signal(seller.seller).nativeFunderCohorts.push({
      funder: cohort.funder,
      cohortBuyers: cohort.buyersCreated,
      cohortExclusiveShare: cohort.exclusiveShare,
      cohortShape: cohort.shape,
      buyers: seller.buyers,
      buyerAddresses: seller.buyerAddresses,
      exclusiveBuyers: seller.exclusiveBuyers,
      volumeRaw: seller.volumeRaw,
      volumeUsdc: seller.volumeUsdc,
    });
  }
  for (const batch of networkAnalysis.fundingBatches) {
    for (const seller of batch.sellers) signal(seller.seller).fundingBatches.push({
      funder: batch.funder,
      amountWei: batch.amountWei,
      batchBuyers: batch.buyersFunded,
      buyers: seller.buyers,
      exclusiveBuyers: seller.exclusiveBuyers,
      firstAt: batch.firstAt,
      lastAt: batch.lastAt,
      volumeUsdc: seller.volumeUsdc,
    });
  }
  for (const pair of networkAnalysis.reciprocalPairs) {
    signal(pair.walletA).reciprocalPairs.push(pair);
    signal(pair.walletB).reciprocalPairs.push(pair);
  }
  for (const row of networkAnalysis.flowThroughWallets) signal(row.wallet).flowThrough = row;

  return sellerReports.map((report) => ({
    ...report,
    networkSignals: signalsBySeller.get(report.seller) ?? {
      nativeFunderCohorts: [],
      fundingBatches: [],
      reciprocalPairs: [],
      flowThrough: null,
    },
  }));
}

function positiveBuyerRows(settlementAccumulator) {
  const rows = new Map();
  for (const [buyer, sellers] of settlementAccumulator.buyerSellerTotals) {
    const positiveSellers = new Map([...sellers].filter(([, volumeRaw]) => volumeRaw > 0n));
    const volumeRaw = [...positiveSellers.values()].reduce((total, value) => total + value, 0n);
    if (volumeRaw > 0n) rows.set(buyer, { buyer, sellers: positiveSellers, volumeRaw });
  }
  return rows;
}

function firstNativeFundingByBuyer(addressTraces, positiveBuyers, period) {
  const rows = new Map();
  for (const buyer of positiveBuyers.keys()) {
    const funding = addressTraces.get(buyer)?.firstNativeFunding;
    const funder = normalizeAddress(funding?.from);
    const timestamp = timestampSeconds(funding?.timestamp);
    if (!funder || timestamp == null || (period && timestamp >= period.to)) continue;
    rows.set(buyer, {
      buyer,
      funder,
      amountWei: String(funding.amountWei ?? "0"),
      timestamp,
      txHash: funding.txHash ?? null,
    });
  }
  return rows;
}

function pushFundingBatch(target, records, sellerProfilesBySeller, thresholds) {
  if (records.length < thresholds.minimumFundingBatchBuyers) return;
  const sellerTotals = new Map();
  const sellerBuyerSets = new Map();
  const sellerExclusiveBuyerSets = new Map();
  let volumeRaw = 0n;
  for (const record of records) {
    volumeRaw += record.usage.volumeRaw;
    for (const [seller, sellerVolumeRaw] of record.usage.sellers) {
      sellerTotals.set(seller, (sellerTotals.get(seller) ?? 0n) + sellerVolumeRaw);
      getOrCreate(sellerBuyerSets, seller, () => new Set()).add(record.buyer);
      if (record.usage.sellers.size === 1) getOrCreate(sellerExclusiveBuyerSets, seller, () => new Set()).add(record.buyer);
    }
  }
  const firstAt = records[0].funding.timestamp;
  const lastAt = records.at(-1).funding.timestamp;
  target.push({
    funder: records[0].funding.funder,
    amountWei: records[0].funding.amountWei,
    buyersFunded: records.length,
    buyers: records.map((record) => record.buyer).sort(),
    exclusiveBuyers: records.filter((record) => record.usage.sellers.size === 1).length,
    exclusiveShare: records.filter((record) => record.usage.sellers.size === 1).length / records.length,
    firstAt,
    lastAt,
    spanSeconds: lastAt - firstAt,
    volumeRaw: volumeRaw.toString(),
    volumeUsdc: usdcNumber(volumeRaw),
    sellers: sellerDistribution({
      sellerTotals,
      sellerBuyerSets,
      sellerExclusiveBuyerSets,
      sellerProfilesBySeller,
    }),
    weight: "TRIAGE_ONLY",
  });
}

function sellerDistribution({ sellerTotals, sellerBuyerSets, sellerExclusiveBuyerSets, sellerProfilesBySeller }) {
  return [...sellerTotals]
    .map(([seller, volumeRaw]) => ({
      seller,
      displayName: sellerProfilesBySeller.get(seller)?.displayName ?? null,
      buyers: sellerBuyerSets.get(seller)?.size ?? 0,
      buyerAddresses: [...(sellerBuyerSets.get(seller) ?? [])].sort(),
      exclusiveBuyers: sellerExclusiveBuyerSets.get(seller)?.size ?? 0,
      volumeRaw: volumeRaw.toString(),
      volumeUsdc: usdcNumber(volumeRaw),
    }))
    .sort((left, right) => right.volumeUsdc - left.volumeUsdc || right.buyers - left.buyers || left.seller.localeCompare(right.seller));
}

function cohortShape(exclusiveShare, thresholds) {
  if (exclusiveShare >= thresholds.dedicatedExclusiveShare) return "dedicated";
  if (exclusiveShare >= thresholds.mixedExclusiveShare) return "mixed";
  return "diversified";
}

function compareRawDescending(left, right) {
  return left[1] === right[1] ? left[0].localeCompare(right[0]) : left[1] > right[1] ? -1 : 1;
}

function minBigInt(left, right) {
  return left < right ? left : right;
}

function maxBigInt(left, right) {
  return left > right ? left : right;
}

function ratioBigInt(numerator, denominator) {
  if (denominator === 0n) return 0;
  return Number((numerator * 1_000_000n) / denominator) / 1_000_000;
}

function usdcNumber(raw) {
  return Number(raw) / 1_000_000;
}

function getOrCreate(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

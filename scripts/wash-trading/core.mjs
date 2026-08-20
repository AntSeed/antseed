export const SCAN_SCHEMA_VERSION = 1;
export const SCORING_VERSION = "conservative-v2";

const FIVE_MINUTES_SECONDS = 300;
const ONE_DAY_SECONDS = 86_400;

export const TIER_ORDER = Object.freeze({
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
});

export function normalizeAddress(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

export function parseIsoSeconds(value, optionName) {
  if (value == null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${optionName} must be a valid ISO date, received ${JSON.stringify(value)}`);
  }
  return Math.floor(timestamp / 1000);
}

export function timestampSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return timestampSeconds(Number(value));
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  return null;
}

export function isoFromSeconds(value) {
  return new Date(value * 1000).toISOString();
}

export function resolveHistoricalPeriod({
  sellers = [],
  channels = [],
  firstDeposits = [],
  accounts = [],
  settlementEarliest = null,
  fromOverride = null,
  toOverride = null,
  scanStartedAt,
}) {
  const candidates = [];
  for (const seller of sellers) addTimestamp(candidates, seller.firstSeenAt);
  for (const channel of channels) addTimestamp(candidates, channel.openedAt);
  for (const deposit of firstDeposits) addTimestamp(candidates, deposit.timestamp);
  for (const account of accounts) addTimestamp(candidates, account.firstSeenAt);
  addTimestamp(candidates, settlementEarliest);

  const derivedFrom = candidates.length > 0 ? Math.min(...candidates) : null;
  const from = fromOverride ?? derivedFrom;
  const to = toOverride ?? Math.floor(scanStartedAt / 1000);

  if (from == null) {
    throw new Error("AntScan returned no timestamped AntSeed activity; unable to resolve all-history start");
  }
  if (from >= to) {
    throw new Error(`Resolved scan period is empty: ${isoFromSeconds(from)} – ${isoFromSeconds(to)}`);
  }

  return {
    from,
    to,
    fromIso: isoFromSeconds(from),
    toIso: isoFromSeconds(to),
    allHistory: fromOverride == null && toOverride == null,
    fromSource: fromOverride == null ? "earliest-indexed-antseed-activity" : "cli-override",
    toSource: toOverride == null ? "scan-start" : "cli-override",
  };
}

function addTimestamp(target, value) {
  const parsed = timestampSeconds(value);
  if (parsed != null && parsed > 0) target.push(parsed);
}

export function createSettlementAccumulator() {
  return {
    earliest: null,
    sellerTotals: new Map(),
    buyerTotals: new Map(),
    buyerSellerTotals: new Map(),
    includedCount: 0,
  };
}

export function observeSettlementEarliest(current, items) {
  let earliest = current;
  for (const item of items) {
    const timestamp = timestampSeconds(item.timestamp);
    if (timestamp != null && timestamp > 0 && (earliest == null || timestamp < earliest)) {
      earliest = timestamp;
    }
  }
  return earliest;
}

export function accumulateSettlementPage(accumulator, items, period) {
  for (const settlement of items) {
    const timestamp = timestampSeconds(settlement.timestamp);
    if (timestamp == null || timestamp < period.from || timestamp >= period.to) continue;
    const seller = normalizeAddress(settlement.seller);
    const buyer = normalizeAddress(settlement.buyer);
    if (!seller || !buyer) continue;

    const delta = bigintValue(settlement.deltaUsdc);
    const fee = bigintValue(settlement.platformFeeUsdc);
    const sellerTotal = getOrCreate(accumulator.sellerTotals, seller, () => ({
      volumeRaw: 0n,
      platformFeeRaw: 0n,
      settlements: 0,
      inputTokens: 0n,
      outputTokens: 0n,
      firstAt: null,
      lastAt: null,
      buyers: new Map(),
      settlementsByBuyer: new Map(),
    }));
    sellerTotal.volumeRaw += delta;
    sellerTotal.platformFeeRaw += fee;
    sellerTotal.settlements += 1;
    sellerTotal.inputTokens += bigintValue(settlement.inputTokens);
    sellerTotal.outputTokens += bigintValue(settlement.outputTokens);
    sellerTotal.firstAt = minNullable(sellerTotal.firstAt, timestamp);
    sellerTotal.lastAt = maxNullable(sellerTotal.lastAt, timestamp);
    sellerTotal.buyers.set(buyer, (sellerTotal.buyers.get(buyer) ?? 0n) + delta);
    getOrCreate(sellerTotal.settlementsByBuyer, buyer, () => []).push({
      amountRaw: delta.toString(),
      timestamp,
      txHash: settlement.txHash ?? null,
      blockNumber: settlement.blockNumber == null ? null : Number(settlement.blockNumber),
      transactionIndex: settlement.transactionIndex == null ? null : Number(settlement.transactionIndex),
      logIndex: settlement.logIndex == null ? null : Number(settlement.logIndex),
      channelId: settlement.channelId ?? null,
    });

    accumulator.buyerTotals.set(buyer, (accumulator.buyerTotals.get(buyer) ?? 0n) + delta);
    const bySeller = getOrCreate(accumulator.buyerSellerTotals, buyer, () => new Map());
    bySeller.set(seller, (bySeller.get(seller) ?? 0n) + delta);
    accumulator.includedCount += 1;
  }
}

export function createServiceSalesAccumulator() {
  return { bySeller: new Map(), includedCount: 0 };
}

export function accumulateServiceSalesPage(accumulator, items, period) {
  for (const settlement of items) {
    const timestamp = timestampSeconds(settlement.timestamp);
    if (timestamp == null || timestamp < period.from || timestamp >= period.to) continue;
    const seller = normalizeAddress(settlement.seller);
    const serviceId = typeof settlement.serviceId === "string" ? settlement.serviceId.toLowerCase() : null;
    if (!seller || !/^0x[0-9a-f]{64}$/.test(serviceId ?? "")) continue;
    const sellerServices = getOrCreate(accumulator.bySeller, seller, () => new Map());
    const entry = getOrCreate(sellerServices, serviceId, () => ({
      serviceId,
      volumeRaw: 0n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 0n,
      settlements: 0,
      buyers: new Set(),
      firstAt: null,
      lastAt: null,
    }));
    entry.volumeRaw += bigintValue(settlement.deltaAmountUsdc);
    entry.inputTokens += bigintValue(settlement.deltaInputTokens);
    entry.cachedInputTokens += bigintValue(settlement.deltaCachedInputTokens);
    entry.outputTokens += bigintValue(settlement.deltaOutputTokens);
    entry.requests += bigintValue(settlement.deltaRequestCount);
    entry.settlements += 1;
    const buyer = normalizeAddress(settlement.buyer);
    if (buyer) entry.buyers.add(buyer);
    entry.firstAt = minNullable(entry.firstAt, timestamp);
    entry.lastAt = maxNullable(entry.lastAt, timestamp);
    accumulator.includedCount += 1;
  }
}

export function channelOverlapsPeriod(channel, period) {
  const openedAt = timestampSeconds(channel.openedAt);
  if (openedAt == null || openedAt >= period.to) return false;
  const closedAt = timestampSeconds(channel.closedAt);
  const lastSettledAt = timestampSeconds(channel.lastSettledAt);
  return closedAt == null || closedAt === 0 || closedAt >= period.from || (lastSettledAt != null && lastSettledAt >= period.from);
}

export function buildAnalysisContext({
  sellers,
  channels,
  firstDeposits,
  settlementAccumulator,
  fundingRecords,
  addressTraces,
  period,
  protocolDepositsComplete,
  serviceSalesBySeller = new Map(),
  serviceCatalogBySeller = new Map(),
}) {
  const channelsBySeller = new Map();
  for (const channel of channels) {
    if (!channelOverlapsPeriod(channel, period)) continue;
    const seller = normalizeAddress(channel.seller);
    const buyer = normalizeAddress(channel.buyer);
    if (!seller || !buyer) continue;
    getOrCreate(channelsBySeller, seller, () => []).push({ ...channel, seller, buyer });
  }

  const firstDepositByBuyer = new Map();
  for (const deposit of firstDeposits) {
    const buyer = normalizeAddress(deposit.address);
    if (!buyer) continue;
    firstDepositByBuyer.set(buyer, deposit);
  }

  const fundingByBuyer = new Map();
  for (const record of fundingRecords) {
    const buyer = normalizeAddress(record.buyer);
    const funder = normalizeAddress(record.funder);
    const timestamp = timestampSeconds(record.timestamp);
    if (!buyer || !funder || timestamp == null || timestamp >= period.to) continue;
    getOrCreate(fundingByBuyer, buyer, () => []).push({
      ...record,
      buyer,
      funder,
      timestamp,
      amountRaw: bigintValue(record.amountRaw).toString(),
    });
  }
  for (const records of fundingByBuyer.values()) records.sort((left, right) => left.timestamp - right.timestamp);

  const sellerAddresses = new Set();
  for (const seller of sellers) {
    const address = normalizeAddress(seller.address);
    if (address) sellerAddresses.add(address);
  }
  for (const address of settlementAccumulator.sellerTotals.keys()) sellerAddresses.add(address);
  for (const address of channelsBySeller.keys()) sellerAddresses.add(address);

  return {
    sellerAddresses,
    channelsBySeller,
    firstDepositByBuyer,
    settlementAccumulator,
    fundingByBuyer,
    addressTraces,
    period,
    protocolDepositsComplete,
    serviceSalesBySeller,
    serviceCatalogBySeller,
  };
}

export function analyzeSeller(seller, context) {
  const channels = [...(context.channelsBySeller.get(seller) ?? [])].sort((left, right) => timestampSeconds(left.openedAt) - timestampSeconds(right.openedAt));
  const settlement = context.settlementAccumulator.sellerTotals.get(seller) ?? {
    volumeRaw: 0n,
    platformFeeRaw: 0n,
    settlements: 0,
    inputTokens: 0n,
    outputTokens: 0n,
    firstAt: null,
    lastAt: null,
    buyers: new Map(),
    settlementsByBuyer: new Map(),
  };

  const channelBuyers = new Set(channels.map((channel) => channel.buyer));
  const buyers = new Set([...channelBuyers, ...settlement.buyers.keys()]);
  const channelsByBuyer = groupBy(channels, (channel) => channel.buyer);
  const buyerRows = [];

  for (const buyer of buyers) {
    const buyerChannels = [...(channelsByBuyer.get(buyer) ?? [])].sort((left, right) => timestampSeconds(left.openedAt) - timestampSeconds(right.openedAt));
    const reopenGaps = channelReopenGaps(buyerChannels);
    const sellerVolumeRaw = settlement.buyers.get(buyer) ?? 0n;
    const globalVolumeRaw = context.settlementAccumulator.buyerTotals.get(buyer) ?? 0n;
    const firstChannelAt = minTimestamp(buyerChannels.map((channel) => channel.openedAt));
    const lastChannelAt = maxTimestamp(buyerChannels.map((channel) => channel.closedAt || channel.lastSettledAt || channel.openedAt));
    const firstDeposit = context.firstDepositByBuyer.get(buyer);
    buyerRows.push({
      buyer,
      volumeRaw: sellerVolumeRaw.toString(),
      volumeUsdc: usdcNumber(sellerVolumeRaw),
      globalVolumeUsdc: usdcNumber(globalVolumeRaw),
      sellerShare: ratio(sellerVolumeRaw, globalVolumeRaw),
      channels: buyerChannels.length,
      requests: sumNumbers(buyerChannels.map((channel) => channel.requestCount)),
      settlements: sumNumbers(buyerChannels.map((channel) => channel.settlementCount)),
      firstDepositAt: timestampSeconds(firstDeposit?.timestamp),
      firstDepositTx: firstDeposit?.txHash ?? null,
      firstChannelAt,
      lastChannelAt,
      reopenGapCount: reopenGaps.length,
      medianReopenGapSeconds: median(reopenGaps),
      reopenWithin60Share: reopenGaps.length === 0 ? null : reopenGaps.filter((gap) => gap <= 60).length / reopenGaps.length,
      otherSellers: otherSellerRows(buyer, seller, context.settlementAccumulator.buyerSellerTotals),
    });
  }
  buyerRows.sort((left, right) => right.volumeUsdc - left.volumeUsdc || right.channels - left.channels);

  const primaryFunding = buyerRows.map((buyer) => ({
    buyer: buyer.buyer,
    primary: primaryFunder(context.fundingByBuyer.get(buyer.buyer) ?? []),
  }));
  const fundingGroups = new Map();
  for (const entry of primaryFunding) {
    if (!entry.primary) continue;
    getOrCreate(fundingGroups, entry.primary.funder, () => []).push(entry.buyer);
  }

  const cohorts = [...fundingGroups.entries()]
    .map(([funder, cohortBuyers]) => buildCohort({
      seller,
      funder,
      buyers: cohortBuyers,
      buyerRows,
      channelsByBuyer,
      fundingByBuyer: context.fundingByBuyer,
      addressTraces: context.addressTraces,
      sellerVolumeRaw: settlement.volumeRaw,
    }))
    .filter((cohort) => cohort.buyers.length >= 2)
    .sort((left, right) => right.volumeShare - left.volumeShare || right.buyers.length - left.buyers.length);

  const strongestCohort = cohorts[0] ?? emptyCohort();
  const fundingProvenance = buildFundingProvenance({
    buyerRows,
    fundingGroups,
    fundingByBuyer: context.fundingByBuyer,
    addressTraces: context.addressTraces,
    sellerVolumeRaw: settlement.volumeRaw,
    protocolDepositsComplete: context.protocolDepositsComplete,
  });
  const dependenceAnalysis = buildDependenceAnalysis(buyerRows, settlement.volumeRaw, strongestCohort);
  const sellerFundFlows = buildSellerFundFlows({
    seller,
    settlement,
    buyerRows,
    fundingByBuyer: context.fundingByBuyer,
    addressTraces: context.addressTraces,
    dominantFunder: strongestCohort.funder,
    indirectFunderPaths: strongestCohort.affiliations.sellerFunderIndirect,
  });
  const modelSales = buildModelSales(
    context.serviceSalesBySeller.get(seller) ?? new Map(),
    context.serviceCatalogBySeller.get(seller) ?? new Map(),
  );
  const score = scoreSeller({
    seller,
    settlement,
    channels,
    buyerRows,
    cohort: strongestCohort,
    context,
  });

  const firstActivityAt = minNullable(settlement.firstAt, minTimestamp(channels.map((channel) => channel.openedAt)));
  const lastActivityAt = maxNullable(settlement.lastAt, maxTimestamp(channels.map((channel) => channel.closedAt || channel.lastSettledAt || channel.openedAt)));

  return {
    version: 1,
    seller,
    tier: score.tier,
    label: score.label,
    score: score.total,
    maxAssessableScore: score.maxAssessableScore,
    provisional: score.provisional,
    completeness: score.completeness,
    familyScores: score.familyScores,
    evidence: score.evidence,
    cautions: score.cautions,
    period: context.period,
    stats: {
      volumeRaw: settlement.volumeRaw.toString(),
      volumeUsdc: usdcNumber(settlement.volumeRaw),
      platformFeeUsdc: usdcNumber(settlement.platformFeeRaw),
      settlements: settlement.settlements,
      channels: channels.length,
      buyers: buyerRows.length,
      requests: sumNumbers(channels.map((channel) => channel.requestCount)),
      inputTokens: settlement.inputTokens.toString(),
      outputTokens: settlement.outputTokens.toString(),
      firstActivityAt,
      lastActivityAt,
    },
    strongestCohort,
    cohorts: cohorts.slice(0, 25),
    fundingProvenance,
    dependenceAnalysis,
    sellerFundFlows,
    modelSales,
    buyers: buyerRows,
    externalLinks: {
      antscan: `https://antscan.co/account/${seller}`,
      blockscout: `https://base.blockscout.com/address/${seller}`,
    },
  };
}

function buildModelSales(serviceSales, catalog) {
  return [...serviceSales.values()].map((entry) => {
    const model = catalog.get(entry.serviceId) ?? null;
    const totalTokens = entry.inputTokens + entry.cachedInputTokens + entry.outputTokens;
    return {
      serviceId: entry.serviceId,
      model: model?.service ?? null,
      provider: model?.provider ?? null,
      volumeUsdc: usdcNumber(entry.volumeRaw),
      requests: Number(entry.requests),
      settlements: entry.settlements,
      buyers: entry.buyers.size,
      inputTokens: entry.inputTokens.toString(),
      cachedInputTokens: entry.cachedInputTokens.toString(),
      outputTokens: entry.outputTokens.toString(),
      realizedUsdPerMillionTotalTokens: totalTokens > 0n ? Number(entry.volumeRaw) / Number(totalTokens) : null,
      realizedUsdPerRequest: entry.requests > 0n ? usdcNumber(entry.volumeRaw) / Number(entry.requests) : null,
      advertisedInputUsdPerMillion: model?.inputUsdPerMillion ?? null,
      advertisedOutputUsdPerMillion: model?.outputUsdPerMillion ?? null,
      advertisedPriceObservedAt: model?.observedAt ?? null,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
    };
  }).sort((left, right) => right.volumeUsdc - left.volumeUsdc);
}

function buildCohort({ seller, funder, buyers, buyerRows, channelsByBuyer, fundingByBuyer, addressTraces, sellerVolumeRaw }) {
  const buyerSet = new Set(buyers);
  const rows = buyerRows.filter((row) => buyerSet.has(row.buyer));
  const channels = buyers.flatMap((buyer) => channelsByBuyer.get(buyer) ?? []);
  const cohortVolumeRaw = rows.reduce((total, row) => total + bigintValue(row.volumeRaw), 0n);
  const fundingRecords = buyers.flatMap((buyer) => (fundingByBuyer.get(buyer) ?? []).filter((record) => record.funder === funder));
  const firstFundingTimes = buyers
    .map((buyer) => (fundingByBuyer.get(buyer) ?? []).find((record) => record.funder === funder)?.timestamp)
    .filter((value) => value != null);
  const firstChannelTimes = rows.map((row) => row.firstChannelAt).filter((value) => value != null);
  const lastChannelTimes = rows.map((row) => row.lastChannelAt).filter((value) => value != null);
  const waves = detectFundingWaves(fundingRecords, buyerSet);
  const synchronizedShare = synchronizedChannelShare(channels);
  const similarities = behaviorSimilarities(buyers, channelsByBuyer);
  const recurringDays = recurringCohortDays(channels);
  const affiliations = detectAffiliations({ seller, funder, buyers, addressTraces });
  const reopenRows = rows.filter((row) => row.reopenGapCount > 0);

  return {
    funder,
    buyers,
    buyerCount: buyers.length,
    volumeRaw: cohortVolumeRaw.toString(),
    volumeUsdc: usdcNumber(cohortVolumeRaw),
    volumeShare: ratio(cohortVolumeRaw, sellerVolumeRaw),
    dependentBuyerCount: rows.filter((row) => row.sellerShare >= 0.9).length,
    dependentBuyerShare: rows.length === 0 ? 0 : rows.filter((row) => row.sellerShare >= 0.9).length / rows.length,
    firstFundingSpanSeconds: span(firstFundingTimes),
    firstChannelSpanSeconds: span(firstChannelTimes),
    lastChannelSpanSeconds: span(lastChannelTimes),
    synchronizedChannelShare: synchronizedShare,
    recurringDays,
    reopenCadence: {
      buyersWithReopens: reopenRows.length,
      medianBuyerGapSeconds: median(reopenRows.map((row) => row.medianReopenGapSeconds).filter((value) => value != null)),
      medianWithin60Share: median(reopenRows.map((row) => row.reopenWithin60Share).filter((value) => value != null)),
    },
    fundingWaves: waves,
    similarities,
    affiliations,
  };
}

function buildFundingProvenance({ buyerRows, fundingGroups, fundingByBuyer, addressTraces, sellerVolumeRaw, protocolDepositsComplete }) {
  const rowByBuyer = new Map(buyerRows.map((row) => [row.buyer, row]));
  const sources = [...fundingGroups.entries()].map(([funder, buyers]) => {
    const buyerFlows = buyers.map((buyer) => {
      const records = (fundingByBuyer.get(buyer) ?? []).filter((record) => record.funder === funder);
      const amountRaw = records.reduce((total, record) => total + bigintValue(record.amountRaw), 0n);
      const row = rowByBuyer.get(buyer);
      return {
        buyer,
        amountRaw: amountRaw.toString(),
        amountUsdc: usdcNumber(amountRaw),
        transactions: records.length,
        firstAt: minTimestamp(records.map((record) => record.timestamp)),
        lastAt: maxTimestamp(records.map((record) => record.timestamp)),
        kinds: [...new Set(records.map((record) => record.kind).filter(Boolean))].sort(),
        sellerVolumeUsdc: row?.volumeUsdc ?? 0,
        sellerShare: row?.sellerShare ?? 0,
        channels: row?.channels ?? 0,
      };
    }).sort((left, right) => right.sellerVolumeUsdc - left.sellerVolumeUsdc || right.amountUsdc - left.amountUsdc);
    const fundedAmountRaw = buyerFlows.reduce((total, flow) => total + bigintValue(flow.amountRaw), 0n);
    const sellerVolumeRawForSource = buyers.reduce((total, buyer) => total + bigintValue(rowByBuyer.get(buyer)?.volumeRaw), 0n);
    const completeBuyers = buyers.filter((buyer) => addressTraces.get(buyer)?.complete === true).length;
    return {
      funder,
      buyers,
      buyerCount: buyers.length,
      fundedAmountRaw: fundedAmountRaw.toString(),
      fundedAmountUsdc: usdcNumber(fundedAmountRaw),
      fundingTransactions: buyerFlows.reduce((total, flow) => total + flow.transactions, 0),
      sellerVolumeUsdc: usdcNumber(sellerVolumeRawForSource),
      sellerVolumeShare: ratio(sellerVolumeRawForSource, sellerVolumeRaw),
      firstAt: minTimestamp(buyerFlows.map((flow) => flow.firstAt)),
      lastAt: maxTimestamp(buyerFlows.map((flow) => flow.lastAt)),
      completeness: {
        status: protocolDepositsComplete && completeBuyers === buyers.length ? "complete" : completeBuyers > 0 ? "partial" : "unavailable",
        completeBuyers,
        totalBuyers: buyers.length,
      },
      buyerFlows,
    };
  }).sort((left, right) => right.sellerVolumeShare - left.sellerVolumeShare || right.buyerCount - left.buyerCount);

  const fundedBuyers = sources.reduce((total, source) => total + source.buyerCount, 0);
  const sharedSourceBuyers = sources.filter((source) => source.buyerCount >= 2).reduce((total, source) => total + source.buyerCount, 0);
  return {
    status: protocolDepositsComplete ? "complete" : sources.length > 0 ? "partial" : "unavailable",
    totalBuyers: buyerRows.length,
    fundedBuyers,
    sourceCount: sources.length,
    sharedSourceCount: sources.filter((source) => source.buyerCount >= 2).length,
    sharedSourceBuyers,
    sharedSourceBuyerShare: fundedBuyers === 0 ? 0 : sharedSourceBuyers / fundedBuyers,
    sources,
  };
}

function buildDependenceAnalysis(buyerRows, sellerVolumeRaw, strongestCohort) {
  const thresholds = [0.5, 0.9, 0.95, 0.99].map((threshold) => {
    const matching = buyerRows.filter((buyer) => buyer.sellerShare >= threshold);
    const volumeRaw = matching.reduce((total, buyer) => total + bigintValue(buyer.volumeRaw), 0n);
    return {
      threshold,
      buyerCount: matching.length,
      buyerShare: buyerRows.length === 0 ? 0 : matching.length / buyerRows.length,
      sellerVolumeUsdc: usdcNumber(volumeRaw),
      sellerVolumeShare: ratio(volumeRaw, sellerVolumeRaw),
    };
  });
  const bins = [
    { minimum: 0, maximum: 0.5, label: "<50%" },
    { minimum: 0.5, maximum: 0.9, label: "50–89%" },
    { minimum: 0.9, maximum: 0.95, label: "90–94%" },
    { minimum: 0.95, maximum: 0.99, label: "95–98%" },
    { minimum: 0.99, maximum: 1.000001, label: "≥99%" },
  ].map((bin) => {
    const matching = buyerRows.filter((buyer) => buyer.sellerShare >= bin.minimum && buyer.sellerShare < bin.maximum);
    const volumeRaw = matching.reduce((total, buyer) => total + bigintValue(buyer.volumeRaw), 0n);
    return {
      ...bin,
      buyerCount: matching.length,
      buyerShare: buyerRows.length === 0 ? 0 : matching.length / buyerRows.length,
      sellerVolumeUsdc: usdcNumber(volumeRaw),
      sellerVolumeShare: ratio(volumeRaw, sellerVolumeRaw),
    };
  });
  return {
    coordinatedVolumeEstimate: {
      basis: "dominant_common_funder_cohort",
      volumeUsdc: strongestCohort.volumeUsdc,
      sellerVolumeShare: strongestCohort.volumeShare,
      buyerCount: strongestCohort.buyerCount,
      caveat: "This is a coordination-risk estimate, not a definitive measurement of wash-traded volume.",
    },
    thresholds,
    bins,
  };
}

function buildSellerFundFlows({ seller, settlement, buyerRows, fundingByBuyer, addressTraces, dominantFunder, indirectFunderPaths = [] }) {
  const sellerTrace = addressTraces.get(seller);
  const buyerSet = new Set(buyerRows.map((buyer) => buyer.buyer));
  const indirectRelaySet = new Set(indirectFunderPaths.map((path) => path.relay));
  const passThroughPaths = detectSellerPassThroughPaths({ seller, sellerTrace, addressTraces })
    .filter((path) => !indirectRelaySet.has(path.recipient));
  const passThroughRecipientSet = new Set(passThroughPaths.map((path) => path.recipient));
  const fundingSourceSet = new Set();
  for (const buyer of buyerSet) {
    for (const record of fundingByBuyer.get(buyer) ?? []) fundingSourceSet.add(record.funder);
  }
  if (!sellerTrace) {
    return { status: "unavailable", complete: false, errors: ["seller trace unavailable"], outboundTotalUsdc: 0, recipientCount: 0, affiliatedRecipientCount: 0, recipients: [] };
  }

  const recipientTotals = new Map();
  for (const transfer of dedupeTransfers(sellerTrace.outboundUsdc ?? [])) {
    const from = normalizeAddress(transfer.from);
    const recipient = normalizeAddress(transfer.to);
    const amountRaw = bigintValue(transfer.amountRaw);
    if (from !== seller || !recipient || amountRaw <= 0n) continue;
    const current = recipientTotals.get(recipient) ?? { recipient, amountRaw: 0n, transactions: 0, firstAt: null, lastAt: null, examples: [] };
    current.amountRaw += amountRaw;
    current.transactions += 1;
    current.firstAt = minNullable(current.firstAt, timestampSeconds(transfer.timestamp));
    current.lastAt = maxNullable(current.lastAt, timestampSeconds(transfer.timestamp));
    if (current.examples.length < 5) current.examples.push({ txHash: transfer.txHash, amountRaw: amountRaw.toString(), timestamp: timestampSeconds(transfer.timestamp) });
    recipientTotals.set(recipient, current);
  }
  const recipients = [...recipientTotals.values()].map((entry) => {
    const isFundingSource = fundingSourceSet.has(entry.recipient);
    const isBuyer = buyerSet.has(entry.recipient);
    const isIndirectRelay = indirectRelaySet.has(entry.recipient);
    return {
      recipient: entry.recipient,
      amountRaw: entry.amountRaw.toString(),
      amountUsdc: usdcNumber(entry.amountRaw),
      transactions: entry.transactions,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
      relation: isIndirectRelay
        ? "relay_to_buyer_funder"
        : passThroughRecipientSet.has(entry.recipient)
          ? "repeated_pass_through"
        : isFundingSource && isBuyer
          ? "buyer_and_funding_source"
          : isFundingSource
            ? "buyer_funding_source"
            : isBuyer
              ? "buyer"
              : "unclassified",
      affiliated: isFundingSource || isBuyer || isIndirectRelay,
      examples: entry.examples,
    };
  }).sort((left, right) => right.amountUsdc - left.amountUsdc || right.transactions - left.transactions);
  const buyerRowsByAddress = new Map(buyerRows.map((buyer) => [buyer.buyer, buyer]));
  const returnPaths = recipients
    .filter((recipient) => buyerSet.has(recipient.recipient))
    .flatMap((recipient) => buildReturnPaths({
      seller,
      recipient,
      deposits: (fundingByBuyer.get(recipient.recipient) ?? []).filter((record) => record.kind === "protocol_deposit"),
      settlements: settlement.settlementsByBuyer?.get(recipient.recipient) ?? [],
      buyerRow: buyerRowsByAddress.get(recipient.recipient),
    }))
    .sort((left, right) => left.sellerPaymentAt - right.sellerPaymentAt || left.buyer.localeCompare(right.buyer));
  return {
    status: sellerTrace.complete ? "complete" : recipients.length > 0 ? "partial" : "unavailable",
    complete: sellerTrace.complete === true,
    errors: sellerTrace.errors ?? [],
    outboundTotalUsdc: recipients.reduce((total, recipient) => total + recipient.amountUsdc, 0),
    recipientCount: recipients.length,
    affiliatedRecipientCount: recipients.filter((recipient) => recipient.affiliated).length,
    affiliatedOutboundUsdc: recipients.filter((recipient) => recipient.affiliated).reduce((total, recipient) => total + recipient.amountUsdc, 0),
    indirectFunderSummary: {
      dominantFunder: dominantFunder ?? null,
      pathCount: indirectFunderPaths.length,
      relayCount: new Set(indirectFunderPaths.map((path) => path.relay)).size,
      intermediaryCount: new Set(indirectFunderPaths.map((path) => path.intermediary)).size,
      sellerPaymentsUsdc: indirectFunderPaths.reduce((total, path) => total + path.sellerPaymentUsdc, 0),
      forwardedToFunderUsdc: indirectFunderPaths.reduce((total, path) => total + path.funderReceiptUsdc, 0),
      averageForwardedShare: indirectFunderPaths.length === 0
        ? 0
        : indirectFunderPaths.reduce((total, path) => total + path.forwardedShare, 0) / indirectFunderPaths.length,
    },
    indirectFunderPaths,
    passThroughSummary: {
      pathCount: passThroughPaths.length,
      recipientCount: new Set(passThroughPaths.map((path) => path.recipient)).size,
      destinationCount: new Set(passThroughPaths.map((path) => path.destination)).size,
      sellerPaymentsUsdc: passThroughPaths.reduce((total, path) => total + path.sellerPaymentUsdc, 0),
      forwardedUsdc: passThroughPaths.reduce((total, path) => total + path.forwardedUsdc, 0),
      averageForwardedShare: passThroughPaths.length === 0
        ? 0
        : passThroughPaths.reduce((total, path) => total + path.forwardedShare, 0) / passThroughPaths.length,
    },
    passThroughPaths,
    returnPathSummary: {
      pathCount: returnPaths.length,
      buyerCount: new Set(returnPaths.map((path) => path.buyer)).size,
      exactAmountMatches: returnPaths.filter((path) => path.exactDepositAmountMatch).length,
      followedBySellerUsage: returnPaths.filter((path) => path.firstSellerUsageAt != null).length,
      sellerPaymentsUsdc: returnPaths.reduce((total, path) => total + path.sellerPaymentUsdc, 0),
    },
    returnPaths,
    recipients: recipients.slice(0, 100),
  };
}

function buildReturnPaths({ seller, recipient, deposits, settlements, buyerRow }) {
  const sortedDeposits = [...deposits].sort((left, right) => left.timestamp - right.timestamp);
  const sortedSettlements = [...settlements].sort((left, right) => left.timestamp - right.timestamp);
  const usedDeposits = new Set();
  const paths = [];
  for (const payment of [...recipient.examples].sort((left, right) => left.timestamp - right.timestamp)) {
    const paymentAt = timestampSeconds(payment.timestamp);
    if (paymentAt == null) continue;
    const laterDeposits = sortedDeposits.filter((deposit) => deposit.timestamp >= paymentAt && !usedDeposits.has(deposit.txHash));
    if (laterDeposits.length === 0) continue;
    const exactDeposit = laterDeposits.find((deposit) => bigintValue(deposit.amountRaw) === bigintValue(payment.amountRaw));
    const deposit = exactDeposit ?? laterDeposits[0];
    usedDeposits.add(deposit.txHash);
    const firstUsage = sortedSettlements.find((settlement) => settlement.timestamp >= deposit.timestamp) ?? null;
    if (!firstUsage) continue;
    const depositDelaySeconds = deposit.timestamp - paymentAt;
    const usageDelaySeconds = firstUsage.timestamp - deposit.timestamp;
    const exactDepositAmountMatch = bigintValue(deposit.amountRaw) === bigintValue(payment.amountRaw);
    paths.push({
      buyer: recipient.recipient,
      seller,
      classification: exactDepositAmountMatch && depositDelaySeconds <= ONE_DAY_SECONDS && usageDelaySeconds <= ONE_DAY_SECONDS
        ? "strong_temporal_match"
        : exactDepositAmountMatch && depositDelaySeconds <= 30 * ONE_DAY_SECONDS && usageDelaySeconds <= ONE_DAY_SECONDS
          ? "coordinated_sequence"
          : "possible_sequence",
      sellerPaymentRaw: bigintValue(payment.amountRaw).toString(),
      sellerPaymentUsdc: usdcNumber(bigintValue(payment.amountRaw)),
      sellerPaymentAt: paymentAt,
      sellerPaymentTx: payment.txHash ?? null,
      depositRaw: bigintValue(deposit.amountRaw).toString(),
      depositUsdc: usdcNumber(bigintValue(deposit.amountRaw)),
      depositAt: deposit.timestamp,
      depositTx: deposit.txHash ?? null,
      depositFunder: deposit.funder ?? null,
      exactDepositAmountMatch,
      depositDelaySeconds,
      firstSellerUsageRaw: bigintValue(firstUsage.amountRaw).toString(),
      firstSellerUsageUsdc: usdcNumber(bigintValue(firstUsage.amountRaw)),
      firstSellerUsageAt: firstUsage.timestamp,
      firstSellerUsageTx: firstUsage.txHash ?? null,
      usageDelaySeconds,
      lifetimeSellerVolumeUsdc: buyerRow?.volumeUsdc ?? 0,
      caveat: "Sequence and amount correlation only; fungible USDC identity is not proven.",
    });
  }
  return paths;
}

function scoreSeller({ seller, settlement, channels, buyerRows, cohort, context }) {
  const familyScores = {
    fundingControl: 0,
    temporalCoordination: 0,
    behavioralSimilarity: 0,
    buyerDependence: 0,
    sellerAffiliation: 0,
  };
  const evidence = [];
  const cautions = [];
  const cohortSize = cohort.buyers.length;
  const cohortTraces = cohort.buyers.map((buyer) => context.addressTraces.get(buyer)).filter(Boolean);
  const fundingComplete = context.protocolDepositsComplete && cohort.buyers.every((buyer) => context.addressTraces.get(buyer)?.complete === true);

  if (cohortSize >= 5 && cohort.volumeShare >= 0.7) {
    addEvidence(evidence, familyScores, "fundingControl", "common_funder_concentration", 18, `${cohortSize} buyers funded by ${shortAddress(cohort.funder)} account for ${percent(cohort.volumeShare)} of seller volume`, { funder: cohort.funder, buyers: cohortSize, volumeShare: cohort.volumeShare });
  } else if (cohortSize >= 3 && cohort.volumeShare >= 0.5) {
    addEvidence(evidence, familyScores, "fundingControl", "common_funder_concentration", 12, `${cohortSize} buyers funded by ${shortAddress(cohort.funder)} account for ${percent(cohort.volumeShare)} of seller volume`, { funder: cohort.funder, buyers: cohortSize, volumeShare: cohort.volumeShare });
  }

  if (cohort.fundingWaves.length >= 5) {
    addEvidence(evidence, familyScores, "fundingControl", "repeated_equal_funding_waves", 10, `${cohort.fundingWaves.length} equal-value funding waves reached at least three cohort buyers`, { waves: cohort.fundingWaves.length });
  } else if (cohort.fundingWaves.length >= 2) {
    addEvidence(evidence, familyScores, "fundingControl", "repeated_equal_funding_waves", 6, `${cohort.fundingWaves.length} equal-value funding waves reached at least three cohort buyers`, { waves: cohort.fundingWaves.length });
  }

  if (cohortSize >= 3 && cohort.firstFundingSpanSeconds != null && cohort.firstFundingSpanSeconds <= FIVE_MINUTES_SECONDS) {
    addEvidence(evidence, familyScores, "fundingControl", "funding_launch_sync", 2, `${cohortSize} cohort buyers were first funded within ${cohort.firstFundingSpanSeconds} seconds`, { spanSeconds: cohort.firstFundingSpanSeconds });
  }

  if (cohortSize >= 3 && cohort.firstChannelSpanSeconds != null && cohort.firstChannelSpanSeconds <= FIVE_MINUTES_SECONDS) {
    addEvidence(evidence, familyScores, "temporalCoordination", "first_channel_sync", 6, `${cohortSize} cohort buyers opened their first seller channel within ${cohort.firstChannelSpanSeconds} seconds`, { spanSeconds: cohort.firstChannelSpanSeconds });
  }
  if (cohortSize >= 3 && cohort.synchronizedChannelShare >= 0.8) {
    addEvidence(evidence, familyScores, "temporalCoordination", "recurring_channel_overlap", 10, `${percent(cohort.synchronizedChannelShare)} of cohort channels occurred in five-minute bins shared by at least three buyers`, { share: cohort.synchronizedChannelShare });
  } else if (cohortSize >= 3 && cohort.synchronizedChannelShare >= 0.5) {
    addEvidence(evidence, familyScores, "temporalCoordination", "recurring_channel_overlap", 8, `${percent(cohort.synchronizedChannelShare)} of cohort channels occurred in five-minute bins shared by at least three buyers`, { share: cohort.synchronizedChannelShare });
  }
  if (cohortSize >= 3 && cohort.firstChannelSpanSeconds != null && cohort.lastChannelSpanSeconds != null && cohort.firstChannelSpanSeconds <= ONE_DAY_SECONDS && cohort.lastChannelSpanSeconds <= ONE_DAY_SECONDS) {
    addEvidence(evidence, familyScores, "temporalCoordination", "matched_lifecycle_windows", 4, "Cohort buyers started and ended their seller activity within matched 24-hour windows", { firstSpanSeconds: cohort.firstChannelSpanSeconds, lastSpanSeconds: cohort.lastChannelSpanSeconds });
  }

  const similarities = cohort.similarities;
  if (cohortSize >= 3 && similarities.requestHistogram != null && similarities.requestHistogram >= 0.95) {
    addEvidence(evidence, familyScores, "behavioralSimilarity", "request_histogram_similarity", 7, `Median pairwise request-pattern similarity is ${percent(similarities.requestHistogram)}`, { similarity: similarities.requestHistogram });
  }
  if (cohortSize >= 3 && similarities.settlementHistogram != null && similarities.settlementHistogram >= 0.95) {
    addEvidence(evidence, familyScores, "behavioralSimilarity", "settlement_histogram_similarity", 5, `Median pairwise settlement-pattern similarity is ${percent(similarities.settlementHistogram)}`, { similarity: similarities.settlementHistogram });
  }
  if (cohortSize >= 3 && similarities.channelProfile != null && similarities.channelProfile >= 0.9) {
    addEvidence(evidence, familyScores, "behavioralSimilarity", "channel_profile_similarity", 8, `Median channel amount, duration, and reopen-pattern similarity is ${percent(similarities.channelProfile)}`, { similarity: similarities.channelProfile });
  }

  if (cohortSize >= 3 && cohort.dependentBuyerCount >= 3 && cohort.dependentBuyerShare >= 0.75) {
    addEvidence(evidence, familyScores, "buyerDependence", "buyer_seller_dependence", 8, `${cohort.dependentBuyerCount}/${cohortSize} cohort buyers direct at least 90% of observed AntSeed spend to this seller`, { dependentBuyers: cohort.dependentBuyerCount, cohortSize });
  }
  if (cohortSize >= 3 && cohort.volumeShare >= 0.7) {
    addEvidence(evidence, familyScores, "buyerDependence", "cohort_volume_concentration", 10, `The coordinated cohort accounts for ${percent(cohort.volumeShare)} of seller volume`, { volumeShare: cohort.volumeShare });
  } else if (cohortSize >= 3 && cohort.volumeShare >= 0.5) {
    addEvidence(evidence, familyScores, "buyerDependence", "cohort_volume_concentration", 8, `The coordinated cohort accounts for ${percent(cohort.volumeShare)} of seller volume`, { volumeShare: cohort.volumeShare });
  }
  if (cohortSize >= 3 && cohort.recurringDays >= 3) {
    addEvidence(evidence, familyScores, "buyerDependence", "recurring_cohort_activity", 2, `At least three cohort buyers were active together on ${cohort.recurringDays} distinct UTC days`, { days: cohort.recurringDays });
  }

  if (cohort.affiliations.sellerFunder.length > 0) {
    addEvidence(evidence, familyScores, "sellerAffiliation", "seller_funder_transfer_link", 5, "Direct non-protocol USDC transfers connect the seller and the cohort funder", { transfers: cohort.affiliations.sellerFunder });
  }
  if (cohort.affiliations.sellerBuyer.length > 0) {
    addEvidence(evidence, familyScores, "sellerAffiliation", "buyer_seller_return_flow", 5, "Direct non-protocol USDC transfers connect the seller and cohort buyers", { transfers: cohort.affiliations.sellerBuyer });
  }
  if (cohort.affiliations.sellerFunderIndirect.length >= 3) {
    const forwardedUsdc = cohort.affiliations.sellerFunderIndirect.reduce((total, path) => total + path.funderReceiptUsdc, 0);
    addEvidence(
      evidence,
      familyScores,
      "sellerAffiliation",
      "seller_funder_relay_path",
      5,
      `${cohort.affiliations.sellerFunderIndirect.length} repeated seller payout paths forwarded ${formatUsdc(forwardedUsdc)} through intermediaries to the cohort funder`,
      {
        paths: cohort.affiliations.sellerFunderIndirect.length,
        relays: new Set(cohort.affiliations.sellerFunderIndirect.map((path) => path.relay)).size,
        intermediaries: new Set(cohort.affiliations.sellerFunderIndirect.map((path) => path.intermediary)).size,
        forwardedUsdc,
      },
    );
  }

  familyScores.fundingControl = Math.min(30, familyScores.fundingControl);
  familyScores.temporalCoordination = Math.min(20, familyScores.temporalCoordination);
  familyScores.behavioralSimilarity = Math.min(20, familyScores.behavioralSimilarity);
  familyScores.buyerDependence = Math.min(20, familyScores.buyerDependence);
  familyScores.sellerAffiliation = Math.min(10, familyScores.sellerAffiliation);

  const total = Object.values(familyScores).reduce((sum, value) => sum + value, 0);
  const activeFamilies = Object.values(familyScores).filter((value) => value > 0).length;
  const sampleEligible = buyerRows.length >= 3 && channels.length >= 20;
  const sellerLinkEvidence = familyScores.sellerAffiliation > 0;
  let tier = total >= 30 ? "MEDIUM" : "LOW";

  if (total >= 55 && activeFamilies >= 2 && sampleEligible) tier = "HIGH";
  const criticalEligible = total >= 75
    && activeFamilies >= 3
    && familyScores.fundingControl >= 18
    && fundingComplete
    && (cohortSize >= 5 || sellerLinkEvidence)
    && sampleEligible;
  if (criticalEligible) tier = "CRITICAL";

  if (!sampleEligible && total >= 55) {
    cautions.push("High and critical tiers require at least three buyers and twenty settled or completed channels.");
  }
  if (!fundingComplete) {
    cautions.push("Funding evidence is incomplete; missing external data is not treated as evidence of absence, and critical classification is disabled.");
  }
  if (tier === "CRITICAL" && !sellerLinkEvidence) {
    cautions.push("Coordinated buyer control is strongly supported, but seller ownership or affiliation is not established.");
  }

  const label = tier === "CRITICAL"
    ? sellerLinkEvidence
      ? "possible wash-trading pattern with seller-link evidence"
      : "critical coordinated-usage risk"
    : tier === "HIGH"
      ? "high coordinated-usage risk"
      : tier === "MEDIUM"
        ? "review recommended"
        : "no strong coordinated-usage pattern detected";

  const completeTraceCount = cohortTraces.filter((trace) => trace.complete).length;
  const completeness = {
    status: fundingComplete ? "complete" : cohortSize === 0 ? "not_applicable" : completeTraceCount > 0 ? "partial" : "unavailable",
    protocolDepositsComplete: context.protocolDepositsComplete,
    cohortAddressesComplete: completeTraceCount,
    cohortAddressesTotal: cohortSize,
  };

  return {
    total,
    tier,
    label,
    familyScores,
    evidence,
    cautions,
    completeness,
    maxAssessableScore: 100,
    provisional: !fundingComplete,
    seller,
  };
}

function addEvidence(evidence, familyScores, family, code, points, summary, metrics) {
  familyScores[family] += points;
  evidence.push({ family, code, points, summary, metrics });
}

export function detectFundingWaves(records, cohortBuyers) {
  const byAmount = groupBy(records, (record) => bigintValue(record.amountRaw).toString());
  const waves = [];
  for (const [amountRaw, amountRecords] of byAmount) {
    const sorted = [...amountRecords].sort((left, right) => left.timestamp - right.timestamp);
    let current = [];
    for (const record of sorted) {
      const previous = current.at(-1);
      if (previous && record.timestamp - previous.timestamp > 120) {
        pushWave(waves, current, amountRaw, cohortBuyers);
        current = [];
      }
      current.push(record);
    }
    pushWave(waves, current, amountRaw, cohortBuyers);
  }
  return waves.sort((left, right) => left.startAt - right.startAt);
}

function pushWave(target, records, amountRaw, cohortBuyers) {
  if (records.length === 0) return;
  const buyers = new Set(records.map((record) => record.buyer).filter((buyer) => cohortBuyers.has(buyer)));
  if (buyers.size < 3) return;
  target.push({
    amountRaw,
    amountUsdc: usdcNumber(bigintValue(amountRaw)),
    startAt: records[0].timestamp,
    endAt: records.at(-1).timestamp,
    spanSeconds: records.at(-1).timestamp - records[0].timestamp,
    buyers: [...buyers],
    transactions: records.map((record) => ({ txHash: record.txHash, buyer: record.buyer, timestamp: record.timestamp })),
  });
}

function synchronizedChannelShare(channels) {
  if (channels.length === 0) return 0;
  const bins = groupBy(channels, (channel) => Math.floor(timestampSeconds(channel.openedAt) / FIVE_MINUTES_SECONDS));
  let synchronized = 0;
  for (const binChannels of bins.values()) {
    if (new Set(binChannels.map((channel) => channel.buyer)).size >= 3) synchronized += binChannels.length;
  }
  return synchronized / channels.length;
}

function recurringCohortDays(channels) {
  const days = groupBy(channels, (channel) => new Date(timestampSeconds(channel.openedAt) * 1000).toISOString().slice(0, 10));
  let count = 0;
  for (const dayChannels of days.values()) {
    if (new Set(dayChannels.map((channel) => channel.buyer)).size >= 3) count += 1;
  }
  return count;
}

function behaviorSimilarities(buyers, channelsByBuyer) {
  if (buyers.length < 3) return { requestHistogram: null, settlementHistogram: null, channelProfile: null };
  const requestVectors = [];
  const settlementVectors = [];
  const amountVectors = [];
  const durationVectors = [];
  const gapVectors = [];

  for (const buyer of buyers) {
    const channels = [...(channelsByBuyer.get(buyer) ?? [])].sort((left, right) => timestampSeconds(left.openedAt) - timestampSeconds(right.openedAt));
    requestVectors.push(histogram(channels.map((channel) => numberValue(channel.requestCount)), [1, 2, 5, 10, 25, 50]));
    settlementVectors.push(histogram(channels.map((channel) => numberValue(channel.settlementCount)), [1, 2, 3, 5, 10, 20]));
    amountVectors.push(histogram(channels.map((channel) => usdcNumber(bigintValue(channel.maxAmountUsdc))), [0.25, 0.5, 1, 2, 5, 10]));
    durationVectors.push(histogram(channels.map(channelDuration).filter((value) => value != null), [60, 300, 900, 3600, 21_600, 86_400]));
    gapVectors.push(histogram(channelReopenGaps(channels), [30, 300, 900, 3600, 21_600, 86_400]));
  }

  const amountSimilarity = medianPairwiseCosine(amountVectors);
  const durationSimilarity = medianPairwiseCosine(durationVectors);
  const gapSimilarity = medianPairwiseCosine(gapVectors);
  const profileParts = [amountSimilarity, durationSimilarity, gapSimilarity].filter((value) => value != null);
  return {
    requestHistogram: medianPairwiseCosine(requestVectors),
    settlementHistogram: medianPairwiseCosine(settlementVectors),
    channelProfile: profileParts.length === 0 ? null : profileParts.reduce((sum, value) => sum + value, 0) / profileParts.length,
  };
}

function histogram(values, boundaries) {
  const bins = Array.from({ length: boundaries.length + 1 }, () => 0);
  for (const value of values) {
    let index = boundaries.findIndex((boundary) => value < boundary);
    if (index === -1) index = boundaries.length;
    bins[index] += 1;
  }
  const total = bins.reduce((sum, value) => sum + value, 0);
  return total === 0 ? bins : bins.map((value) => value / total);
}

function medianPairwiseCosine(vectors) {
  const similarities = [];
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      const similarity = cosine(vectors[left], vectors[right]);
      if (similarity != null) similarities.push(similarity);
    }
  }
  return median(similarities);
}

function cosine(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return null;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function detectAffiliations({ seller, funder, buyers, addressTraces }) {
  const sellerTrace = addressTraces.get(seller);
  const sellerFunder = [];
  const sellerBuyer = [];
  const sellerFunderIndirect = [];
  if (!sellerTrace) return { sellerFunder, sellerBuyer, sellerFunderIndirect };

  for (const transfer of dedupeTransfers([...sellerTrace.inboundUsdc, ...sellerTrace.outboundUsdc])) {
    const from = normalizeAddress(transfer.from);
    const to = normalizeAddress(transfer.to);
    if ((from === seller && to === funder) || (from === funder && to === seller)) sellerFunder.push(transfer);
    if ((from === seller && buyers.includes(to)) || (to === seller && buyers.includes(from))) sellerBuyer.push(transfer);
  }
  if (funder) sellerFunderIndirect.push(...detectSellerFunderRelayPaths({ seller, funder, sellerTrace, addressTraces }));
  return {
    sellerFunder,
    sellerBuyer,
    sellerFunderIndirect,
  };
}

export function detectSellerFunderRelayPaths({ seller, funder, sellerTrace, addressTraces }) {
  const funderTrace = addressTraces.get(funder);
  if (!sellerTrace || !funderTrace) return [];
  const sellerPayments = dedupeTransfers(sellerTrace.outboundUsdc ?? [])
    .map(normalizedTransfer)
    .filter((transfer) => transfer.from === seller && transfer.to && transfer.to !== funder && transfer.amountRaw > 0n)
    .sort((left, right) => left.timestamp - right.timestamp);
  const funderReceiptsBySender = groupBy(
    dedupeTransfers(funderTrace.inboundUsdc ?? [])
      .map(normalizedTransfer)
      .filter((transfer) => transfer.to === funder && transfer.from && transfer.amountRaw > 0n),
    (transfer) => transfer.from,
  );
  const usedRelayTransfers = new Set();
  const usedFunderReceipts = new Set();
  const paths = [];

  for (const payment of sellerPayments) {
    const relayTrace = addressTraces.get(payment.to);
    if (!relayTrace) continue;
    const relayCandidates = dedupeTransfers(relayTrace.outboundUsdc ?? [])
      .map(normalizedTransfer)
      .filter((transfer) => transfer.from === payment.to
        && transfer.to
        && transfer.timestamp >= payment.timestamp
        && transfer.timestamp - payment.timestamp <= ONE_DAY_SECONDS
        && !usedRelayTransfers.has(transferKey(transfer))
        && nearlyEqualRaw(transfer.amountRaw, payment.amountRaw, 1_000n));
    relayCandidates.sort((left, right) => left.timestamp - right.timestamp);
    for (const relayTransfer of relayCandidates) {
      const receipts = (funderReceiptsBySender.get(relayTransfer.to) ?? [])
        .filter((receipt) => receipt.timestamp >= relayTransfer.timestamp
          && receipt.timestamp - relayTransfer.timestamp <= ONE_DAY_SECONDS
          && !usedFunderReceipts.has(transferKey(receipt))
          && isNearTotalForward(relayTransfer.amountRaw, receipt.amountRaw))
        .sort((left, right) => left.timestamp - right.timestamp);
      const funderReceipt = receipts[0];
      if (!funderReceipt) continue;
      usedRelayTransfers.add(transferKey(relayTransfer));
      usedFunderReceipts.add(transferKey(funderReceipt));
      paths.push({
        seller,
        relay: payment.to,
        intermediary: relayTransfer.to,
        funder,
        sellerPaymentRaw: payment.amountRaw.toString(),
        sellerPaymentUsdc: usdcNumber(payment.amountRaw),
        sellerPaymentAt: payment.timestamp,
        sellerPaymentTx: payment.txHash,
        relayForwardRaw: relayTransfer.amountRaw.toString(),
        relayForwardUsdc: usdcNumber(relayTransfer.amountRaw),
        relayForwardAt: relayTransfer.timestamp,
        relayForwardTx: relayTransfer.txHash,
        relayDelaySeconds: relayTransfer.timestamp - payment.timestamp,
        funderReceiptRaw: funderReceipt.amountRaw.toString(),
        funderReceiptUsdc: usdcNumber(funderReceipt.amountRaw),
        funderReceiptAt: funderReceipt.timestamp,
        funderReceiptTx: funderReceipt.txHash,
        funderDelaySeconds: funderReceipt.timestamp - relayTransfer.timestamp,
        retainedUsdc: usdcNumber(relayTransfer.amountRaw - funderReceipt.amountRaw),
        forwardedShare: Number(funderReceipt.amountRaw) / Number(relayTransfer.amountRaw),
      });
      break;
    }
  }
  return paths.sort((left, right) => left.sellerPaymentAt - right.sellerPaymentAt);
}

export function detectSellerPassThroughPaths({
  seller,
  sellerTrace,
  addressTraces,
  minimumRepeatedPaths = 2,
  minimumTotalRaw = 100_000_000n,
}) {
  if (!sellerTrace) return [];
  const sellerPayments = dedupeTransfers(sellerTrace.outboundUsdc ?? [])
    .map(normalizedTransfer)
    .filter((transfer) => transfer.from === seller && transfer.to && transfer.amountRaw > 0n)
    .sort((left, right) => left.timestamp - right.timestamp);
  const usedTransfers = new Set();
  const candidates = [];
  for (const payment of sellerPayments) {
    const recipientTrace = addressTraces.get(payment.to);
    if (!recipientTrace) continue;
    const forwards = dedupeTransfers(recipientTrace.outboundUsdc ?? [])
      .map(normalizedTransfer)
      .filter((transfer) => transfer.from === payment.to
        && transfer.to
        && transfer.timestamp >= payment.timestamp
        && transfer.timestamp - payment.timestamp <= ONE_DAY_SECONDS
        && !usedTransfers.has(transferKey(transfer))
        && isNearTotalForward(payment.amountRaw, transfer.amountRaw))
      .sort((left, right) => left.timestamp - right.timestamp
        || compareBigInt(payment.amountRaw - left.amountRaw, payment.amountRaw - right.amountRaw));
    const forwarded = forwards[0];
    if (!forwarded) continue;
    usedTransfers.add(transferKey(forwarded));
    candidates.push({
      seller,
      recipient: payment.to,
      destination: forwarded.to,
      sellerPaymentRaw: payment.amountRaw.toString(),
      sellerPaymentUsdc: usdcNumber(payment.amountRaw),
      sellerPaymentAt: payment.timestamp,
      sellerPaymentTx: payment.txHash,
      forwardedRaw: forwarded.amountRaw.toString(),
      forwardedUsdc: usdcNumber(forwarded.amountRaw),
      forwardedAt: forwarded.timestamp,
      forwardedTx: forwarded.txHash,
      delaySeconds: forwarded.timestamp - payment.timestamp,
      retainedUsdc: usdcNumber(payment.amountRaw - forwarded.amountRaw),
      forwardedShare: Number(forwarded.amountRaw) / Number(payment.amountRaw),
    });
  }
  const qualifyingRoutes = new Set(
    [...groupBy(candidates, (path) => `${path.recipient}:${path.destination}`).entries()]
      .filter(([, paths]) => paths.length >= minimumRepeatedPaths
        && paths.reduce((total, path) => total + bigintValue(path.sellerPaymentRaw), 0n) >= minimumTotalRaw)
      .map(([route]) => route),
  );
  return candidates
    .filter((path) => qualifyingRoutes.has(`${path.recipient}:${path.destination}`))
    .sort((left, right) => left.sellerPaymentAt - right.sellerPaymentAt);
}

export function selectRelayTraceCandidates({
  sellers,
  addressTraces,
  excludedAddresses = new Set(),
  maxPerSeller = 3,
  minimumTransactions = 2,
  minimumAmountRaw = 100_000_000n,
  minimumOutboundShare = 0.05,
}) {
  const selected = new Set();
  for (const seller of sellers) {
    const sellerTrace = addressTraces.get(seller);
    if (!sellerTrace) continue;
    const totals = new Map();
    let outboundTotalRaw = 0n;
    for (const transfer of dedupeTransfers(sellerTrace.outboundUsdc ?? [])) {
      const normalized = normalizedTransfer(transfer);
      if (normalized.from !== seller || !normalized.to || normalized.amountRaw <= 0n) continue;
      outboundTotalRaw += normalized.amountRaw;
      const current = totals.get(normalized.to) ?? { address: normalized.to, amountRaw: 0n, transactions: 0 };
      current.amountRaw += normalized.amountRaw;
      current.transactions += 1;
      totals.set(normalized.to, current);
    }
    const candidates = [...totals.values()]
      .filter((candidate) => !excludedAddresses.has(candidate.address)
        && candidate.transactions >= minimumTransactions
        && (candidate.amountRaw >= minimumAmountRaw || ratio(candidate.amountRaw, outboundTotalRaw) >= minimumOutboundShare))
      .sort((left, right) => compareBigIntDescending(left.amountRaw, right.amountRaw) || right.transactions - left.transactions)
      .slice(0, maxPerSeller);
    for (const candidate of candidates) selected.add(candidate.address);
  }
  return [...selected].sort();
}

export function selectDirectFunderTraceCandidates({
  records,
  excludedAddresses = new Set(),
  minimumBuyerCount = 3,
  minimumAmountRaw = 100_000_000n,
  maxCandidates = 250,
}) {
  const totals = new Map();
  for (const record of records) {
    const funder = normalizeAddress(record.funder);
    const buyer = normalizeAddress(record.buyer);
    const amountRaw = bigintValue(record.amountRaw);
    if (!funder || !buyer || amountRaw <= 0n || excludedAddresses.has(funder)) continue;
    const current = totals.get(funder) ?? { funder, buyers: new Set(), amountRaw: 0n, transactions: 0 };
    current.buyers.add(buyer);
    current.amountRaw += amountRaw;
    current.transactions += 1;
    totals.set(funder, current);
  }
  return [...totals.values()]
    .filter((candidate) => candidate.buyers.size >= minimumBuyerCount && candidate.amountRaw >= minimumAmountRaw)
    .sort((left, right) => right.buyers.size - left.buyers.size || compareBigIntDescending(left.amountRaw, right.amountRaw))
    .slice(0, maxCandidates)
    .map((candidate) => candidate.funder)
    .sort();
}

function normalizedTransfer(transfer) {
  return {
    from: normalizeAddress(transfer.from),
    to: normalizeAddress(transfer.to),
    amountRaw: bigintValue(transfer.amountRaw),
    timestamp: timestampSeconds(transfer.timestamp),
    txHash: transfer.txHash,
    logIndex: transfer.logIndex ?? null,
  };
}

function transferKey(transfer) {
  return `${transfer.txHash}:${transfer.logIndex ?? ""}:${transfer.from}:${transfer.to}:${transfer.amountRaw}`;
}

function nearlyEqualRaw(left, right, toleranceRaw) {
  const difference = left >= right ? left - right : right - left;
  return difference <= toleranceRaw;
}

function isNearTotalForward(receivedRaw, forwardedRaw) {
  if (forwardedRaw <= 0n || forwardedRaw > receivedRaw) return false;
  const retainedRaw = receivedRaw - forwardedRaw;
  const absoluteToleranceRaw = 1_000_000n;
  return retainedRaw <= absoluteToleranceRaw || Number(forwardedRaw) / Number(receivedRaw) >= 0.98;
}

function formatUsdc(value) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function compareBigIntDescending(left, right) {
  return left === right ? 0 : left > right ? -1 : 1;
}

function dedupeTransfers(transfers) {
  const seen = new Set();
  const result = [];
  for (const transfer of transfers) {
    const key = `${transfer.txHash}:${transfer.logIndex ?? ""}:${transfer.from}:${transfer.to}:${transfer.amountRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(transfer);
  }
  return result;
}

function primaryFunder(records) {
  if (records.length === 0) return null;
  const totals = new Map();
  for (const record of records) {
    const current = totals.get(record.funder) ?? { funder: record.funder, amountRaw: 0n, firstAt: record.timestamp };
    current.amountRaw += bigintValue(record.amountRaw);
    current.firstAt = Math.min(current.firstAt, record.timestamp);
    totals.set(record.funder, current);
  }
  return [...totals.values()].sort((left, right) => compareBigInt(right.amountRaw, left.amountRaw) || left.firstAt - right.firstAt)[0];
}

function otherSellerRows(buyer, currentSeller, buyerSellerTotals) {
  const totals = buyerSellerTotals.get(buyer) ?? new Map();
  return [...totals.entries()]
    .filter(([seller]) => seller !== currentSeller)
    .map(([seller, volumeRaw]) => ({ seller, volumeUsdc: usdcNumber(volumeRaw) }))
    .sort((left, right) => right.volumeUsdc - left.volumeUsdc)
    .slice(0, 10);
}

function emptyCohort() {
  return {
    funder: null,
    buyers: [],
    buyerCount: 0,
    volumeUsdc: 0,
    volumeShare: 0,
    dependentBuyerCount: 0,
    dependentBuyerShare: 0,
    firstFundingSpanSeconds: null,
    firstChannelSpanSeconds: null,
    lastChannelSpanSeconds: null,
    synchronizedChannelShare: 0,
    recurringDays: 0,
    reopenCadence: { buyersWithReopens: 0, medianBuyerGapSeconds: null, medianWithin60Share: null },
    fundingWaves: [],
    similarities: { requestHistogram: null, settlementHistogram: null, channelProfile: null },
    affiliations: { sellerFunder: [], sellerBuyer: [], sellerFunderIndirect: [] },
  };
}

function channelDuration(channel) {
  const opened = timestampSeconds(channel.openedAt);
  const closed = timestampSeconds(channel.closedAt || channel.lastSettledAt);
  return opened == null || closed == null ? null : Math.max(0, closed - opened);
}

function channelReopenGaps(channels) {
  const gaps = [];
  for (let index = 1; index < channels.length; index += 1) {
    const previousClosed = timestampSeconds(channels[index - 1].closedAt || channels[index - 1].lastSettledAt);
    const opened = timestampSeconds(channels[index].openedAt);
    if (previousClosed != null && opened != null) gaps.push(Math.max(0, opened - previousClosed));
  }
  return gaps;
}

function span(values) {
  return values.length < 2 ? null : Math.max(...values) - Math.min(...values);
}

function minTimestamp(values) {
  const parsed = values.map(timestampSeconds).filter((value) => value != null && value > 0);
  return parsed.length === 0 ? null : Math.min(...parsed);
}

function maxTimestamp(values) {
  const parsed = values.map(timestampSeconds).filter((value) => value != null && value > 0);
  return parsed.length === 0 ? null : Math.max(...parsed);
}

function minNullable(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function maxNullable(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function bigintValue(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function numberValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function usdcNumber(raw) {
  return Number(raw) / 1_000_000;
}

function ratio(numerator, denominator) {
  if (denominator === 0n) return 0;
  return Number(numerator * 1_000_000n / denominator) / 1_000_000;
}

function compareBigInt(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sumNumbers(values) {
  return values.reduce((sum, value) => sum + numberValue(value), 0);
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) getOrCreate(groups, keyFn(value), () => []).push(value);
  return groups;
}

function getOrCreate(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function shortAddress(address) {
  return address ? `${address.slice(0, 8)}…${address.slice(-4)}` : "unknown";
}

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { ensureDirectory, writeJsonAtomic } from "./io.mjs";
import { classifyFinalVerdict, FINAL_VERDICT_THRESHOLDS, WASH_TRADING_POLICY_VERSION } from "./policy.mjs";

export const PROOF_BUNDLE_VERSION = 1;

export async function writeProofBundle(path, input) {
  const bundle = buildProofBundle(input);
  await ensureDirectory(dirname(path));
  await writeJsonAtomic(path, bundle);
  return bundle;
}

export function buildProofBundle({
  scan,
  sellerReports,
  networkAnalysis,
  settlementAccumulator,
  fundingRecords,
  addressTraces,
  startBlock,
  endBlockExclusive,
  contracts,
}) {
  requireBlockPeriod(startBlock, endBlockExclusive);
  const sellerClaims = sellerReports.flatMap((seller) => buildSellerClaim({
    seller,
    settlementAccumulator,
    fundingRecords,
    addressTraces,
    startBlock,
    endBlockExclusive,
  }));
  const reciprocalClaims = (networkAnalysis.reciprocalPairs ?? []).map((pair) => buildReciprocalClaim({
    pair,
    settlementAccumulator,
    startBlock,
    endBlockExclusive,
  }));
  const claims = [...sellerClaims, ...reciprocalClaims]
    .map(finalizeClaim)
    .sort((left, right) => left.claimId.localeCompare(right.claimId));
  const reportRoot = merkleRoot(claims.map((claim) => claim.leafHash));
  return {
    version: PROOF_BUNDLE_VERSION,
    kind: "antseed-wash-trading-proof-bundle",
    scanId: scan.scanId,
    scanSchemaVersion: scan.version,
    scoringVersion: scan.scoringVersion,
    networkAnalysisVersion: scan.networkAnalysisVersion,
    policyVersion: WASH_TRADING_POLICY_VERSION,
    chainId: 8_453,
    contracts,
    period: { startBlock, endBlockExclusive },
    thresholds: FINAL_VERDICT_THRESHOLDS,
    claimCounts: {
      P0_CLOSED_LOOP: claims.filter((claim) => claim.type === "P0_CLOSED_LOOP").length,
      P1_COORDINATED_CONTROL: claims.filter((claim) => claim.type === "P1_COORDINATED_CONTROL").length,
      P0_RECIPROCAL: claims.filter((claim) => claim.type === "P0_RECIPROCAL").length,
      total: claims.length,
    },
    reportRoot,
    claims,
  };
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function merkleRoot(hashes) {
  if (hashes.length === 0) return hashBytes(Buffer.from([0]));
  let level = [...hashes].sort().map(hexBytes);
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(hexBytes(hashBytes(Buffer.concat([Buffer.from([1]), left, right]))));
    }
    level = next;
  }
  return `0x${level[0].toString("hex")}`;
}

function buildSellerClaim({ seller, settlementAccumulator, fundingRecords, addressTraces, startBlock, endBlockExclusive }) {
  const verdict = classifyFinalVerdict(seller);
  if (!verdict || verdict.confidence === "CONFIRMED") return [];
  const type = verdict.priority === "P0" ? "P0_CLOSED_LOOP" : "P1_COORDINATED_CONTROL";
  const approvedBuyerSet = approvedBuyers(seller, verdict);
  const settlements = settlementsForSeller(settlementAccumulator, seller.seller)
    .filter((entry) => approvedBuyerSet.has(entry.buyer));
  const usdcFunding = fundingRecords
    .filter((record) => approvedBuyerSet.has(normalizeAddress(record.buyer)))
    .map((record) => locator("USDC_FUNDING", record, {
      buyer: normalizeAddress(record.buyer),
      funder: normalizeAddress(record.funder),
      amountRaw: String(record.amountRaw ?? 0),
      fundingKind: record.kind ?? null,
    }));
  const nativeFunding = [...approvedBuyerSet].flatMap((buyer) => {
    const funding = addressTraces.get(buyer)?.firstNativeFunding;
    if (!funding) return [];
    return [locator("NATIVE_FUNDING", funding, {
      buyer,
      funder: normalizeAddress(funding.from),
      amountWei: String(funding.amountWei ?? 0),
    })];
  });
  const cohort = seller.strongestCohort ?? {};
  const moneyLinks = type === "P0_CLOSED_LOOP" ? [
    ...(cohort.affiliations?.sellerFunder ?? []).map((entry) => locator("DIRECT_SELLER_FUNDER", entry, {
      seller: normalizeAddress(seller.seller), funder: normalizeAddress(cohort.funder), from: normalizeAddress(entry.from), to: normalizeAddress(entry.to), amountRaw: String(entry.amountRaw ?? 0),
    })),
    ...(cohort.affiliations?.sellerBuyer ?? []).map((entry) => locator("DIRECT_SELLER_BUYER", entry, {
      seller: normalizeAddress(seller.seller), buyer: approvedBuyerSet.has(normalizeAddress(entry.from)) ? normalizeAddress(entry.from) : normalizeAddress(entry.to), from: normalizeAddress(entry.from), to: normalizeAddress(entry.to), amountRaw: String(entry.amountRaw ?? 0),
    })),
    ...(cohort.affiliations?.sellerFunderIndirect ?? []).map((entry) => ({
      evidenceType: "RELAY_PATH",
      seller: normalizeAddress(seller.seller),
      funder: normalizeAddress(cohort.funder),
      relay: normalizeAddress(entry.relay),
      intermediary: normalizeAddress(entry.intermediary),
      sellerPayment: locator("RELAY_SELLER_PAYMENT", { txHash: entry.sellerPaymentTx, timestamp: entry.sellerPaymentAt }, { from: normalizeAddress(seller.seller), to: normalizeAddress(entry.relay), amountRaw: String(entry.sellerPaymentRaw ?? 0) }),
      relayForward: locator("RELAY_FORWARD", { txHash: entry.relayForwardTx, timestamp: entry.relayForwardAt }, { from: normalizeAddress(entry.relay), to: normalizeAddress(entry.intermediary), amountRaw: String(entry.relayForwardRaw ?? 0) }),
      funderReceipt: locator("RELAY_FUNDER_RECEIPT", { txHash: entry.funderReceiptTx, timestamp: entry.funderReceiptAt }, { from: normalizeAddress(entry.intermediary), to: normalizeAddress(cohort.funder), amountRaw: String(entry.funderReceiptRaw ?? 0) }),
    })),
  ] : [];
  const sellerVolumeRaw = rawFrom(seller.stats, "volumeRaw", "volumeUsdc");
  const cohortVolumeRaw = type === "P0_CLOSED_LOOP"
    ? rawFrom(verdict.primaryUsdcExposure, "volumeRaw", "volumeUsdc")
    : rawFrom(verdict, "attributedVolumeRaw", "attributedVolumeUsdc");
  const dependencies = dedupeDependencies([...settlements, ...usdcFunding, ...nativeFunding, ...moneyLinks]);
  if (type === "P0_CLOSED_LOOP" && verdict.moneyLinkCodes.includes("seller_funder_transfer_link")
      && !dependencies.some((entry) => entry.evidenceType === "DIRECT_SELLER_FUNDER")) {
    throw new Error(`seller ${seller.seller} reports seller_funder_transfer_link without an exported direct transfer`);
  }
  return [{
    type,
    subjects: [normalizeAddress(seller.seller)],
    seller: normalizeAddress(seller.seller),
    approvedBuyers: [...approvedBuyerSet].sort(),
    approvedFunders: approvedFunders(seller, verdict),
    evidenceCodes: verdict.moneyLinkCodes ?? [],
    metrics: {
      sellerVolumeRaw: sellerVolumeRaw.toString(),
      qualifiedVolumeRaw: cohortVolumeRaw.toString(),
      qualifiedBuyerCount: approvedBuyerSet.size,
    },
    period: { startBlock, endBlockExclusive },
    dependencies,
  }];
}

function buildReciprocalClaim({ pair, settlementAccumulator, startBlock, endBlockExclusive }) {
  const walletA = normalizeAddress(pair.walletA);
  const walletB = normalizeAddress(pair.walletB);
  const dependencies = dedupeDependencies([
    ...settlementsForDirection(settlementAccumulator, walletA, walletB),
    ...settlementsForDirection(settlementAccumulator, walletB, walletA),
  ]);
  return {
    type: "P0_RECIPROCAL",
    subjects: [walletA, walletB].sort(),
    walletA,
    walletB,
    metrics: {
      volumeAToBRaw: String(pair.volumeAToBRaw),
      volumeBToARaw: String(pair.volumeBToARaw),
      settlementCount: pair.settlements,
      reciprocityNumeratorRaw: minRaw(pair.volumeAToBRaw, pair.volumeBToARaw),
      reciprocityDenominatorRaw: maxRaw(pair.volumeAToBRaw, pair.volumeBToARaw),
    },
    period: { startBlock, endBlockExclusive },
    dependencies,
  };
}

function finalizeClaim(claim) {
  const dependencies = claim.dependencies.map((dependency) => ({
    ...dependency,
    dependencyId: hashCanonical("dependency", dependency),
  })).sort((left, right) => left.dependencyId.localeCompare(right.dependencyId));
  const dependencyRoot = merkleRoot(dependencies.map((entry) => entry.dependencyId));
  const claimBody = { ...claim, dependencies: undefined, dependencyRoot };
  delete claimBody.dependencies;
  const claimId = hashCanonical("claim-id", claimBody);
  const leaf = { ...claimBody, claimId };
  return { ...leaf, leafHash: hashCanonical("claim-leaf", leaf), dependencies };
}

function settlementsForSeller(accumulator, seller) {
  const total = accumulator.sellerTotals.get(normalizeAddress(seller));
  if (!total) return [];
  return [...total.settlementsByBuyer.entries()].flatMap(([buyer, rows]) => rows.map((row) => locator("SETTLEMENT", row, {
    seller: normalizeAddress(seller), buyer: normalizeAddress(buyer), amountRaw: String(row.amountRaw ?? 0), channelId: row.channelId ?? null,
  })));
}

function settlementsForDirection(accumulator, buyer, seller) {
  const rows = accumulator.sellerTotals.get(seller)?.settlementsByBuyer.get(buyer) ?? [];
  return rows.map((row) => locator("RECIPROCAL_SETTLEMENT", row, { buyer, seller, amountRaw: String(row.amountRaw ?? 0), channelId: row.channelId ?? null }));
}

function locator(evidenceType, source, extra) {
  return {
    evidenceType,
    blockNumber: numericOrNull(source.blockNumber),
    transactionHash: source.txHash ?? source.transactionHash ?? null,
    transactionIndex: numericOrNull(source.transactionIndex),
    logIndex: numericOrNull(source.logIndex),
    timestamp: numericOrNull(source.timestamp),
    ...extra,
  };
}

function approvedBuyers(seller, verdict) {
  const buyers = new Set();
  if (verdict.primaryUsdcExposure?.material) {
    for (const buyer of seller.strongestCohort?.buyers ?? []) buyers.add(normalizeAddress(typeof buyer === "string" ? buyer : buyer?.buyer));
  }
  if (verdict.nativeExposure?.material) {
    for (const cohort of seller.networkSignals?.nativeFunderCohorts ?? []) {
      for (const buyer of cohort.buyerAddresses ?? []) buyers.add(normalizeAddress(buyer));
    }
  }
  buyers.delete(null);
  return buyers;
}

function approvedFunders(seller, verdict) {
  const funders = new Set();
  if (verdict.primaryUsdcExposure?.material) funders.add(normalizeAddress(seller.strongestCohort?.funder));
  if (verdict.nativeExposure?.material) {
    for (const cohort of seller.networkSignals?.nativeFunderCohorts ?? []) funders.add(normalizeAddress(cohort.funder));
  }
  funders.delete(null);
  return [...funders].sort();
}

function dedupeDependencies(values) {
  const byCanonical = new Map();
  for (const value of values) {
    if (!value) continue;
    const key = canonicalJson(value);
    if (!byCanonical.has(key)) byCanonical.set(key, value);
  }
  return [...byCanonical.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function hashCanonical(domain, value) {
  return hashBytes(Buffer.concat([Buffer.from(`${domain}\0`), Buffer.from(canonicalJson(value))]));
}

function hashBytes(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function hexBytes(value) {
  if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`invalid hash ${value}`);
  return Buffer.from(value.slice(2), "hex");
}

function requireBlockPeriod(startBlock, endBlockExclusive) {
  if (!Number.isSafeInteger(startBlock) || !Number.isSafeInteger(endBlockExclusive) || startBlock < 0 || endBlockExclusive <= startBlock) {
    throw new Error("proof export requires a valid --start-block/--end-block-exclusive period");
  }
}

function rawFrom(value, rawKey, usdcKey) {
  if (value?.[rawKey] != null) return BigInt(value[rawKey]);
  return BigInt(Math.round((value?.[usdcKey] ?? 0) * 1_000_000));
}

function minRaw(left, right) {
  return (BigInt(left) < BigInt(right) ? BigInt(left) : BigInt(right)).toString();
}

function maxRaw(left, right) {
  return (BigInt(left) > BigInt(right) ? BigInt(left) : BigInt(right)).toString();
}

function normalizeAddress(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function numericOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

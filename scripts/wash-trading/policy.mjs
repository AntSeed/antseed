export const WASH_TRADING_POLICY_VERSION = "wash-trading-policy-v1";

export const FINAL_VERDICT_THRESHOLDS = Object.freeze({
  minimumCohortBuyers: 3,
  minimumCohortVolumeRaw: "1000000000",
  minimumCohortSellerVolumeBps: 5_000,
  minimumReciprocalSettlements: 100,
  minimumReciprocityBps: 8_000,
  minimumDependentSellerShareBps: 9_900,
  relayWindowSeconds: 86_400,
  relayAmountToleranceRaw: "1000",
  relayMaximumRetainedRaw: "1000000",
  relayMinimumForwardBps: 9_800,
  penaltyBps: 9_000,
});

export function classifyFinalVerdict(seller) {
  const signals = seller.networkSignals ?? emptyNetworkSignals();
  const reciprocalPairs = signals.reciprocalPairs?.length ?? 0;
  const nativeFunderCohorts = signals.nativeFunderCohorts?.length ?? 0;
  const nativeExposure = summarizeNativeFunderExposure(seller, signals.nativeFunderCohorts ?? []);
  const primaryUsdcExposure = summarizePrimaryUsdcFunderExposure(seller);
  const evidenceCodes = new Set((seller.evidence ?? []).map((item) => item.code));
  const moneyLinkCodes = ["seller_funder_transfer_link", "buyer_seller_return_flow", "seller_funder_relay_path"]
    .filter((code) => evidenceCodes.has(code));
  const evidence = [];

  if (reciprocalPairs > 0) {
    evidence.push(`${reciprocalPairs} confirmed reciprocal settlement ${reciprocalPairs === 1 ? "pair" : "pairs"}`);
    return { confidence: "CONFIRMED", label: "Confirmed reciprocal loop", rank: 4, priority: "P0", evidence };
  }

  if (primaryUsdcExposure.material && moneyLinkCodes.length > 0) {
    evidence.push(`${primaryUsdcExposure.buyers} buyers share a primary USDC funder · $${primaryUsdcExposure.volumeUsdc.toFixed(2)} · ${(primaryUsdcExposure.sellerVolumeShare * 100).toFixed(1)}% of seller volume`);
    evidence.push(`${moneyLinkCodes.length} qualifying seller money-flow ${moneyLinkCodes.length === 1 ? "link" : "links"}`);
    return {
      confidence: "STRONG_LEAD",
      label: "Strong lead: closed money loop",
      rank: 3,
      priority: "P0",
      evidence,
      nativeExposure,
      primaryUsdcExposure,
      moneyLinkCodes,
    };
  }

  if (nativeExposure.material || primaryUsdcExposure.material) {
    const attribution = summarizeP1Attribution(seller, {
      nativeExposure,
      primaryUsdcExposure,
      nativeFunderCohorts: signals.nativeFunderCohorts ?? [],
    });
    if (nativeExposure.material) evidence.push(`${nativeExposure.buyers} buyers across ${nativeFunderCohorts} first-native-funder ${nativeFunderCohorts === 1 ? "cohort" : "cohorts"} · $${nativeExposure.volumeUsdc.toFixed(2)} · ${(nativeExposure.sellerVolumeShare * 100).toFixed(1)}% of seller volume`);
    if (primaryUsdcExposure.material) evidence.push(`${primaryUsdcExposure.buyers} buyers share a primary USDC funder · $${primaryUsdcExposure.volumeUsdc.toFixed(2)} · ${(primaryUsdcExposure.sellerVolumeShare * 100).toFixed(1)}% of seller volume`);
    return {
      confidence: "STRONG_LEAD",
      label: "Strong lead: coordinated buyer control",
      rank: 3,
      priority: "P1",
      evidence,
      nativeExposure,
      primaryUsdcExposure,
      moneyLinkCodes,
      attributedBuyerCount: attribution.buyers,
      attributedVolumeRaw: attribution.volumeRaw,
      attributedVolumeUsdc: attribution.volumeUsdc,
    };
  }

  return null;
}

export function meetsRatio(numerator, denominator, minimumBps) {
  const numeratorRaw = BigInt(numerator ?? 0);
  const denominatorRaw = BigInt(denominator ?? 0);
  return denominatorRaw > 0n && numeratorRaw * 10_000n >= denominatorRaw * BigInt(minimumBps);
}

function summarizeP1Attribution(seller, { nativeExposure, primaryUsdcExposure, nativeFunderCohorts }) {
  const attributedBuyers = new Set();
  if (nativeExposure.material) {
    for (const cohort of nativeFunderCohorts) {
      for (const buyer of cohort.buyerAddresses ?? []) attributedBuyers.add(normalizedKey(buyer));
    }
  }
  if (primaryUsdcExposure.material) {
    for (const buyer of seller.strongestCohort?.buyers ?? []) {
      attributedBuyers.add(normalizedKey(typeof buyer === "string" ? buyer : buyer?.buyer));
    }
  }
  attributedBuyers.delete("");
  let volumeRaw = 0n;
  let buyers = 0;
  for (const buyer of seller.buyers ?? []) {
    if (!attributedBuyers.has(normalizedKey(buyer.buyer))) continue;
    volumeRaw += rawUsdcValue(buyer);
    buyers += 1;
  }
  return { buyers, volumeRaw: volumeRaw.toString(), volumeUsdc: Number(volumeRaw) / 1_000_000 };
}

function summarizePrimaryUsdcFunderExposure(seller) {
  const cohort = seller.strongestCohort ?? {};
  const buyers = cohort.buyerCount ?? cohort.buyers?.length ?? 0;
  const volumeRaw = rawFromFields(cohort, "volumeRaw", "volumeUsdc");
  const sellerVolumeRaw = rawFromFields(seller.stats, "volumeRaw", "volumeUsdc");
  const volumeUsdc = Number(volumeRaw) / 1_000_000;
  const sellerVolumeShare = sellerVolumeRaw > 0n ? Number(volumeRaw) / Number(sellerVolumeRaw) : 0;
  return {
    material: buyers >= FINAL_VERDICT_THRESHOLDS.minimumCohortBuyers
      && volumeRaw >= BigInt(FINAL_VERDICT_THRESHOLDS.minimumCohortVolumeRaw)
      && meetsRatio(volumeRaw, sellerVolumeRaw, FINAL_VERDICT_THRESHOLDS.minimumCohortSellerVolumeBps),
    funder: cohort.funder ?? null,
    buyers,
    volumeRaw: volumeRaw.toString(),
    volumeUsdc,
    sellerVolumeShare,
  };
}

function summarizeNativeFunderExposure(seller, cohorts) {
  const buyers = cohorts.reduce((total, cohort) => total + (cohort.buyers ?? 0), 0);
  const volumeRaw = cohorts.reduce((total, cohort) => total + rawFromFields(cohort, "volumeRaw", "volumeUsdc"), 0n);
  const sellerVolumeRaw = rawFromFields(seller.stats, "volumeRaw", "volumeUsdc");
  const volumeUsdc = Number(volumeRaw) / 1_000_000;
  const sellerVolumeShare = sellerVolumeRaw > 0n ? Number(volumeRaw) / Number(sellerVolumeRaw) : 0;
  return {
    material: buyers >= FINAL_VERDICT_THRESHOLDS.minimumCohortBuyers
      && volumeRaw >= BigInt(FINAL_VERDICT_THRESHOLDS.minimumCohortVolumeRaw)
      && meetsRatio(volumeRaw, sellerVolumeRaw, FINAL_VERDICT_THRESHOLDS.minimumCohortSellerVolumeBps),
    cohorts: cohorts.length,
    buyers,
    volumeRaw: volumeRaw.toString(),
    volumeUsdc,
    sellerVolumeShare,
  };
}

function rawFromFields(value, rawKey, usdcKey) {
  if (value?.[rawKey] != null) return BigInt(value[rawKey]);
  return BigInt(Math.round((value?.[usdcKey] ?? 0) * 1_000_000));
}

function rawUsdcValue(buyer) {
  return rawFromFields(buyer, "volumeRaw", "volumeUsdc");
}

function normalizedKey(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function emptyNetworkSignals() {
  return { nativeFunderCohorts: [], fundingBatches: [], reciprocalPairs: [], flowThrough: null };
}

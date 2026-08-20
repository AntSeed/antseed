#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { id as serviceMetadataId } from "ethers";
import { basename, join, resolve } from "node:path";
import {
  SCAN_SCHEMA_VERSION,
  SCORING_VERSION,
  accumulateSettlementPage,
  accumulateServiceSalesPage,
  analyzeSeller,
  buildAnalysisContext,
  channelOverlapsPeriod,
  createSettlementAccumulator,
  createServiceSalesAccumulator,
  normalizeAddress,
  parseIsoSeconds,
  resolveHistoricalPeriod,
  selectDirectFunderTraceCandidates,
  selectRelayTraceCandidates,
} from "./wash-trading/core.mjs";
import {
  createAntscanClient,
  createBlockscoutClient,
  BASE_RPC_URL,
  findSettlementEarliest,
  fundingRecordsFromTraces,
  mapWithConcurrency,
  PROTOCOL_ADDRESSES,
  streamSettlementPages,
} from "./wash-trading/data-sources.mjs";
import { ensureDirectory, readJson, sha256, writeJsonAtomic } from "./wash-trading/io.mjs";
import { analyzeNetwork, annotateSellerReports, NETWORK_ANALYSIS_VERSION } from "./wash-trading/network-analysis.mjs";
import { summarizePriorityVolumes, writeScanArtifacts } from "./wash-trading/report.mjs";
import { writeProofBundle } from "./wash-trading/proof-bundle.mjs";

const DEFAULT_ANTSCAN_URL = "https://antscan.co";
const DEFAULT_BLOCKSCOUT_URL = "https://base.blockscout.com";
const DEFAULT_MAX_AUXILIARY_TRANSFERS = 25_000;

export async function runWashTradingScan(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(helpText());
    return { help: true };
  }

  const now = dependencies.now ?? (() => Date.now());
  const scanStartedAt = now();
  const progress = dependencies.progress ?? createProgressReporter();
  const resumeDirectory = options.resume ? resolve(expandHome(options.resume)) : null;
  let outputDirectory;
  let manifest;

  if (resumeDirectory) {
    outputDirectory = resumeDirectory;
    manifest = await readJson(join(outputDirectory, "manifest.json"));
    if (!manifest) throw new Error(`No manifest.json found in resume directory ${outputDirectory}`);
    validateResumeOptions(options, manifest);
  } else {
    const timestamp = new Date(scanStartedAt).toISOString().replace(/[:.]/g, "-");
    outputDirectory = resolve(expandHome(options.output ?? join(homedir(), ".antseed", "forensics", "wash-trading", "scans", timestamp)));
    manifest = createInitialManifest(options, outputDirectory, scanStartedAt);
    await ensureDirectory(outputDirectory);
    await writeJsonAtomic(join(outputDirectory, "manifest.json"), manifest);
  }

  const checkpointPath = join(outputDirectory, "checkpoint.json");
  const checkpoint = await readJson(checkpointPath, { version: 1, antscan: {}, traces: {}, stage: "starting", updatedAt: null });
  checkpoint.antscan ??= {};
  checkpoint.traces ??= {};
  const persistCheckpoint = async () => {
    checkpoint.updatedAt = new Date(now()).toISOString();
    await writeJsonAtomic(checkpointPath, checkpoint);
  };

  const rawDirectory = join(outputDirectory, "raw", "antscan");
  const cacheDirectory = resolve(expandHome(options.cacheDir ?? manifest.cacheDirectory));
  const requestTimeoutMs = options.requestTimeoutMs ?? manifest.runtime.requestTimeoutMs;
  const maxRetries = options.maxRetries ?? manifest.runtime.maxRetries;
  const blockscoutConcurrency = options.blockscoutConcurrency ?? manifest.runtime.blockscoutConcurrency;
  const maxAuxiliaryTransfers = options.maxAuxiliaryTransfers ?? manifest.runtime.maxAuxiliaryTransfers ?? DEFAULT_MAX_AUXILIARY_TRANSFERS;
  const configuredRpcUrl = options.rpcUrl ?? process.env.ANTSEED_BASE_RPC_URL ?? process.env.BASE_RPC_URL ?? null;
  const rpcUrl = configuredRpcUrl ?? BASE_RPC_URL;
  await ensureDirectory(cacheDirectory);

  const antscan = createAntscanClient({
    baseUrl: manifest.sources.antscan,
    requestTimeoutMs,
    maxRetries,
    rawDirectory,
    checkpoint,
    persistCheckpoint,
    progress,
  });
  await antscan.validateSchema();
  checkpoint.stage = "collecting-antscan";
  await persistCheckpoint();

  const collectionPaths = {};
  const collectionToTimestamp = manifest.request.to == null
    ? Math.floor(Date.parse(manifest.scanStartedAt) / 1000)
    : parseIsoSeconds(manifest.request.to, "--to");
  const collectionFilters = {
    sellers: { firstSeenAt_lt: collectionToTimestamp },
    buyerSellerPairs: { firstSeenAt_lt: collectionToTimestamp },
    channels: {
      openedAt_lt: collectionToTimestamp,
      ...(manifest.request.seller ? { seller: manifest.request.seller } : {}),
    },
    firstDeposits: { timestamp_lt: collectionToTimestamp },
    accounts: { firstSeenAt_lt: collectionToTimestamp },
  };
  for (const name of ["sellers", "buyerSellerPairs", "channels", "firstDeposits", "accounts"]) {
    collectionPaths[name] = (await antscan.fetchCollection(name, { where: collectionFilters[name] })).path;
  }

  const [sellers, buyerSellerPairs, channels, firstDeposits, accounts] = await Promise.all([
    antscan.collectCollection("sellers", collectionPaths.sellers),
    antscan.collectCollection("buyerSellerPairs", collectionPaths.buyerSellerPairs),
    antscan.collectCollection("channels", collectionPaths.channels),
    antscan.collectCollection("firstDeposits", collectionPaths.firstDeposits),
    antscan.collectCollection("accounts", collectionPaths.accounts),
  ]);
  const targetBuyerSet = new Set();
  if (manifest.request.seller) {
    for (const channel of channels) {
      const buyer = normalizeAddress(channel.buyer);
      if (buyer) targetBuyerSet.add(buyer);
    }
    for (const pair of buyerSellerPairs) {
      if (normalizeAddress(pair.seller) !== manifest.request.seller) continue;
      const buyer = normalizeAddress(pair.buyer);
      if (buyer) targetBuyerSet.add(buyer);
    }
  }
  const settlementFilter = manifest.request.seller
    ? {
        timestamp_lt: collectionToTimestamp,
        OR: [
          { seller: manifest.request.seller },
          ...(targetBuyerSet.size > 0 ? [{ buyer_in: [...targetBuyerSet] }] : []),
        ],
      }
    : { timestamp_lt: collectionToTimestamp };
  collectionPaths.settlementVolumes = (await antscan.fetchCollection("settlementVolumes", { where: settlementFilter })).path;
  collectionPaths.settlementServices = (await antscan.fetchCollection("settlementServices", { where: settlementFilter })).path;
  const settlementEarliest = await findSettlementEarliest(collectionPaths.settlementVolumes);

  const requestedFrom = manifest.request.from == null ? null : parseIsoSeconds(manifest.request.from, "--from");
  const requestedTo = manifest.request.to == null ? null : parseIsoSeconds(manifest.request.to, "--to");
  const period = resolveHistoricalPeriod({
    sellers,
    channels,
    firstDeposits,
    accounts,
    settlementEarliest,
    fromOverride: requestedFrom,
    toOverride: requestedTo,
    scanStartedAt: Date.parse(manifest.scanStartedAt),
  });
  if (manifest.period && (manifest.period.from !== period.from || manifest.period.to !== period.to)) {
    throw new Error("Resolved historical period differs from the persisted resume manifest");
  }
  manifest.period = period;
  manifest.status = "running";
  await writeJsonAtomic(join(outputDirectory, "manifest.json"), manifest);
  if (manifest.request.seller) {
    console.log(`Target seller: ${manifest.request.seller}${resumeDirectory ? " (from resume manifest)" : ""}`);
  }
  console.log(`${period.allHistory ? "All indexed history" : "Selected history"}: ${period.fromIso} – ${period.toIso}`);
  console.log(`Transfer tracing: ${configuredRpcUrl ? "configured RPC" : "Blockscout"}, Base USDC only, ${period.fromIso} – ${period.toIso}`);
  console.log(`Auxiliary address cap: ${maxAuxiliaryTransfers.toLocaleString()} period-matching transfers`);

  checkpoint.stage = "aggregating-settlements";
  await persistCheckpoint();
  const settlementAccumulator = createSettlementAccumulator();
  await streamSettlementPages(collectionPaths.settlementVolumes, async (items) => {
    accumulateSettlementPage(settlementAccumulator, items, period);
  });
  const serviceSalesAccumulator = createServiceSalesAccumulator();
  await streamSettlementPages(collectionPaths.settlementServices, async (items) => {
    accumulateServiceSalesPage(serviceSalesAccumulator, items, period);
  });
  const { serviceCatalogBySeller, sellerProfilesBySeller } = await loadServiceCatalogBySeller({
    dataDirectory: resolve(expandHome(options.dataDir ?? join(homedir(), ".antseed"))),
    snapshotPath: join(outputDirectory, "raw", "service-catalog.json"),
    labelsPath: options.sellerLabels ? resolve(expandHome(options.sellerLabels)) : null,
    observedAt: new Date(now()).toISOString(),
  });

  const relevantChannels = channels.filter((channel) => {
    const seller = normalizeAddress(channel.seller);
    return seller && channelOverlapsPeriod(channel, period) && (!manifest.request.seller || seller === manifest.request.seller);
  });
  const relevantSellerSet = new Set();
  for (const seller of sellers) {
    const address = normalizeAddress(seller.address);
    if (address && (!manifest.request.seller || address === manifest.request.seller)) relevantSellerSet.add(address);
  }
  for (const seller of settlementAccumulator.sellerTotals.keys()) {
    if (!manifest.request.seller || seller === manifest.request.seller) relevantSellerSet.add(seller);
  }
  for (const channel of relevantChannels) relevantSellerSet.add(normalizeAddress(channel.seller));
  if (manifest.request.seller && !relevantSellerSet.has(manifest.request.seller)) {
    throw new Error(`Seller ${manifest.request.seller} has no indexed AntSeed activity`);
  }

  const allBuyerSet = new Set();
  if (manifest.request.seller) {
    for (const buyer of settlementAccumulator.sellerTotals.get(manifest.request.seller)?.buyers.keys() ?? []) allBuyerSet.add(buyer);
  } else {
    for (const buyer of settlementAccumulator.buyerTotals.keys()) allBuyerSet.add(buyer);
  }
  for (const channel of relevantChannels) {
    const buyer = normalizeAddress(channel.buyer);
    if (buyer) allBuyerSet.add(buyer);
  }

  checkpoint.stage = "tracing-protocol-deposits";
  await persistCheckpoint();
  const blockscout = createBlockscoutClient({
    baseUrl: manifest.sources.blockscout,
    rpcUrl,
    rpcTransferTracing: configuredRpcUrl != null,
    cacheDirectory,
    requestTimeoutMs,
    maxRetries,
    fromTimestamp: period.from,
    toTimestamp: period.to,
    transactionConcurrency: blockscoutConcurrency,
  });
  const protocolDepositsPath = join(outputDirectory, "raw", "protocol-deposits.json");
  const protocolDepositBuyers = [...allBuyerSet].sort();
  let protocolDeposits = await readJson(protocolDepositsPath);
  if (!isReusableProtocolDepositArtifact(protocolDeposits, protocolDepositBuyers)) {
    protocolDeposits = await blockscout.fetchProtocolDeposits({
      buyers: protocolDepositBuyers,
      onProgress: ({ stage, completed, total }) => progress({
        phase: "blockscout",
        label: stage === "transaction-senders" ? "deposit senders" : "buyer deposit logs",
        completed,
        total,
      }),
    });
    protocolDeposits = {
      ...protocolDeposits,
      query: { scope: "buyers", buyers: protocolDepositBuyers },
    };
    await writeJsonAtomic(protocolDepositsPath, protocolDeposits);
  }

  const relevantProtocolDeposits = protocolDeposits.records.filter((record) => allBuyerSet.has(record.buyer));
  const funderSet = new Set(relevantProtocolDeposits.map((record) => record.funder));
  const traceAddresses = [...new Set([...allBuyerSet, ...relevantSellerSet, ...funderSet])].filter(Boolean).sort();
  const traceDirectory = join(outputDirectory, "raw", "traces");
  await ensureDirectory(traceDirectory);
  let traced = 0;
  checkpoint.stage = "tracing-addresses";
  await persistCheckpoint();
  const traceEntries = await mapWithConcurrency(traceAddresses, blockscoutConcurrency, async (address) => {
    const tracePath = join(traceDirectory, `${address}.json`);
    let trace = await loadTraceArtifact(tracePath, address, period);
    if (!trace) {
      trace = await blockscout.traceAddress(address);
      await writeJsonAtomic(tracePath, trace);
    }
    traced += 1;
    checkpoint.traces[address] = { complete: trace.complete, errors: trace.errors };
    if (traced % 10 === 0 || traced === traceAddresses.length) await persistCheckpoint();
    progress({ phase: configuredRpcUrl ? "alchemy" : "blockscout", label: "addresses", completed: traced, total: traceAddresses.length });
    return [address, trace];
  });
  const addressTraces = new Map(traceEntries);

  checkpoint.stage = "tracing-first-native-funding";
  await persistCheckpoint();
  const firstNativeFundingPath = join(outputDirectory, "raw", "first-native-funding.json");
  const firstNativeFundingBuyers = [...allBuyerSet].sort();
  let firstNativeFunding = await readJson(firstNativeFundingPath);
  if (!isReusableFirstNativeFundingArtifact(firstNativeFunding, firstNativeFundingBuyers, period.to)) {
    firstNativeFunding = await blockscout.fetchFirstNativeFundings({
      buyers: firstNativeFundingBuyers,
      onProgress: ({ completed, total }) => progress({
        phase: configuredRpcUrl ? "alchemy" : "blockscout",
        label: "first native funders",
        completed,
        total,
      }),
    });
    firstNativeFunding.query = {
      scope: "positive-and-channel-buyers",
      buyers: firstNativeFundingBuyers,
      toTimestamp: period.to,
      nativeFundingScope: "first_ever_before_scan_end",
    };
    await writeJsonAtomic(firstNativeFundingPath, firstNativeFunding);
  }
  for (const record of firstNativeFunding.records ?? []) {
    const trace = addressTraces.get(record.buyer);
    if (trace) trace.firstNativeFunding = {
      from: record.from,
      amountWei: record.amountWei,
      timestamp: record.timestamp,
      txHash: record.txHash,
    };
  }

  const directFunding = fundingRecordsFromTraces(addressTraces, allBuyerSet);
  const directFunderCandidates = selectDirectFunderTraceCandidates({
    records: directFunding,
    excludedAddresses: new Set([...addressTraces.keys(), ...PROTOCOL_ADDRESSES]),
  });
  if (directFunderCandidates.length > 0) {
    checkpoint.stage = "tracing-direct-funders";
    await persistCheckpoint();
    let directFundersTraced = 0;
    const directFunderTraceEntries = await mapWithConcurrency(directFunderCandidates, blockscoutConcurrency, async (address) => {
      const tracePath = join(traceDirectory, `${address}.json`);
      let trace = await loadTraceArtifact(tracePath, address, period, maxAuxiliaryTransfers);
      if (!trace) {
        trace = await blockscout.traceAddress(address, { maxTransfers: maxAuxiliaryTransfers });
        await writeJsonAtomic(tracePath, trace);
      }
      directFundersTraced += 1;
      checkpoint.traces[address] = { complete: trace.complete, errors: trace.errors, skipped: trace.skipped ?? null, purpose: "direct_buyer_funder" };
      if (directFundersTraced % 10 === 0 || directFundersTraced === directFunderCandidates.length) await persistCheckpoint();
      progress({ phase: configuredRpcUrl ? "alchemy" : "blockscout", label: "direct funders", completed: directFundersTraced, total: directFunderCandidates.length });
      return [address, trace];
    });
    for (const [address, trace] of directFunderTraceEntries) addressTraces.set(address, trace);
  }

  const relayCandidates = selectRelayTraceCandidates({
    sellers: relevantSellerSet,
    addressTraces,
    excludedAddresses: new Set([...addressTraces.keys(), ...PROTOCOL_ADDRESSES]),
  });
  if (relayCandidates.length > 0) {
    checkpoint.stage = "tracing-dominant-recipients";
    await persistCheckpoint();
    let relayTraced = 0;
    const relayTraceEntries = await mapWithConcurrency(relayCandidates, blockscoutConcurrency, async (address) => {
      const tracePath = join(traceDirectory, `${address}.json`);
      let trace = await loadTraceArtifact(tracePath, address, period, maxAuxiliaryTransfers);
      if (!trace) {
        trace = await blockscout.traceAddress(address, { maxTransfers: maxAuxiliaryTransfers });
        await writeJsonAtomic(tracePath, trace);
      }
      relayTraced += 1;
      checkpoint.traces[address] = { complete: trace.complete, errors: trace.errors, skipped: trace.skipped ?? null, purpose: "dominant_seller_recipient" };
      if (relayTraced % 10 === 0 || relayTraced === relayCandidates.length) await persistCheckpoint();
      progress({ phase: configuredRpcUrl ? "alchemy" : "blockscout", label: "dominant recipients", completed: relayTraced, total: relayCandidates.length });
      return [address, trace];
    });
    for (const [address, trace] of relayTraceEntries) addressTraces.set(address, trace);
  }

  const fundingRecords = [...relevantProtocolDeposits, ...directFunding];
  const context = buildAnalysisContext({
    sellers,
    channels,
    firstDeposits,
    settlementAccumulator,
    fundingRecords,
    addressTraces,
    period,
    protocolDepositsComplete: protocolDeposits.complete,
    serviceSalesBySeller: serviceSalesAccumulator.bySeller,
    serviceCatalogBySeller,
  });

  checkpoint.stage = "analyzing-sellers";
  await persistCheckpoint();
  const sellerAddresses = [...relevantSellerSet].sort();
  let sellerReports = [];
  for (let index = 0; index < sellerAddresses.length; index += 1) {
    const seller = sellerAddresses[index];
    const profile = sellerProfilesBySeller.get(seller) ?? null;
    sellerReports.push({
      ...analyzeSeller(seller, context),
      displayName: profile?.displayName ?? null,
      peerId: profile?.peerId ?? null,
    });
    progress({ phase: "analysis", label: "sellers", completed: index + 1, total: sellerAddresses.length });
  }

  const networkAnalysis = analyzeNetwork({
    settlementAccumulator,
    addressTraces,
    sellerProfilesBySeller,
    period,
  });
  sellerReports = annotateSellerReports(sellerReports, networkAnalysis);

  const traceStatus = classifyScanStatus(protocolDeposits.complete, addressTraces.values(), firstNativeFunding.complete);
  const { status, incompleteTraces, retryableIncompleteTraces, highVolumeSkippedTraces } = traceStatus;
  const prioritySummary = summarizePriorityVolumes(sellerReports, networkAnalysis);
  const scanSummary = {
    version: 1,
    kind: "antseed-historical-wash-trading-scan",
    scanId: manifest.scanId,
    scoringVersion: SCORING_VERSION,
    networkAnalysisVersion: NETWORK_ANALYSIS_VERSION,
    generatedAt: new Date(now()).toISOString(),
    status,
    period,
    sources: manifest.sources,
    counts: {
      sellers: sellerReports.length,
      buyers: allBuyerSet.size,
      channels: relevantChannels.length,
      buyerSellerPairs: buyerSellerPairs.length,
      accounts: accounts.length,
      settlements: settlementAccumulator.includedCount,
      serviceSettlements: serviceSalesAccumulator.includedCount,
      protocolDeposits: relevantProtocolDeposits.length,
      firstNativeFundings: firstNativeFunding.records?.length ?? 0,
      firstNativeFundingComplete: firstNativeFunding.complete,
      tracedAddresses: addressTraces.size,
      dominantRecipientsTraced: relayCandidates.length,
      directFundersTraced: directFunderCandidates.length,
      incompleteTraces,
      retryableIncompleteTraces,
      highVolumeSkippedTraces,
      fundingCohorts: networkAnalysis.counts.fundingCohorts,
      reciprocalPairs: networkAnalysis.counts.reciprocalPairs,
      reciprocalWallets: networkAnalysis.counts.reciprocalWallets,
      findings: prioritySummary.findingCounts.P0 + prioritySummary.findingCounts.P1,
      priorities: prioritySummary.findingCounts,
    },
  };

  let proofBundlePath = null;
  if (options.proofOutput) {
    proofBundlePath = resolve(expandHome(options.proofOutput));
    await writeProofBundle(proofBundlePath, {
      scan: scanSummary,
      sellerReports,
      networkAnalysis,
      settlementAccumulator,
      fundingRecords,
      addressTraces,
      startBlock: options.startBlock,
      endBlockExclusive: options.endBlockExclusive,
      contracts: {
        usdc: "0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase(),
        channels: "0xba66d3b4fbcf472f6f11d6f9f96aace96516f09d",
        deposits: "0x0f7a3a8f4da01637d1202bb5443fcf7f88f99fd2",
      },
    });
  }

  checkpoint.stage = "rendering";
  await persistCheckpoint();
  const artifacts = await writeScanArtifacts(outputDirectory, scanSummary, sellerReports, networkAnalysis);
  manifest.status = status;
  manifest.completedAt = new Date(now()).toISOString();
  manifest.artifacts = artifacts;
  manifest.counts = scanSummary.counts;
  await writeJsonAtomic(join(outputDirectory, "manifest.json"), manifest);
  checkpoint.stage = status;
  await persistCheckpoint();
  progress({ phase: "done" });

  console.log(`Report: ${artifacts.reportPath}`);
  console.log(`Sellers screened: ${sellerReports.length} | P0 findings: ${prioritySummary.findingCounts.P0} | P1 findings: ${prioritySummary.findingCounts.P1}`);
  console.log(`Network: ${networkAnalysis.fundingCohorts.length} shared first-ETH-funder cohorts | ${networkAnalysis.reciprocalPairs.length} reciprocal pairs`);
  if (status === "partial") console.log(`Funding traces are incomplete. Resume with:\n  pnpm run wash-trading:scan -- --resume ${JSON.stringify(outputDirectory)}`);
  if (status === "bounded") console.log(`High-volume infrastructure skipped: ${highVolumeSkippedTraces} address(es) exceeded the auxiliary transfer cap.`);
  return { outputDirectory, manifest, scanSummary, sellerReports, proofBundlePath, ...artifacts };
}

function isReusableProtocolDepositArtifact(artifact, buyers) {
  if (!artifact || !Array.isArray(artifact.records)) return false;
  if (artifact.query?.scope !== "buyers" || !Array.isArray(artifact.query.buyers)) return false;
  const stored = [...artifact.query.buyers].sort();
  const requested = [...buyers].sort();
  return stored.length === requested.length && stored.every((buyer, index) => buyer === requested[index]);
}

function isReusableFirstNativeFundingArtifact(artifact, buyers, toTimestamp) {
  return artifact?.version === 1
    && artifact.scope === "first_ever_before_scan_end"
    && artifact.query?.nativeFundingScope === "first_ever_before_scan_end"
    && artifact.query?.toTimestamp === toTimestamp
    && Array.isArray(artifact.query?.buyers)
    && artifact.query.buyers.length === buyers.length
    && artifact.query.buyers.every((buyer, index) => buyer === buyers[index]);
}

async function loadServiceCatalogBySeller({ dataDirectory, snapshotPath, labelsPath, observedAt }) {
  const state = await readJson(join(dataDirectory, "buyer.state.json"), {});
  const serviceCatalogBySeller = new Map();
  const sellerProfilesBySeller = new Map();
  const existingSnapshot = await readJson(snapshotPath, { sellers: [] });
  for (const profile of existingSnapshot.sellers ?? []) {
    const seller = normalizeAddress(profile.seller);
    if (!seller) continue;
    sellerProfilesBySeller.set(seller, { displayName: profile.displayName ?? null, peerId: profile.peerId ?? null });
    serviceCatalogBySeller.set(seller, new Map((profile.services ?? []).map((service) => [serviceMetadataId(service.service.trim()).toLowerCase(), service])));
  }
  for (const peer of state.discoveredPeers ?? []) {
    const seller = normalizeAddress(peer.sellerContract ? `0x${String(peer.sellerContract).replace(/^0x/i, "")}` : `0x${String(peer.peerId ?? "").replace(/^0x/i, "")}`);
    if (!seller) continue;
    const displayName = typeof peer.displayName === "string" && peer.displayName.trim() ? peer.displayName.trim() : null;
    const peerId = typeof peer.peerId === "string" && peer.peerId.trim() ? peer.peerId.trim() : null;
    const existingProfile = sellerProfilesBySeller.get(seller);
    const byServiceId = new Map(serviceCatalogBySeller.get(seller) ?? []);
    for (const [provider, pricing] of Object.entries(peer.providerPricing ?? {})) {
      for (const [service, rates] of Object.entries(pricing.services ?? {})) {
        byServiceId.set(serviceMetadataId(service.trim()).toLowerCase(), {
          service,
          provider,
          inputUsdPerMillion: finiteOrNull(rates?.inputUsdPerMillion),
          outputUsdPerMillion: finiteOrNull(rates?.outputUsdPerMillion),
          observedAt,
        });
      }
    }
    for (const [provider, protocols] of Object.entries(peer.providerServiceApiProtocols ?? {})) {
      for (const service of Object.keys(protocols.services ?? {})) {
        const serviceId = serviceMetadataId(service.trim()).toLowerCase();
        if (!byServiceId.has(serviceId)) byServiceId.set(serviceId, { service, provider, inputUsdPerMillion: null, outputUsdPerMillion: null, observedAt });
      }
    }
    serviceCatalogBySeller.set(seller, byServiceId);
    sellerProfilesBySeller.set(seller, {
      displayName: displayName ?? existingProfile?.displayName ?? null,
      peerId: peerId ?? existingProfile?.peerId ?? null,
    });
  }
  if (labelsPath) {
    const labels = parseSellerLabelsCsv(await readFile(labelsPath, "utf8"));
    for (const [seller, displayName] of labels) {
      const existingProfile = sellerProfilesBySeller.get(seller);
      sellerProfilesBySeller.set(seller, { displayName, peerId: existingProfile?.peerId ?? null });
    }
  }
  const snapshot = {
    version: 2,
    observedAt,
    peersUpdatedAt: state.peersUpdatedAt ?? null,
    labelsPath,
    sellers: [...new Set([...serviceCatalogBySeller.keys(), ...sellerProfilesBySeller.keys()])].sort().map((seller) => ({
      seller,
      peerId: sellerProfilesBySeller.get(seller)?.peerId ?? null,
      displayName: sellerProfilesBySeller.get(seller)?.displayName ?? null,
      services: [...(serviceCatalogBySeller.get(seller)?.values() ?? [])],
    })),
  };
  await writeJsonAtomic(snapshotPath, snapshot);
  return { serviceCatalogBySeller, sellerProfilesBySeller };
}

export function parseSellerLabelsCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return new Map();
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const addressIndex = headers.findIndex((header) => header === "address" || header === "seller");
  const nameIndex = headers.findIndex((header) => header === "display_name" || header === "displayname" || header === "name");
  if (addressIndex < 0 || nameIndex < 0) throw new Error("Seller labels CSV must contain address (or seller) and display_name (or name) columns");
  const labels = new Map();
  for (const row of rows.slice(1)) {
    const address = normalizeAddress(row[addressIndex]);
    const displayName = row[nameIndex]?.trim();
    if (address && displayName) labels.set(address, displayName);
  }
  return labels;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(value); value = ""; }
    else if (character === "\n") { row.push(value.replace(/\r$/, "")); if (row.some(Boolean)) rows.push(row); row = []; value = ""; }
    else value += character;
  }
  if (value || row.length > 0) { row.push(value.replace(/\r$/, "")); if (row.some(Boolean)) rows.push(row); }
  return rows;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function createInitialManifest(options, outputDirectory, scanStartedAt) {
  const seller = options.seller ? requireAddress(options.seller, "--seller") : null;
  const request = { from: options.from ?? null, to: options.to ?? null, seller };
  const sources = { antscan: options.antscanUrl ?? DEFAULT_ANTSCAN_URL, blockscout: options.blockscoutUrl ?? DEFAULT_BLOCKSCOUT_URL };
  const runtime = {
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 5,
    blockscoutConcurrency: options.blockscoutConcurrency ?? 3,
    maxAuxiliaryTransfers: options.maxAuxiliaryTransfers ?? DEFAULT_MAX_AUXILIARY_TRANSFERS,
  };
  const cacheDirectory = resolve(expandHome(options.cacheDir ?? join(homedir(), ".antseed", "forensics", "wash-trading", "cache")));
  const scanId = sha256(JSON.stringify({ schema: SCAN_SCHEMA_VERSION, scoring: SCORING_VERSION, scanStartedAt, request, sources })).slice(0, 24);
  return {
    version: SCAN_SCHEMA_VERSION,
    kind: "antseed-historical-wash-trading-manifest",
    scanId,
    scoringVersion: SCORING_VERSION,
    scanStartedAt: new Date(scanStartedAt).toISOString(),
    completedAt: null,
    status: "collecting",
    outputDirectory,
    cacheDirectory,
    request,
    sources,
    runtime,
    period: null,
    artifacts: null,
  };
}

export function validateResumeOptions(options, manifest) {
  if (manifest.version !== SCAN_SCHEMA_VERSION || manifest.scoringVersion !== SCORING_VERSION) {
    throw new Error(`Resume manifest uses incompatible schema or scoring version (${manifest.version}/${manifest.scoringVersion})`);
  }
  const checks = [
    ["from", options.from, manifest.request.from],
    ["to", options.to, manifest.request.to],
    ["seller", options.seller ? requireAddress(options.seller, "--seller") : null, manifest.request.seller],
    ["antscan-url", options.antscanUrl, manifest.sources.antscan],
    ["blockscout-url", options.blockscoutUrl, manifest.sources.blockscout],
  ];
  for (const [name, requested, stored] of checks) {
    if (requested != null && requested !== stored) throw new Error(`--${name} cannot change when resuming: requested ${requested}, stored ${stored}`);
  }
}

export function classifyScanStatus(protocolDepositsComplete, traces, firstNativeFundingComplete = true) {
  const values = [...traces];
  const incompleteTraces = values.filter((trace) => !trace.complete).length;
  const highVolumeSkippedTraces = values.filter((trace) => trace.skipped?.reason === "high_volume_address").length;
  const retryableIncompleteTraces = values.filter((trace) => !trace.complete && !trace.skipped).length;
  const status = !protocolDepositsComplete || !firstNativeFundingComplete || retryableIncompleteTraces > 0
    ? "partial"
    : highVolumeSkippedTraces > 0 ? "bounded" : "complete";
  return { status, incompleteTraces, retryableIncompleteTraces, highVolumeSkippedTraces };
}

export function filterTraceToPeriod(trace, period, maxTransfers = Number.POSITIVE_INFINITY) {
  if (trace.query?.fromTimestamp === period.from && trace.query?.toTimestamp === period.to) {
    return traceTransferCount(trace) > maxTransfers ? highVolumeTraceSummary(trace.address, period, maxTransfers) : trace;
  }
  const inPeriod = (entry) => entry.timestamp >= period.from && entry.timestamp < period.to;
  const filtered = {
    ...trace,
    inboundUsdc: (trace.inboundUsdc ?? []).filter(inPeriod),
    outboundUsdc: (trace.outboundUsdc ?? []).filter(inPeriod),
    firstNativeFunding: trace.firstNativeFunding && trace.firstNativeFunding.timestamp < period.to ? trace.firstNativeFunding : null,
    query: { ...trace.query, fromTimestamp: period.from, toTimestamp: period.to },
  };
  return traceTransferCount(filtered) > maxTransfers ? highVolumeTraceSummary(trace.address, period, maxTransfers) : filtered;
}

export async function traceArtifactExceedsPeriodLimit(path, period, maxTransfers) {
  if (!Number.isFinite(maxTransfers)) return false;
  let count = 0;
  let carry = "";
  try {
    for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
      const text = carry + chunk;
      const splitAt = Math.max(0, text.length - 64);
      count += countPeriodTimestamps(text, period, splitAt);
      if (count > maxTransfers) return true;
      carry = text.slice(splitAt);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return count + countPeriodTimestamps(carry, period) > maxTransfers;
}

async function loadTraceArtifact(path, address, period, maxTransfers = Number.POSITIVE_INFINITY) {
  if (await traceArtifactExceedsPeriodLimit(path, period, maxTransfers)) {
    return highVolumeTraceSummary(address, period, maxTransfers);
  }
  const existing = await readJson(path);
  if (existing?.complete) return filterTraceToPeriod(existing, period, maxTransfers);
  if (existing?.skipped?.reason === "high_volume_address"
    && existing.skipped.maxTransfers === maxTransfers
    && existing.query?.fromTimestamp === period.from
    && existing.query?.toTimestamp === period.to) return existing;
  return null;
}

function highVolumeTraceSummary(address, period, maxTransfers) {
  return {
    address,
    complete: false,
    inboundUsdc: [],
    outboundUsdc: [],
    firstNativeFunding: null,
    errors: [`Skipped high-volume address with more than ${maxTransfers} Base USDC transfers in the scan period`],
    skipped: { reason: "high_volume_address", maxTransfers, observedTransfers: maxTransfers + 1 },
    query: { fromTimestamp: period.from, toTimestamp: period.to, maxTransfers },
  };
}

function traceTransferCount(trace) {
  return (trace.inboundUsdc?.length ?? 0) + (trace.outboundUsdc?.length ?? 0);
}

function countPeriodTimestamps(text, period, startBefore = Number.POSITIVE_INFINITY) {
  let count = 0;
  for (const match of text.matchAll(/"timestamp"\s*:\s*(\d+)(?=[^0-9])/g)) {
    if (match.index >= startBefore) break;
    const timestamp = Number(match[1]);
    if (timestamp >= period.from && timestamp < period.to) count += 1;
  }
  return count;
}

export function parseArguments(argv) {
  const options = {};
  const valueOptions = new Map([
    ["--from", "from"], ["--to", "to"], ["--output", "output"], ["--resume", "resume"], ["--seller", "seller"],
    ["--seller-labels", "sellerLabels"],
    ["--antscan-url", "antscanUrl"], ["--blockscout-url", "blockscoutUrl"], ["--rpc-url", "rpcUrl"], ["--cache-dir", "cacheDir"],
    ["--blockscout-concurrency", "blockscoutConcurrency"], ["--request-timeout-ms", "requestTimeoutMs"], ["--max-retries", "maxRetries"],
    ["--max-auxiliary-transfers", "maxAuxiliaryTransfers"],
    ["--proof-output", "proofOutput"], ["--start-block", "startBlock"], ["--end-block-exclusive", "endBlockExclusive"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    const key = valueOptions.get(argument);
    if (!key) throw new Error(`Unknown option ${argument}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (options.output && options.resume) throw new Error("--output and --resume cannot be used together");
  for (const key of ["blockscoutConcurrency", "requestTimeoutMs", "maxRetries", "maxAuxiliaryTransfers", "startBlock", "endBlockExclusive"]) {
    if (options[key] != null) {
      const parsed = Number(options[key]);
      if (!Number.isInteger(parsed) || parsed < (key === "maxRetries" ? 0 : 1)) throw new Error(`Invalid numeric value for ${key}: ${options[key]}`);
      options[key] = parsed;
    }
  }
  if (options.from) parseIsoSeconds(options.from, "--from");
  if (options.to) parseIsoSeconds(options.to, "--to");
  if (options.seller) requireAddress(options.seller, "--seller");
  if (options.proofOutput && (options.startBlock == null || options.endBlockExclusive == null)) {
    throw new Error("--proof-output requires --start-block and --end-block-exclusive");
  }
  return options;
}

function requireAddress(value, name) {
  const address = normalizeAddress(value);
  if (!address) throw new Error(`${name} must be a 20-byte 0x-prefixed address`);
  return address;
}

function expandHome(path) {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function createProgressReporter() {
  let lastLength = 0;
  return (state) => {
    if (state.phase === "done") {
      if (process.stdout.isTTY && lastLength > 0) process.stdout.write("\n");
      return;
    }
    let message;
    if (state.total != null) {
      const width = 22;
      const share = state.total === 0 ? 1 : Math.min(1, state.completed / state.total);
      const filled = Math.round(share * width);
      message = `${state.phase} ${state.label} [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${state.completed}/${state.total}`;
    } else {
      message = `${state.phase}: ${state.label ?? state.address ?? "working"}`;
    }
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${message}${" ".repeat(Math.max(0, lastLength - message.length))}`);
      lastLength = message.length;
    } else if (state.completed == null || state.completed === state.total || state.completed % 1000 === 0) {
      console.log(message);
    }
  };
}

function helpText() {
  return `AntSeed historical usage investigation scanner

Usage:
  pnpm run wash-trading:scan
  pnpm run wash-trading:scan -- --from 2026-01-01 --to 2026-08-11
  pnpm run wash-trading:scan -- --seller 0x...
  pnpm run wash-trading:scan -- --resume ~/.antseed/forensics/wash-trading/scans/<scan>

Options:
  --from <ISO date>                 Optional start; defaults to earliest indexed activity
  --to <ISO date>                   Optional end; defaults to the frozen scan-start time
  --output <directory>              New scan output directory
  --resume <directory>              Resume a compatible scan
  --seller <address>                Limit report generation to one seller
  --seller-labels <csv>             Optional address/display_name presentation labels
  --antscan-url <url>               AntScan base URL
  --blockscout-url <url>            Base Blockscout base URL
  --rpc-url <url>                   Base JSON-RPC URL (or ANTSEED_BASE_RPC_URL)
  --cache-dir <directory>           Shared HTTP cache directory
  --blockscout-concurrency <count>  Concurrent address traces (default: 3)
  --max-auxiliary-transfers <count> Skip derived addresses above this period transfer count (default: 25000)
  --proof-output <file>             Export deterministic proof-bundle-v1.json
  --start-block <number>            Inclusive Base block bound for proof export
  --end-block-exclusive <number>    Exclusive Base block bound for proof export
  --request-timeout-ms <ms>         Per-request timeout (default: 30000)
  --max-retries <count>             Transient retry count (default: 5)
  --help                             Show this help
`;
}

const isEntrypoint = process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname);
if (isEntrypoint) {
  runWashTradingScan().catch((error) => {
    console.error(`wash-trading scan failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

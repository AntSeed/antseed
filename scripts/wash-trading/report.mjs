import { join } from "node:path";
import { ensureDirectory, writeJsonAtomic, writeTextAtomic } from "./io.mjs";
import { classifyFinalVerdict, FINAL_VERDICT_THRESHOLDS } from "./policy.mjs";

export { classifyFinalVerdict, FINAL_VERDICT_THRESHOLDS } from "./policy.mjs";

export async function writeScanArtifacts(outputDirectory, scan, sellerReports, networkAnalysis = emptyNetworkAnalysis()) {
  const assetsDirectory = join(outputDirectory, "assets");
  const sellersDirectory = join(outputDirectory, "sellers");
  const networkDirectory = join(outputDirectory, "network");
  await ensureDirectory(assetsDirectory);
  await ensureDirectory(sellersDirectory);
  await ensureDirectory(networkDirectory);

  const sorted = [...sellerReports].sort((left, right) => right.stats.volumeUsdc - left.stats.volumeUsdc);
  const volumeSummary = summarizePriorityVolumes(sorted, networkAnalysis);

  for (const seller of sorted) await writeJsonAtomic(join(sellersDirectory, `${seller.seller}.json`), seller);
  await writeJsonAtomic(join(networkDirectory, "funders.json"), networkAnalysis.fundingCohorts);
  await writeJsonAtomic(join(networkDirectory, "reciprocal-pairs.json"), networkAnalysis.reciprocalPairs);
  await writeTextAtomic(join(networkDirectory, "funders.csv"), fundersCsv(networkAnalysis.fundingCohorts, scan.generatedAt));
  await writeTextAtomic(join(networkDirectory, "reciprocal-pairs.csv"), reciprocalPairsCsv(networkAnalysis.reciprocalPairs, scan.generatedAt));

  const summary = {
    ...scan,
    volumeSummary,
    networkAnalysis: compactNetworkAnalysis(networkAnalysis),
    sellers: sorted.map((seller) => ({
      seller: seller.seller,
      displayName: seller.displayName ?? null,
      peerId: seller.peerId ?? null,
      provisional: seller.provisional,
      completeness: seller.completeness,
      stats: seller.stats,
      finalVerdict: classifySellerFinding(seller),
      strongestCohort: {
        funder: seller.strongestCohort.funder,
        buyers: seller.strongestCohort.buyers.length,
        volumeUsdc: seller.strongestCohort.volumeUsdc,
        volumeShare: seller.strongestCohort.volumeShare,
      },
      modelSales: seller.modelSales,
      evidencePath: `sellers/${seller.seller}.json`,
    })),
  };
  await writeJsonAtomic(join(outputDirectory, "scan.json"), summary);

  const reportData = {
    ...scan,
    volumeSummary,
    networkAnalysis: compactNetworkAnalysis(networkAnalysis),
    sellers: sorted.map(compactSellerForDashboard),
  };
  const serialized = JSON.stringify(reportData).replaceAll("</script", "<\\/script");
  await writeTextAtomic(join(assetsDirectory, "report-data.js"), `window.__ANTSEED_WASH_SCAN__=${serialized};\n`);
  await writeTextAtomic(join(outputDirectory, "index.html"), renderDashboardHtml());
  return {
    reportPath: join(outputDirectory, "index.html"),
    summaryPath: join(outputDirectory, "scan.json"),
    fundersPath: join(networkDirectory, "funders.csv"),
    reciprocalPairsPath: join(networkDirectory, "reciprocal-pairs.csv"),
  };
}

export function summarizePriorityVolumes(sellerReports, networkAnalysis = emptyNetworkAnalysis()) {
  const volumeMicrounits = { total: 0, P0: 0, P1: 0 };
  const findingCounts = { P0: 0, P1: 0 };
  for (const seller of sellerReports) {
    const microunits = Math.round((seller.stats?.volumeUsdc ?? 0) * 1_000_000);
    volumeMicrounits.total += microunits;
    const verdict = classifyFinalVerdict(seller);
    if (!verdict || verdict.confidence === "CONFIRMED") continue;
    const dependentVolumeUsdc = seller.dependenceAnalysis?.thresholds?.find((item) => item.threshold === 0.99)?.sellerVolumeUsdc ?? 0;
    const findingVolumeUsdc = verdict.priority === "P1" ? verdict.attributedVolumeUsdc : dependentVolumeUsdc;
    volumeMicrounits[verdict.priority] += Math.round((findingVolumeUsdc ?? 0) * 1_000_000);
    findingCounts[verdict.priority] += 1;
  }
  for (const pair of networkAnalysis.reciprocalPairs ?? []) {
    volumeMicrounits.P0 += Math.round((pair.grossVolumeUsdc ?? 0) * 1_000_000);
    findingCounts.P0 += 1;
  }
  const totalSettledVolumeUsdc = volumeMicrounits.total / 1_000_000;
  const suspectedSettledVolumeUsdc = {
    P0: volumeMicrounits.P0 / 1_000_000,
    P1: volumeMicrounits.P1 / 1_000_000,
    combinedP0P1: (volumeMicrounits.P0 + volumeMicrounits.P1) / 1_000_000,
  };
  return {
    totalSettledVolumeUsdc,
    suspectedSettledVolumeUsdc,
    findingCounts,
    caveat: "P1 attributed volume sums unique settlements from buyers in material P1 cohorts, deduplicating buyers shared by first-ETH and primary-USDC cohorts. P0 seller volume remains a near-exclusive-buyer exposure estimate, and confirmed reciprocal pairs use gross two-way volume. These figures are not definitive measurements of wash trading.",
  };
}

function compactSellerForDashboard(seller) {
  return {
    seller: seller.seller,
    displayName: seller.displayName ?? null,
    peerId: seller.peerId ?? null,
    provisional: seller.provisional,
    completeness: seller.completeness,
    stats: seller.stats,
    strongestCohort: {
      funder: seller.strongestCohort.funder,
      buyerCount: seller.strongestCohort.buyerCount ?? seller.strongestCohort.buyers.length,
      volumeUsdc: seller.strongestCohort.volumeUsdc,
      volumeShare: seller.strongestCohort.volumeShare,
    },
    fundingProvenance: {
      ...seller.fundingProvenance,
      sources: seller.fundingProvenance.sources.slice(0, 25).map((source) => ({
        ...source,
        buyerFlows: source.buyerFlows.slice(0, 100),
      })),
    },
    dependenceAnalysis: seller.dependenceAnalysis,
    sellerFundFlows: seller.sellerFundFlows,
    modelSales: seller.modelSales,
    buyers: seller.buyers.slice(0, 200).map((buyer) => ({
      buyer: buyer.buyer,
      volumeUsdc: buyer.volumeUsdc,
      sellerShare: buyer.sellerShare,
      channels: buyer.channels,
      otherSellers: buyer.otherSellers,
    })),
    externalLinks: seller.externalLinks,
    evidencePath: `sellers/${seller.seller}.json`,
    networkSignals: {
      nativeFunderCohorts: seller.networkSignals?.nativeFunderCohorts ?? [],
      reciprocalPairs: seller.networkSignals?.reciprocalPairs ?? [],
    },
    finalVerdict: classifySellerFinding(seller),
  };
}

function classifySellerFinding(seller) {
  const verdict = classifyFinalVerdict(seller);
  return verdict?.confidence === "CONFIRMED" ? null : verdict;
}


function compactNetworkAnalysis(networkAnalysis) {
  return {
    version: networkAnalysis.version,
    coverage: networkAnalysis.coverage,
    counts: {
      fundingCohorts: networkAnalysis.counts.fundingCohorts,
      reciprocalPairs: networkAnalysis.counts.reciprocalPairs,
      reciprocalWallets: networkAnalysis.counts.reciprocalWallets,
    },
    caveats: ["Shared first-ETH-funder cohorts are control evidence, not proof of common beneficial ownership; exchange, paymaster, router, and treasury infrastructure must be labeled before enforcement."],
    fundingCohorts: networkAnalysis.fundingCohorts.map((cohort) => ({
      ...cohort,
      buyers: undefined,
      topSellers: cohort.topSellers.slice(0, 10),
    })),
    reciprocalPairs: networkAnalysis.reciprocalPairs,
  };
}

function fundersCsv(cohorts, computedAt) {
  const header = ["funder", "buyers_created", "avg_sellers_per_buyer", "pct_exclusive", "cohort_volume_usdc", "shape", "top_sellers", "computed_at"];
  const rows = cohorts.map((cohort) => [
    cohort.funder,
    cohort.buyersCreated,
    cohort.averageSellersPerBuyer.toFixed(2),
    (cohort.exclusiveShare * 100).toFixed(1),
    cohort.volumeUsdc.toFixed(2),
    cohort.shape,
    cohort.topSellers.slice(0, 3).map((seller) => `${seller.displayName ?? shortAddress(seller.seller)} ($${Math.round(seller.volumeUsdc)})`).join("; "),
    computedAt,
  ]);
  return csv([header, ...rows]);
}

function reciprocalPairsCsv(pairs, computedAt) {
  const header = ["wallet_a", "wallet_b", "volume_a_to_b_usdc", "volume_b_to_a_usdc", "settlements", "reciprocity", "first_seen", "last_seen", "computed_at"];
  const rows = pairs.map((pair) => [
    pair.walletA,
    pair.walletB,
    pair.volumeAToBUsdc.toFixed(2),
    pair.volumeBToAUsdc.toFixed(2),
    pair.settlements,
    pair.reciprocity.toFixed(3),
    pair.firstAt == null ? "" : new Date(pair.firstAt * 1000).toISOString(),
    pair.lastAt == null ? "" : new Date(pair.lastAt * 1000).toISOString(),
    computedAt,
  ]);
  return csv([header, ...rows]);
}

function csv(rows) {
  return `${rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n")}\n`;
}

function shortAddress(address) {
  return `${address.slice(0, 10)}…`;
}

function emptyNetworkSignals() {
  return { nativeFunderCohorts: [], reciprocalPairs: [] };
}

function emptyNetworkAnalysis() {
  return {
    version: null,
    coverage: { positiveVolumeBuyers: 0, buyersWithFirstNativeFunding: 0, firstNativeFundingShare: null },
    counts: { fundingCohorts: 0, reciprocalPairs: 0, reciprocalWallets: 0 },
    caveats: [],
    fundingCohorts: [],
    reciprocalPairs: [],
  };
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AntSeed Historical Usage Forensics</title>
  <style>
    :root { color-scheme: dark; --bg:#07100e; --panel:#0d1916; --panel2:#12231e; --line:#244238; --text:#effaf5; --muted:#91a9a0; --green:#74f0b5; --amber:#f2c66d; --red:#ff7f78; --orange:#f49a5f; --blue:#76b7ff; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(circle at 10% -10%,#18392d 0,transparent 30%),var(--bg); color:var(--text); font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    a { color:var(--green); }
    button,input,select { font:inherit; }
    .shell { max-width:1500px; margin:0 auto; padding:28px; }
    header { display:flex; gap:24px; justify-content:space-between; align-items:flex-start; margin-bottom:22px; }
    .eyebrow { color:var(--green); text-transform:uppercase; letter-spacing:.14em; font-size:11px; font-weight:800; }
    h1 { margin:5px 0 6px; font-size:clamp(27px,4vw,46px); line-height:1.05; letter-spacing:-.04em; }
    .lede { color:var(--muted); max-width:780px; }
    .header-actions { display:flex; align-items:center; gap:10px; }
    .period { padding:10px 14px; border:1px solid var(--line); border-radius:12px; background:#0a1512; color:var(--muted); white-space:nowrap; }
    .methodology-button { border:1px solid #4b7967; background:#173329; color:var(--text); border-radius:12px; padding:10px 14px; cursor:pointer; font-weight:850; white-space:nowrap; }
    .methodology-button:hover { background:#21483a; border-color:var(--green); }
    .cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:18px 0 10px; }
    .card { background:linear-gradient(155deg,var(--panel2),var(--panel)); border:1px solid var(--line); border-radius:15px; padding:15px; box-shadow:0 10px 34px #0004; }
    .card span { color:var(--muted); font-size:12px; }
    .card strong { display:block; margin-top:5px; font-size:23px; letter-spacing:-.03em; }
    .card small { display:block; margin-top:5px; color:var(--muted); font-size:11px; }
    .overview-note { padding:0 2px; margin:0 0 18px; }
    .notice { border-left:3px solid var(--amber); background:#281f0d; padding:12px 14px; color:#f7dfaa; border-radius:5px 11px 11px 5px; margin:14px 0; }
    .network-section { margin:26px 0 34px; padding:18px; border:1px solid var(--line); border-radius:16px; background:linear-gradient(145deg,#0b1714,#10231d); }
    .network-section h2 { margin:0; font-size:21px; }
    .network-section h3 { margin:22px 0 9px; font-size:14px; color:var(--green); text-transform:uppercase; letter-spacing:.08em; }
    .network-section .cards { margin-bottom:14px; }
    .network-table tbody tr { cursor:default; }
    .signal { display:inline-flex; border-radius:999px; padding:2px 7px; background:#17352b; color:var(--green); font-size:11px; font-weight:800; }
    .signal.confirmed { background:#4a1618; color:#ffaaa5; }
    .reason-tags { display:flex; flex-wrap:wrap; gap:6px; max-width:430px; white-space:normal; }
    .reason-tag,.reason-tag.graph,.reason-tag.confirmed { display:inline-flex; align-items:center; border:1px solid #49675b; border-radius:999px; padding:3px 8px; background:#17261f; color:#d4e8df; font-size:11px; font-weight:800; cursor:help; }
    .reason-tooltip { position:fixed; z-index:50; width:min(320px,calc(100vw - 24px)); padding:10px 12px; border:1px solid #557566; border-radius:10px; background:#07100ef2; color:var(--text); box-shadow:0 14px 44px #000a; white-space:normal; pointer-events:none; font-size:12px; line-height:1.45; }
    .verdict { display:inline-flex; align-items:center; border-radius:999px; padding:4px 9px; font-size:11px; font-weight:900; letter-spacing:.05em; white-space:nowrap; }
    .verdict.CONFIRMED { background:#4a1618; color:#ffaaa5; }
    .verdict.STRONG_LEAD { background:#482512; color:#ffbc8d; }
    .verdict.REVIEW { background:#413711; color:#f5da7d; }
    .verdict.WATCH { background:#143528; color:#8beac1; }
    .results-section { margin-top:26px; }
    .results-section h2 { margin:0 0 5px; font-size:21px; }
    .results-section .lede { margin-bottom:14px; }
    .toolbar { display:grid; grid-template-columns:minmax(240px,1fr) 180px 220px 180px; gap:10px; margin:18px 0 10px; }
    .control { width:100%; background:#0a1512; color:var(--text); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
    .table-wrap { border:1px solid var(--line); border-radius:15px; overflow:auto; background:var(--panel); }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:11px 12px; text-align:left; border-bottom:1px solid #1b332b; white-space:nowrap; }
    th { position:sticky; top:0; background:#10201b; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; z-index:1; }
    tbody tr { cursor:pointer; }
    tbody tr.pair-row { cursor:default; }
    tbody tr:hover { background:#14261f; }
    .address { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .seller-name { display:block; font-size:14px; font-weight:800; }
    .muted { color:var(--muted); }
    .drawer { position:fixed; inset:0; display:none; z-index:10; }
    .drawer.open { display:block; }
    .backdrop { position:absolute; inset:0; background:#000b; backdrop-filter:blur(4px); }
    .detail { position:absolute; inset:0; width:100vw; overflow:auto; background:radial-gradient(circle at 85% -15%,#17372c 0,transparent 28%),#091411; padding:clamp(18px,3vw,42px); }
    .detail-head { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; }
    .close { border:1px solid var(--line); background:#13241e; color:var(--text); border-radius:9px; padding:8px 12px; cursor:pointer; }
    .detail h2 { margin:4px 0; font-size:27px; }
    .detail h3 { margin:25px 0 10px; font-size:16px; }
    .detail h4 { margin:18px 0 9px; font-size:13px; color:var(--green); text-transform:uppercase; letter-spacing:.08em; }
    .methodology-detail { padding-bottom:80px; }
    .methodology-content { max-width:1180px; margin:0 auto; }
    .methodology-content h2 { font-size:clamp(30px,5vw,50px); margin:5px 0 10px; }
    .methodology-content h3 { margin-top:38px; font-size:22px; }
    .methodology-content h4 { margin-top:22px; }
    .methodology-intro { max-width:900px; color:#c9dbd3; font-size:16px; }
    .methodology-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin:14px 0; }
    .method-card { border:1px solid var(--line); border-radius:14px; background:linear-gradient(145deg,#10231d,#0b1714); padding:16px; }
    .method-card h4 { margin:0 0 7px; color:var(--text); text-transform:none; letter-spacing:0; font-size:16px; }
    .method-card p { margin:6px 0; color:#c7d8d1; }
    .method-card strong { color:var(--green); }
    .method-list { margin:8px 0 0; padding-left:20px; color:#c7d8d1; }
    .method-list li { margin:6px 0; }
    .method-table th,.method-table td { white-space:normal; vertical-align:top; }
    .method-table tbody tr { cursor:default; }
    .method-table td:first-child { min-width:190px; }
    .formula { display:inline-block; border:1px solid #3e5f53; border-radius:8px; background:#08120f; padding:3px 7px; color:#dff5ec; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .method-callout { border-left:4px solid var(--green); border-radius:8px 13px 13px 8px; background:#10251e; padding:14px 16px; margin:16px 0; color:#d9ebe3; }
    .method-warning { border-left-color:var(--amber); background:#29220f; color:#f4e5ba; }
    .suspicion-banner { margin-top:16px; border:1px solid #4e6335; border-left:4px solid var(--amber); border-radius:12px; padding:14px 16px; background:linear-gradient(135deg,#29220f,#142018); }
    .suspicion-banner b { display:block; color:#ffe6a8; font-size:18px; margin-bottom:3px; }
    .suspicion-banner span { color:#d3c597; }
    .headline-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:10px; }
    .headline-card { border:1px solid var(--line); border-radius:13px; padding:14px; background:linear-gradient(145deg,#10231d,#0b1714); }
    .headline-card span { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
    .headline-card b { display:block; margin-top:4px; font-size:27px; letter-spacing:-.04em; }
    .headline-card small { display:block; margin-top:4px; color:var(--muted); }
    .evidence { display:grid; gap:8px; }
    .evidence-item { border:1px solid var(--line); border-radius:11px; padding:11px; background:#0f1d19; }
    .evidence-item b { color:var(--green); }
    .points { float:right; color:var(--amber); font-weight:800; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
    .mini { border:1px solid var(--line); border-radius:10px; padding:10px; }
    .mini span { color:var(--muted); display:block; font-size:11px; }
    .mini b { font-size:17px; }
    .funding-panel { border:1px solid var(--line); border-radius:14px; background:linear-gradient(145deg,#0b1714,#10231d); overflow:hidden; }
    .funding-summary { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border-bottom:1px solid var(--line); }
    .funding-summary .mini { border:0; border-radius:0; background:#0c1a16; }
    .funding-graph { padding:14px; overflow:auto; }
    .funding-graph svg { display:block; width:100%; min-width:720px; height:auto; }
    .funding-edge { fill:none; stroke-linecap:round; }
    .funding-edge.source { stroke:var(--green); }
    .funding-edge.usage { stroke:var(--blue); }
    .funding-node circle { stroke-width:2; transition:transform .15s ease,filter .15s ease; transform-box:fill-box; transform-origin:center; }
    .funding-node:hover circle { transform:scale(1.35); filter:drop-shadow(0 0 8px currentColor); }
    .funding-node.source circle { fill:#123c2d; stroke:var(--green); color:var(--green); }
    .funding-node.buyer circle { fill:#132a3c; stroke:var(--blue); color:var(--blue); }
    .funding-node.seller circle { fill:#4b2414; stroke:var(--orange); color:var(--orange); }
    .funding-node text { fill:var(--text); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; pointer-events:none; }
    .graph-legend { display:flex; gap:16px; flex-wrap:wrap; padding:0 14px 14px; color:var(--muted); font-size:12px; }
    .legend-line { display:inline-block; width:22px; height:3px; border-radius:4px; margin-right:6px; vertical-align:middle; }
    .legend-line.source { background:var(--green); }
    .legend-line.usage { background:var(--blue); }
    .loop-panel { border:1px solid var(--line); border-radius:14px; background:#0c1a16; padding:14px; margin:12px 0; overflow:auto; }
    .sequence-group { border:1px solid var(--line); border-radius:14px; background:#091612; padding:14px; margin:12px 0; }
    .sequence-group > h4 { margin:0 0 3px; }
    .sequence-group > .loop-panel { margin:12px 0 0; background:#0c1a16; }
    .loop-panel svg { display:block; width:100%; min-width:920px; height:auto; }
    .loop-edge { fill:none; stroke-linecap:round; stroke-width:2.5; }
    .loop-edge.payment { stroke:var(--orange); }
    .loop-edge.deposit { stroke:var(--green); }
    .loop-edge.usage { stroke:var(--blue); }
    .loop-node circle { stroke-width:2; }
    .loop-node.seller circle { fill:#4b2414; stroke:var(--orange); }
    .loop-node.buyer circle { fill:#132a3c; stroke:var(--blue); }
    .loop-node.deposit circle { fill:#123c2d; stroke:var(--green); }
    .loop-node text { fill:var(--text); font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .analysis-note { color:var(--muted); padding:0 14px 14px; font-size:12px; }
    .chart-grid { display:grid; grid-template-columns:1.15fr .85fr; gap:12px; margin:12px 0; }
    .chart-card { border:1px solid var(--line); border-radius:14px; background:#0c1a16; padding:14px; overflow:auto; }
    .chart-card h4 { margin:0 0 3px; }
    .chart-subtitle { color:var(--muted); font-size:12px; margin-bottom:10px; }
    .chart-card svg { width:100%; min-width:560px; height:auto; display:block; }
    .axis { stroke:#426458; stroke-width:1; }
    .gridline { stroke:#1c362e; stroke-width:1; }
    .axis-label { fill:var(--muted); font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .chart-label { fill:var(--text); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .wave-mark { fill:#75baff; fill-opacity:.8; stroke:#b9dcff; stroke-width:1; }
    .dependence-bar { fill:url(#dependenceGradient); }
    .dependence-area { fill:url(#dependenceAreaGradient); opacity:.28; }
    .dependence-line { fill:none; stroke:#75baff; stroke-width:3; stroke-linejoin:round; }
    .threshold-line { stroke:var(--amber); stroke-width:1.5; stroke-dasharray:5 5; }
    .threshold-point { fill:var(--amber); stroke:#fff3c4; stroke-width:1.5; }
    .flow-table .affiliated { color:var(--amber); font-weight:800; }
    .links { display:flex; flex-wrap:wrap; gap:12px; }
    .empty { padding:30px; color:var(--muted); text-align:center; }
    @media (max-width:950px) { .cards{grid-template-columns:repeat(2,1fr)} .toolbar{grid-template-columns:1fr 1fr} .headline-grid{grid-template-columns:1fr} .chart-grid,.methodology-grid{grid-template-columns:1fr} .header-actions{flex-direction:column;align-items:stretch} }
    @media (max-width:600px) { .shell{padding:16px} header{display:block}.header-actions{margin-top:14px}.period{white-space:normal}.cards,.stats,.funding-summary{grid-template-columns:1fr 1fr}.toolbar{grid-template-columns:1fr}.detail{padding:18px} }
  </style>
</head>
<body>
  <main class="shell">
    <header><div><div class="eyebrow">AntSeed network forensics</div><h1>Historical usage investigation</h1><div class="lede">Evidence-based coordination screening. A finding is an investigation lead unless the report explicitly marks a reciprocal settlement loop as confirmed.</div></div><div class="header-actions"><button id="methodology-open" class="methodology-button" type="button">How detection works</button><div id="period" class="period"></div></div></header>
    <section id="cards" class="cards"></section>
    <div id="volume-note" class="analysis-note overview-note"></div>
    <div id="notice" class="notice" hidden></div>
    <section class="results-section">
      <h2>Final P0–P1 verdicts</h2>
      <div class="lede">One actionable list sorted by flagged volume, highest first. P1 rows use unique settlements from buyers in the material first-ETH and primary-USDC cohorts, with overlapping buyers counted once. P0 seller rows retain the near-exclusive-buyer exposure measure, while reciprocal loops use confirmed gross two-way pair volume. Shared-funder control evidence is material only with at least 3 buyers, $1,000 settled volume, and 50% of seller volume.</div>
      <section class="toolbar" aria-label="Verdict filters">
        <input id="search" class="control" type="search" placeholder="Search seller, address, or funder">
        <select id="verdict" class="control"><option value="ALL">All P0–P1 findings</option><option value="P0">P0 only</option><option value="P1">P1 only</option></select>
        <select id="evidence" class="control"><option value="ALL">All evidence types</option></select>
        <select id="completeness" class="control"><option value="ALL">Any completeness</option><option value="complete">Complete</option><option value="partial">Partial</option><option value="unavailable">Unavailable</option></select>
      </section>
      <div class="table-wrap"><table><thead><tr><th>Seller / verdict / why flagged</th><th>Flagged / total volume</th><th>Buyers</th><th>Channels</th><th>Attributed cohort</th><th>Reciprocity</th><th>Data</th></tr></thead><tbody id="rows"></tbody></table><div id="empty" class="empty" hidden>No findings match these filters.</div></div>
      <div class="analysis-note"><b>P0</b> is decisive circular-money evidence. <b>P1</b> is strong evidence that one source controls a material buyer cohort. Reciprocity is how evenly a confirmed pair’s settled volume flows in both directions; 100% means both directions are equal.</div>
    </section>
    <section id="network-section" class="network-section" hidden>
      <h2>Supporting network evidence</h2>
      <div class="lede">This table shows the shared first-ETH-funder cohorts used by the P1 control rule.</div>
      <h3>First native-funder cohorts</h3>
      <div class="table-wrap network-table"><table><thead><tr><th>Funder</th><th>Buyers created</th><th>Avg sellers / buyer</th><th>Exclusive</th><th>Cohort volume</th><th>Top sellers</th><th>Shape</th></tr></thead><tbody id="funder-rows"></tbody></table></div>
      <div id="network-note" class="analysis-note"></div>
    </section>
  </main>
  <div id="reason-tooltip" class="reason-tooltip" role="tooltip" hidden></div>
  <section id="drawer" class="drawer" aria-hidden="true"><div id="backdrop" class="backdrop"></div><article id="detail" class="detail"></article></section>
  <section id="methodology" class="drawer" aria-hidden="true">
    <div id="methodology-backdrop" class="backdrop"></div>
    <article class="detail methodology-detail">
      <div class="methodology-content">
        <div class="detail-head"><div><div class="eyebrow">Deterministic methodology</div><h2>How this report detects suspected wash trading</h2><p class="methodology-intro">The report looks for public money-flow and usage patterns consistent with one operator controlling both sides of AntSeed activity. It does not attempt to decide whether inference occurred. Seller names, branding, model names, and reputation never affect a verdict.</p></div><button id="methodology-close" class="close" type="button">Close</button></div>

        <div class="method-callout"><strong>Core question:</strong> does public Base money flow show circular payments or a material buyer cohort controlled by one funding source?</div>

        <h3>Minimal P0–P1 verdicts</h3>
        <div class="methodology-grid">
          <div class="method-card"><h4><span class="verdict CONFIRMED">P0 · CONFIRMED</span> Reciprocal settlement loop</h4><p>Two wallets bought from one another in both directions, with at least <strong>100 combined settlements</strong> and at least <strong>80% volume reciprocity</strong>.</p><p><span class="formula">reciprocity = smaller direction ÷ larger direction</span></p></div>
          <div class="method-card"><h4><span class="verdict STRONG_LEAD">P0 · STRONG LEAD</span> Closed money loop</h4><p>A material shared primary-USDC-funder cohort is present and direct seller–funder, seller–buyer, or repeated relay evidence closes the money loop.</p></div>
          <div class="method-card"><h4><span class="verdict STRONG_LEAD">P1 · STRONG LEAD</span> Coordinated buyer control</h4><p>A shared first-ETH-funder or shared primary-USDC-funder cohort reaches at least <strong>3 buyers</strong>, <strong>$1,000 settled volume</strong>, and <strong>50% of seller volume</strong>.</p></div>
        </div>
        <div class="method-callout method-warning"><strong>Priority:</strong> P0 reciprocal → P0 closed money loop → P1 coordinated buyer control. No other pattern creates a verdict.</div>

        <h3>P0–P1 reason labels</h3>
        <div class="table-wrap method-table"><table><thead><tr><th>Label</th><th>Exact implemented rule</th><th>Role</th></tr></thead><tbody>
          <tr><td><span class="reason-tag">Reciprocal payments</span></td><td>Both payment directions exist with at least 100 combined settlements and at least 80% reciprocity.</td><td>P0 decisive evidence</td></tr>
          <tr><td><span class="reason-tag">Seller–funder money link</span></td><td>Positive-value, non-protocol USDC transfers directly connect the seller and the material primary-USDC-funder cohort.</td><td>P0 when combined with material P1 control</td></tr>
          <tr><td><span class="reason-tag">Seller–buyer money link</span></td><td>Positive-value, non-protocol USDC transfers directly connect the seller and buyers in the material primary-USDC-funder cohort.</td><td>P0 when combined with material P1 control</td></tr>
          <tr><td><span class="reason-tag">Money returns through relays</span></td><td>At least 3 repeated seller-payout paths forward matching value through recipients and intermediaries to the material cohort funder.</td><td>P0 when combined with material P1 control</td></tr>
          <tr><td><span class="reason-tag">Shared first ETH funder</span></td><td>The buyers’ first observed Base native-ETH funding came from the same address, and the seller-level exposure reaches 3 buyers, $1,000, and 50% of seller volume.</td><td>P1 strong-control evidence</td></tr>
          <tr><td><span class="reason-tag">Shared primary USDC funder</span></td><td>The same address was the largest observed USDC funding source for at least 3 buyers, counting direct transfers and attributed protocol deposits, and the cohort reaches $1,000 and 50% of seller volume.</td><td>P1 strong-control evidence</td></tr>
        </tbody></table></div>

        <h3>How volume is calculated</h3>
        <div class="methodology-grid">
          <div class="method-card"><h4>P1 seller rows</h4><p><strong>Attributed volume</strong> is the unique settled volume from buyers belonging to material first-ETH-funder or primary-USDC-funder cohorts. If a buyer belongs to both cohorts, that buyer’s settlements are counted once. <strong>Total volume</strong> is all settled volume attributed to the seller in the scan period.</p></div>
          <div class="method-card"><h4>P0 seller rows</h4><p><strong>Suspected volume</strong> remains settled volume from buyers that routed at least 99% of their observed AntSeed spend to that seller. The P0 verdict additionally requires a material primary-USDC cohort and a qualifying seller money-flow link.</p></div>
          <div class="method-card"><h4>Reciprocal-pair rows</h4><p><strong>Suspected volume</strong> is gross settled volume in both directions. <strong>Total volume</strong> is the two wallets’ combined seller volume. Findings are sorted by suspected volume descending.</p></div>
        </div>
        <div class="method-callout method-warning">P1 attribution identifies settlements made by the coordinated cohort; it does not prove that every attributed settlement was wash traded. P0 seller exposure and reciprocal-pair gross volume follow their separate definitions above.</div>

        <h3>Scope and limitations</h3>
        <ul class="method-list">
          <li>The analysis uses deterministic Base settlement, USDC-transfer, native-funding, channel, and request metadata. No language model assigns verdicts.</li>
          <li>It detects economic coordination, not whether useful inference happened.</li>
          <li>Names and imported seller labels are presentation-only and never affect scoring.</li>
          <li>Missing external traces are never treated as proof that a link does not exist. Incomplete funding evidence can hide a P0 or P1 connection.</li>
          <li>High-volume exchange and router infrastructure above the configured auxiliary-transfer cap is skipped to avoid tracing broad shared infrastructure as if it were a personal wallet.</li>
          <li>Sequence and amount matches do not prove that identical fungible USDC units returned to a seller.</li>
        </ul>
      </div>
    </article>
  </section>
  <script src="./assets/report-data.js"></script>
  <script>
    const scan=window.__ANTSEED_WASH_SCAN__;
    const els={period:document.getElementById('period'),cards:document.getElementById('cards'),volumeNote:document.getElementById('volume-note'),notice:document.getElementById('notice'),networkSection:document.getElementById('network-section'),funderRows:document.getElementById('funder-rows'),networkNote:document.getElementById('network-note'),search:document.getElementById('search'),verdict:document.getElementById('verdict'),evidence:document.getElementById('evidence'),completeness:document.getElementById('completeness'),rows:document.getElementById('rows'),empty:document.getElementById('empty'),reasonTooltip:document.getElementById('reason-tooltip'),drawer:document.getElementById('drawer'),detail:document.getElementById('detail'),backdrop:document.getElementById('backdrop'),methodology:document.getElementById('methodology'),methodologyOpen:document.getElementById('methodology-open'),methodologyClose:document.getElementById('methodology-close'),methodologyBackdrop:document.getElementById('methodology-backdrop')};
    const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const short=value=>value?value.slice(0,8)+'…'+value.slice(-4):'—';
    const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:value>=1000?0:2}).format(value||0);
    const pct=value=>((value||0)*100).toFixed(1)+'%';
    const date=value=>value?new Date(value*1000).toISOString().slice(0,10):'—';
    const sellerName=seller=>seller.displayName||'Unlabelled seller';
    const verdictBadge=verdict=>'<span class="verdict '+verdict.confidence+'">'+esc(verdict.priority+' · '+verdict.confidence.replaceAll('_',' '))+'</span>';
    els.period.textContent=(scan.period.allHistory?'All indexed history: ':'Selected history: ')+scan.period.fromIso.slice(0,10)+' – '+scan.period.toIso.slice(0,10)+' UTC';
    const volumeSummary=scan.volumeSummary;
    const totalVolume=volumeSummary.totalSettledVolumeUsdc;
    if(scan.status==='partial'){els.notice.hidden=false;els.notice.textContent='External funding data is incomplete. Missing evidence was not scored as absent; resume this scan to fill the remaining traces.'}
    if(scan.status==='bounded'){els.notice.hidden=false;els.notice.textContent='High-volume exchange or router infrastructure exceeded the auxiliary transfer cap and was intentionally skipped. Missing evidence was not scored as absent.'}
    const network=scan.networkAnalysis;
    if(network?.version){
      els.networkSection.hidden=false;
      els.funderRows.innerHTML=network.fundingCohorts.map(cohort=>'<tr><td class="address"><a href="https://base.blockscout.com/address/'+cohort.funder+'" target="_blank">'+short(cohort.funder)+'</a></td><td>'+cohort.buyersCreated+'</td><td>'+cohort.averageSellersPerBuyer.toFixed(2)+'</td><td>'+pct(cohort.exclusiveShare)+'</td><td>'+money(cohort.volumeUsdc)+'</td><td>'+cohort.topSellers.slice(0,3).map(seller=>'<a href="https://antscan.co/account/'+seller.seller+'" target="_blank">'+esc(seller.displayName||short(seller.seller))+'</a> ('+money(seller.volumeUsdc)+')').join(', ')+'</td><td><span class="signal">'+esc(cohort.shape)+'</span></td></tr>').join('');
      els.networkNote.textContent='Native funding coverage: '+network.coverage.buyersWithFirstNativeFunding+' / '+network.coverage.positiveVolumeBuyers+' positive-volume buyers ('+pct(network.coverage.firstNativeFundingShare)+'). '+network.caveats.join(' ');
    }
    const sellersByAddress=new Map(scan.sellers.map(s=>[s.seller,s]));
    const finalSellers=scan.sellers.filter(s=>s.finalVerdict&&s.finalVerdict.confidence!=='CONFIRMED');
    const reciprocalVerdict={confidence:'CONFIRMED',label:'Confirmed reciprocal loop',rank:4,priority:'P0',evidence:[]};
    const finalFindings=[...finalSellers.map(s=>{const at99=s.dependenceAnalysis?.thresholds?.find(item=>item.threshold===0.99);const suspectedVolumeUsdc=s.finalVerdict.priority==='P1'?(s.finalVerdict.attributedVolumeUsdc||0):(at99?.sellerVolumeUsdc||0);const totalVolumeUsdc=s.stats.volumeUsdc||0;return {kind:'seller',suspectedVolumeUsdc,totalVolumeUsdc,suspectedShare:totalVolumeUsdc?suspectedVolumeUsdc/totalVolumeUsdc:0,verdict:s.finalVerdict,seller:s}}),...(network?.reciprocalPairs||[]).map(pair=>{const totalVolumeUsdc=(sellersByAddress.get(pair.walletA)?.stats.volumeUsdc||0)+(sellersByAddress.get(pair.walletB)?.stats.volumeUsdc||0);return {kind:'pair',suspectedVolumeUsdc:pair.grossVolumeUsdc,totalVolumeUsdc,suspectedShare:totalVolumeUsdc?pair.grossVolumeUsdc/totalVolumeUsdc:0,verdict:reciprocalVerdict,pair}})].sort((a,b)=>b.suspectedVolumeUsdc-a.suspectedVolumeUsdc||b.totalVolumeUsdc-a.totalVolumeUsdc||b.verdict.rank-a.verdict.rank);
    const priorityVolumes=volumeSummary.suspectedSettledVolumeUsdc;
    const priorityCounts=volumeSummary.findingCounts;
    const combinedPriorityCount=priorityCounts.P0+priorityCounts.P1;
    const volumeCards=[
      ['Total settled volume',money(totalVolume),scan.sellers.length+' sellers screened'],
      ['P0 suspected volume',money(priorityVolumes.P0),priorityCounts.P0+' finding'+(priorityCounts.P0===1?'':'s')+' · '+pct(totalVolume?priorityVolumes.P0/totalVolume:0)+' of total'],
      ['P1 attributed volume',money(priorityVolumes.P1),priorityCounts.P1+' finding'+(priorityCounts.P1===1?'':'s')+' · '+pct(totalVolume?priorityVolumes.P1/totalVolume:0)+' of total'],
      ['Combined P0–P1 flagged volume',money(priorityVolumes.combinedP0P1),combinedPriorityCount+' finding'+(combinedPriorityCount===1?'':'s')+' · '+pct(totalVolume?priorityVolumes.combinedP0P1/totalVolume:0)+' of total'],
    ];
    els.cards.innerHTML=volumeCards.map(([label,value,note])=>'<div class="card"><span>'+label+'</span><strong>'+value+'</strong><small>'+note+'</small></div>').join('');
    els.volumeNote.textContent=volumeSummary.caveat;
    function findingEvidenceCodes(finding){if(finding.kind==='pair')return['settlement_reciprocity'];const codes=[];if(finding.verdict.nativeExposure?.material)codes.push('shared_first_eth_funder');if(finding.verdict.primaryUsdcExposure?.material)codes.push('common_funder_concentration');for(const code of finding.verdict.moneyLinkCodes||[])codes.push(code);return codes}
    const evidenceLabels={settlement_reciprocity:'Reciprocal payments',shared_first_eth_funder:'Shared first ETH funder',common_funder_concentration:'Shared primary USDC funder',seller_funder_transfer_link:'Seller–funder money link',buyer_seller_return_flow:'Seller–buyer money link',seller_funder_relay_path:'Money returns through relays'};
    const codes=[...new Set(finalFindings.flatMap(finding=>findingEvidenceCodes(finding)))];
    els.evidence.insertAdjacentHTML('beforeend',codes.map(code=>'<option value="'+esc(code)+'">'+esc(evidenceLabels[code])+'</option>').join(''));
    function filtered(){const q=els.search.value.trim().toLowerCase();return finalFindings.filter(finding=>{const verdict=els.verdict.value==='ALL'||finding.verdict.priority===els.verdict.value;const evidence=els.evidence.value==='ALL'||findingEvidenceCodes(finding).includes(els.evidence.value);if(finding.kind==='pair'){const pair=finding.pair;const complete=els.completeness.value==='ALL'||els.completeness.value==='complete';const text=[pair.walletAName,pair.walletA,pair.walletBName,pair.walletB,'reciprocal loop pair','settlement reciprocity'].join(' ').toLowerCase();return verdict&&evidence&&complete&&(!q||text.includes(q))}const s=finding.seller;const complete=els.completeness.value==='ALL'||s.completeness.status===els.completeness.value;const text=[s.displayName,s.seller,s.strongestCohort?.funder,s.finalVerdict.label,...s.finalVerdict.evidence,...findingEvidenceCodes(finding).map(code=>evidenceLabels[code])].join(' ').toLowerCase();return verdict&&evidence&&complete&&(!q||text.includes(q))})}
    const reasonCopy={shared_first_eth_funder:['Shared first ETH funder','A material group of this seller’s buyers received its first observed Base ETH from the same source.'],common_funder_concentration:['Shared primary USDC funder','The same wallet was the largest observed USDC funding source for a material group of this seller’s buyers.'],seller_funder_transfer_link:['Seller–funder money link','Direct non-protocol USDC transfers connect the seller with the wallet funding its material buyer cohort.'],buyer_seller_return_flow:['Seller–buyer money link','Direct non-protocol USDC transfers connect the seller with buyers in its material shared-funder cohort.'],seller_funder_relay_path:['Money returns through relays','Repeated seller payouts travelled through intermediary wallets toward the material buyer cohort’s funder.']};
    function reasonTag(label,description,tone=''){return '<span class="reason-tag '+tone+'" tabindex="0" data-reason="'+esc(description)+'" aria-label="'+esc(label+': '+description)+'">'+esc(label)+'</span>'}
    function sellerReasonTags(finding){const tags=findingEvidenceCodes(finding).map(code=>{const copy=reasonCopy[code];return reasonTag(copy[0],copy[1],finding.verdict.priority==='P0'?'confirmed':'graph')});return '<div class="reason-tags">'+tags.join('')+'</div>'}
    function volumeComparison(finding){const basis=finding.kind==='pair'?'confirmed pair gross / combined seller volume':finding.verdict.priority==='P1'?'material P1 cohort settlements / total seller volume':'≥99% seller-dependent / total seller volume';return '<b>'+money(finding.suspectedVolumeUsdc)+' / '+money(finding.totalVolumeUsdc)+'</b><br><span class="signal">'+pct(finding.suspectedShare)+'</span><br><span class="muted">'+basis+'</span>'}
    function renderRows(){const findings=filtered();els.empty.hidden=findings.length>0;els.rows.innerHTML=findings.map(finding=>{if(finding.kind==='pair'){const pair=finding.pair;const pairName=pair.walletAName||pair.walletBName?[pair.walletAName||short(pair.walletA),pair.walletBName||short(pair.walletB)].join(' ↔ '):'Reciprocal loop wallet pair';return '<tr class="pair-row"><td><span class="seller-name">'+esc(pairName)+'</span><span class="address"><a href="https://base.blockscout.com/address/'+pair.walletA+'" target="_blank">'+short(pair.walletA)+'</a> ↔ <a href="https://base.blockscout.com/address/'+pair.walletB+'" target="_blank">'+short(pair.walletB)+'</a></span><br>'+verdictBadge(finding.verdict)+'<div class="reason-tags">'+reasonTag('Reciprocal payments','These two wallets repeatedly paid each other in both directions at nearly the same total volume.','confirmed')+'</div></td><td>'+volumeComparison(finding)+'</td><td>—</td><td>—</td><td>—</td><td><span title="How evenly the settled volume flows in both directions.">'+pct(pair.reciprocity)+' balanced both ways</span></td><td>complete · settlement graph</td></tr>'}const s=finding.seller;const primaryBuyerCount=s.strongestCohort.buyerCount??s.strongestCohort.buyers?.length??0;const p1Sources=[s.finalVerdict.nativeExposure?.material?s.finalVerdict.nativeExposure.cohorts+' ETH '+(s.finalVerdict.nativeExposure.cohorts===1?'cohort':'cohorts'):null,s.finalVerdict.primaryUsdcExposure?.material?'USDC '+short(s.finalVerdict.primaryUsdcExposure.funder):null].filter(Boolean).join(' + ');const cohort=s.finalVerdict.priority==='P1'?s.finalVerdict.attributedBuyerCount+' buyers · '+pct(finding.suspectedShare)+' · '+p1Sources:primaryBuyerCount?primaryBuyerCount+' buyers · '+pct(s.strongestCohort.volumeShare)+(s.strongestCohort.funder?' · '+short(s.strongestCohort.funder):''):'—';return '<tr data-seller="'+s.seller+'"><td><span class="seller-name">'+esc(sellerName(s))+'</span><span class="address">'+short(s.seller)+'</span><br>'+verdictBadge(s.finalVerdict)+sellerReasonTags(finding)+'</td><td>'+volumeComparison(finding)+'</td><td>'+s.stats.buyers+'</td><td>'+s.stats.channels+'</td><td>'+cohort+'</td><td><span class="muted">—</span></td><td>'+esc(s.completeness.status)+(s.provisional?' · provisional':'')+'</td></tr>'}).join('');for(const tag of els.rows.querySelectorAll('.reason-tag'))tag.addEventListener('click',event=>event.stopPropagation());for(const row of els.rows.querySelectorAll('tr[data-seller]'))row.addEventListener('click',()=>openSeller(row.dataset.seller))}
    function showReasonTooltip(tag){els.reasonTooltip.textContent=tag.dataset.reason;els.reasonTooltip.hidden=false;const rect=tag.getBoundingClientRect();const tooltipRect=els.reasonTooltip.getBoundingClientRect();const left=Math.max(12,Math.min(rect.left,window.innerWidth-tooltipRect.width-12));let top=rect.bottom+8;if(top+tooltipRect.height>window.innerHeight-12)top=Math.max(12,rect.top-tooltipRect.height-8);els.reasonTooltip.style.left=left+'px';els.reasonTooltip.style.top=top+'px'}
    function hideReasonTooltip(){els.reasonTooltip.hidden=true}
    function openSeller(address,updateHistory=true){const s=scan.sellers.find(item=>item.seller===address);if(!s)return;if(updateHistory)history.pushState({antseedSeller:true},'','#seller='+encodeURIComponent(address));els.drawer.classList.add('open');els.drawer.setAttribute('aria-hidden','false');const c=s.strongestCohort;els.detail.innerHTML='<div class="detail-head"><div><div>'+verdictBadge(s.finalVerdict)+'</div><h2>'+esc(sellerName(s))+'</h2><div class="address">'+s.seller+'</div></div><button class="close" id="close">Close</button></div>'+(s.provisional?'<div class="notice">Provisional: external funding evidence is incomplete, so a P0 or P1 connection may be missing.</div>':'')+suspicionHeadline(s)+networkSignalSection(s)+'<h3>Seller activity</h3><div class="stats">'+[['Settled volume',money(s.stats.volumeUsdc)],['Channels',s.stats.channels],['Requests',s.stats.requests],['First activity',date(s.stats.firstActivityAt)],['Last activity',date(s.stats.lastActivityAt)]].map(([a,b])=>'<div class="mini"><span>'+a+'</span><b>'+b+'</b></div>').join('')+'</div><h3>Models sold and realized pricing</h3>'+modelSalesTable(s)+'<h3>Buyer funding control</h3>'+fundingOriginSection(s)+'<h3>Seller money-flow links</h3>'+sellerFlowSection(s)+'<h3>Evidence links</h3><div class="links"><a href="'+s.externalLinks.antscan+'" target="_blank">AntScan seller</a><a href="'+s.externalLinks.blockscout+'" target="_blank">Blockscout seller</a><a href="./'+s.evidencePath+'" target="_blank">Raw seller evidence</a></div>';document.getElementById('close').addEventListener('click',closeSeller)}
    function networkSignalSection(s){const signals=s.networkSignals||{};const rows=[];for(const pair of signals.reciprocalPairs||[]){const other=pair.walletA===s.seller?pair.walletB:pair.walletA;rows.push('<div class="evidence-item"><span class="points">P0</span><b>Reciprocal payments</b><div>'+pair.settlements.toLocaleString()+' settlements at '+pct(pair.reciprocity)+' balance with <span class="address">'+short(other)+'</span> · '+money(pair.grossVolumeUsdc)+' gross</div></div>')}if(s.finalVerdict.nativeExposure?.material){for(const cohort of signals.nativeFunderCohorts||[]){rows.push('<div class="evidence-item"><span class="points">P1</span><b>Shared first ETH funder</b><div>'+cohort.cohortBuyers+' buyers · '+money(cohort.volumeUsdc)+' settled volume from <span class="address">'+short(cohort.funder)+'</span></div></div>')}}return rows.length?'<h3>P0–P1 graph evidence</h3><div class="evidence">'+rows.join('')+'</div>':''}
    function suspicionHeadline(s){if(s.finalVerdict.priority==='P1'){const attributedVolume=s.finalVerdict.attributedVolumeUsdc||0;const attributedBuyers=s.finalVerdict.attributedBuyerCount||0;const volumeShare=s.stats.volumeUsdc?attributedVolume/s.stats.volumeUsdc:0;const buyerShare=s.stats.buyers?attributedBuyers/s.stats.buyers:0;return'<div class="headline-grid"><div class="headline-card"><span>P1 attributed volume share</span><b>'+pct(volumeShare)+'</b><small>Share of seller volume settled by buyers in material P1 funding cohorts</small></div><div class="headline-card"><span>P1 attributed volume</span><b>'+money(attributedVolume)+'</b><small>Unique cohort-buyer settlements; overlapping ETH and USDC cohorts count once</small></div><div class="headline-card"><span>Attributed cohort buyers</span><b>'+attributedBuyers+' / '+s.stats.buyers+'</b><small>'+pct(buyerShare)+' of buyers belong to a material P1 funding cohort</small></div></div>'}const at99=s.dependenceAnalysis?.thresholds?.find(item=>item.threshold===0.99);if(!at99)return'<div class="notice">No ≥99% seller-dependence evidence is available for this seller.</div>';const buyerPct=s.stats.buyers?at99.buyerCount/s.stats.buyers:0;return'<div class="headline-grid"><div class="headline-card"><span>Suspected seller-dependent volume share</span><b>'+pct(at99.sellerVolumeShare)+'</b><small>Share of this seller’s volume from buyers routing ≥99% of observed AntSeed spend here</small></div><div class="headline-card"><span>Suspected coordinated / wash-trading volume</span><b>'+money(at99.sellerVolumeUsdc)+'</b><small>Dependence-based estimate; not a definitive measurement of wash trading</small></div><div class="headline-card"><span>Suspected near-exclusive buyers</span><b>'+at99.buyerCount+' / '+s.stats.buyers+'</b><small>'+pct(buyerPct)+' of buyers route ≥99% of observed AntSeed spend to this seller</small></div></div>'}
    function modelSalesTable(seller){const rows=seller.modelSales||[];if(!rows.length)return'<div class="muted">No service-level settlement metadata was available for this seller in the selected period.</div>';const serviceVolume=rows.reduce((sum,row)=>sum+row.volumeUsdc,0);const serviceRequests=rows.reduce((sum,row)=>sum+row.requests,0);const volumeCoverage=seller.stats.volumeUsdc?serviceVolume/seller.stats.volumeUsdc:null;const requestCoverage=seller.stats.requests?serviceRequests/seller.stats.requests:null;const revenueValue=money(serviceVolume)+' of '+money(seller.stats.volumeUsdc)+' ('+(volumeCoverage==null?'—':pct(volumeCoverage))+')';const requestValue=number(serviceRequests)+' of '+number(seller.stats.requests)+' ('+(requestCoverage==null?'—':pct(requestCoverage))+')';return'<div class="stats" style="margin-bottom:10px">'+[['Model-attributed settled revenue',revenueValue],['Model-attributed requests',requestValue]].map(([label,value])=>'<div class="mini"><span>'+label+'</span><b>'+value+'</b></div>').join('')+'</div><div class="analysis-note" style="margin-bottom:10px">These are data-coverage figures, not performance scores. Older settlement records do not always contain a service/model ID. They remain included in total seller revenue and requests, but cannot be assigned to a named model.</div><div class="table-wrap"><table><thead><tr><th>Model</th><th>Settled revenue</th><th>Requests</th><th>Buyers</th><th>Input tokens</th><th>Cached input</th><th>Output tokens</th><th>Realized $/request</th><th>Realized $/1M recorded tokens</th><th>Current advertised input / output</th></tr></thead><tbody>'+rows.map(row=>'<tr><td>'+(row.model?esc(row.model):'<span class="address">'+short(row.serviceId)+'</span>')+'</td><td>'+money(row.volumeUsdc)+'</td><td>'+number(row.requests)+'</td><td>'+number(row.buyers)+'</td><td>'+number(row.inputTokens)+'</td><td>'+number(row.cachedInputTokens)+'</td><td>'+number(row.outputTokens)+'</td><td>'+requestPrice(row.realizedUsdPerRequest)+'</td><td>'+price(row.realizedUsdPerMillionTotalTokens)+'</td><td>'+(row.advertisedInputUsdPerMillion==null||row.advertisedOutputUsdPerMillion==null?'—':price(row.advertisedInputUsdPerMillion)+' / '+price(row.advertisedOutputUsdPerMillion))+'</td></tr>').join('')+'</tbody></table></div><div class="analysis-note">Realized prices are historical settled USDC divided by recorded requests or all recorded input, cached-input, and output tokens. Advertised input/output rates come from the discovery snapshot at scan time and may not match earlier offers.</div>'}
    function fundingOriginSection(s){const provenance=s.fundingProvenance||{};const sources=provenance.sources||[];const dominant=sources.find(source=>source.funder===s.strongestCohort.funder)||sources[0];if(!dominant)return'<div class="muted">No direct on-chain funding source was resolved for these buyers.</div>';return'<div class="funding-panel"><div class="funding-summary">'+[['Primary sources',provenance.sourceCount||sources.length],['Shared-source buyers',(provenance.sharedSourceBuyers||0)+' / '+(provenance.fundedBuyers||0)],['Dominant source cohort',dominant.buyerCount+' buyers'],['Seller volume represented',pct(dominant.sellerVolumeShare)]].map(([label,value])=>'<div class="mini"><span>'+label+'</span><b>'+value+'</b></div>').join('')+'</div><div class="funding-graph">'+fundingGraph(s,dominant)+'</div><div class="graph-legend"><span><i class="legend-line source"></i>Observed funding</span><span><i class="legend-line usage"></i>Settled usage with seller</span></div><div class="analysis-note">The source node is the direct on-chain sender of buyer funding. A shared source supports P1 only when the materiality thresholds are met.</div></div><h4>Buyer funding</h4>'+buyerFundingTable(s)}
    function fundingGraph(s,source){const flows=(source.buyerFlows||[]).slice(0,42);if(!flows.length)return'<div class="muted">No buyer-level funding flows available.</div>';const width=900;const columns=Math.min(7,flows.length);const rows=Math.ceil(flows.length/columns);const height=Math.max(360,220+rows*54);const sourceX=width/2;const sourceY=46;const sellerX=width/2;const sellerY=height-46;const maxFunding=Math.max(...flows.map(flow=>flow.amountUsdc||0),1);const maxUsage=Math.max(...flows.map(flow=>flow.sellerVolumeUsdc||0),1);const points=flows.map((flow,index)=>({flow,x:90+(index%columns)*(720/Math.max(1,columns-1)),y:132+Math.floor(index/columns)*54}));const sourceEdges=points.map(point=>'<path class="funding-edge source" opacity="'+(0.2+0.55*Math.min(1,point.flow.amountUsdc/maxFunding)).toFixed(2)+'" stroke-width="'+(1+4*Math.sqrt(point.flow.amountUsdc/maxFunding)).toFixed(2)+'" d="M '+sourceX+' '+(sourceY+20)+' Q '+sourceX+' '+point.y+' '+point.x+' '+point.y+'"><title>'+money(point.flow.amountUsdc)+' funded · '+point.flow.transactions+' transactions</title></path>').join('');const usageEdges=points.map(point=>'<path class="funding-edge usage" opacity="'+(0.16+0.5*Math.min(1,point.flow.sellerVolumeUsdc/maxUsage)).toFixed(2)+'" stroke-width="'+(1+4*Math.sqrt(point.flow.sellerVolumeUsdc/maxUsage)).toFixed(2)+'" d="M '+point.x+' '+point.y+' Q '+sellerX+' '+point.y+' '+sellerX+' '+(sellerY-22)+'"><title>'+money(point.flow.sellerVolumeUsdc)+' settled with seller</title></path>').join('');const buyerNodes=points.map(point=>'<a href="https://base.blockscout.com/address/'+point.flow.buyer+'" target="_blank" class="funding-node buyer"><circle cx="'+point.x+'" cy="'+point.y+'" r="7"><title>'+point.flow.buyer+' · funded '+money(point.flow.amountUsdc)+' · seller usage '+money(point.flow.sellerVolumeUsdc)+'</title></circle></a>').join('');return'<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Funding source to buyers to seller graph">'+sourceEdges+usageEdges+'<a href="https://base.blockscout.com/address/'+source.funder+'" target="_blank" class="funding-node source"><circle cx="'+sourceX+'" cy="'+sourceY+'" r="20"><title>Funding source '+source.funder+'</title></circle><text x="'+sourceX+'" y="'+(sourceY-28)+'" text-anchor="middle">source '+short(source.funder)+'</text></a>'+buyerNodes+'<a href="https://antscan.co/account/'+s.seller+'" target="_blank" class="funding-node seller"><circle cx="'+sellerX+'" cy="'+sellerY+'" r="22"><title>Seller '+s.seller+'</title></circle><text x="'+sellerX+'" y="'+(sellerY+38)+'" text-anchor="middle">seller '+short(s.seller)+'</text></a></svg>'}
    function formatGap(seconds){if(seconds==null)return'—';if(seconds<60)return Math.round(seconds)+' sec';if(seconds<3600)return Math.round(seconds/60)+' min';if(seconds<86400)return(seconds/3600).toFixed(1)+' hr';return(seconds/86400).toFixed(1)+' days'}
    function number(value){const parsed=Number(value);return Number.isFinite(parsed)?new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(parsed):'—'}
    function price(value){return value==null||!Number.isFinite(Number(value))?'—':'$'+Number(value).toFixed(2)}
    function requestPrice(value){if(value==null||!Number.isFinite(Number(value)))return'—';const amount=Number(value);return'$'+amount.toFixed(amount<0.01?4:2)}
    function buyerFundingTable(s){const buyers=s.buyers||[];if(!buyers.length)return'<div class="muted">No buyer activity in the selected period.</div>';const flows=new Map();for(const source of s.fundingProvenance?.sources||[])for(const flow of source.buyerFlows||[])flows.set(flow.buyer,{...flow,funder:source.funder});return'<div class="table-wrap"><table><thead><tr><th>Buyer</th><th>Direct source</th><th>Funded</th><th>Funding txs</th><th>Seller volume</th><th>Seller share</th><th>Channels</th><th>Other sellers</th></tr></thead><tbody>'+buyers.slice(0,126).map(b=>{const flow=flows.get(b.buyer);return'<tr><td class="address"><a href="https://antscan.co/account/'+b.buyer+'" target="_blank">'+short(b.buyer)+'</a></td><td class="address">'+(flow?'<a href="https://base.blockscout.com/address/'+flow.funder+'" target="_blank">'+short(flow.funder)+'</a>':'—')+'</td><td>'+(flow?money(flow.amountUsdc):'—')+'</td><td>'+(flow?.transactions??'—')+'</td><td>'+money(b.volumeUsdc)+'</td><td>'+pct(b.sellerShare)+'</td><td>'+b.channels+'</td><td>'+b.otherSellers.length+'</td></tr>'}).join('')+'</tbody></table></div>'}
    function sellerFlowSection(s){const flow=s.sellerFundFlows;if(!flow)return'<div class="muted">Seller fund-flow evidence is unavailable.</div>';const status=flow.status==='complete'?'Complete seller transfer history':flow.status==='partial'?'Partial seller transfer history':'Seller transfer history unavailable';const note=flow.complete?'No missing seller transfer pages were reported.':'Blockscout returned incomplete seller transfer history; these are confirmed observed paths, but additional paths may be missing.';const summary=flow.returnPathSummary||{};const indirect=flow.indirectFunderSummary||{};return'<div class="stats">'+[['Seller-paid buyer wallets',summary.buyerCount||0],['Direct payment → deposit paths',summary.pathCount||0],['Multi-hop funder paths',indirect.pathCount||0],['Forwarded to cohort funder',money(indirect.forwardedToFunderUsdc||0)]].map(([label,value])=>'<div class="mini"><span>'+label+'</span><b>'+value+'</b></div>').join('')+'</div><div class="notice">'+esc(status)+'. '+esc(note)+'</div>'+circularFundingSequences(s,flow.indirectFunderPaths||[],flow.returnPaths||[])+indirectFunderTable(flow.indirectFunderPaths||[])+returnPathTable(flow.returnPaths||[])+sellerFlowTable(flow.recipients||[],flow.indirectFunderPaths||[],flow.passThroughPaths||[])}
    function circularFundingSequences(s,indirectPaths,returnPaths){if(!indirectPaths.length&&!returnPaths.length)return'<div class="muted">No circular-funding sequence was observed in the available evidence.</div>';return'<div class="sequence-group"><h4>Observed circular-funding sequences</h4><div class="chart-subtitle">These graphics combine seller-outflow paths that reach the buyer-cohort funder with seller-payment → buyer-deposit → seller-usage cycles. Each connection is independently transaction-backed; sequence correlation does not prove identity of fungible USDC.</div>'+indirectFunderGraph(s,indirectPaths)+returnPathGraph(s,returnPaths)+'</div>'}
    function indirectFunderGraph(s,paths){if(!paths.length)return'';const first=paths[0],width=1100,height=250,nodes=[{x:90,label:'seller',address:s.seller,kind:'seller'},{x:385,label:'relay',address:first.relay,kind:'buyer'},{x:690,label:'intermediary',address:first.intermediary,kind:'deposit'},{x:1010,label:'cohort funder',address:first.funder,kind:'source'}];const totals=paths.reduce((result,path)=>({seller:result.seller+path.sellerPaymentUsdc,relay:result.relay+path.relayForwardUsdc,funder:result.funder+path.funderReceiptUsdc}),{seller:0,relay:0,funder:0});const lines='<path class="loop-edge payment" d="M 115 115 L 360 115"><title>'+paths.length+' matched seller payouts totaling '+money(totals.seller)+'</title></path><path class="loop-edge deposit" d="M 410 115 L 665 115"><title>Relay forwarded '+money(totals.relay)+'</title></path><path class="loop-edge usage" d="M 715 115 L 985 115"><title>Intermediary forwarded '+money(totals.funder)+' to the cohort funder</title></path>';const rendered=nodes.map(node=>'<a href="https://base.blockscout.com/address/'+node.address+'" target="_blank" class="loop-node '+node.kind+'"><circle cx="'+node.x+'" cy="115" r="23"/><text x="'+node.x+'" y="158" text-anchor="middle">'+node.label+'</text><text x="'+node.x+'" y="178" text-anchor="middle">'+short(node.address)+'</text></a>').join('');return'<div class="loop-panel"><h4>Repeated multi-hop path into the buyer-cohort funder</h4><div class="chart-subtitle">The scanner found repeated amount- and time-matched transactions through the same relay structure. The terminal wallet independently appears as a direct funding source for this seller’s buyer cohort.</div><svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Seller to relay to intermediary to cohort funder transaction graph">'+lines+rendered+'</svg><div class="graph-legend"><span><i class="legend-line" style="background:var(--orange)"></i>seller payout</span><span><i class="legend-line source"></i>matching relay transfer</span><span><i class="legend-line usage"></i>near-total forward to cohort funder</span></div></div>'}
    function indirectFunderTable(paths){if(!paths.length)return'';return'<div class="table-wrap flow-table"><table><thead><tr><th>Seller payout</th><th>Relay</th><th>Relay delay</th><th>Intermediary</th><th>Funder receipt</th><th>Funder delay</th><th>Forwarded share</th><th>Retained</th></tr></thead><tbody>'+paths.slice(0,50).map(path=>'<tr><td><a href="https://base.blockscout.com/tx/'+path.sellerPaymentTx+'" target="_blank">'+money(path.sellerPaymentUsdc)+'</a></td><td class="address"><a href="https://base.blockscout.com/tx/'+path.relayForwardTx+'" target="_blank">'+short(path.relay)+'</a></td><td>'+formatGap(path.relayDelaySeconds)+'</td><td class="address"><a href="https://base.blockscout.com/address/'+path.intermediary+'" target="_blank">'+short(path.intermediary)+'</a></td><td><a href="https://base.blockscout.com/tx/'+path.funderReceiptTx+'" target="_blank">'+money(path.funderReceiptUsdc)+'</a></td><td>'+formatGap(path.funderDelaySeconds)+'</td><td>'+pct(path.forwardedShare)+'</td><td>'+money(path.retainedUsdc)+'</td></tr>').join('')+'</tbody></table></div><div class="analysis-note">A repeated transaction path establishes a financial relationship between these wallets. It does not by itself prove that one person beneficially owns every address.</div>'}
    function returnPathGraph(s,paths){const unique=[];const seen=new Set();for(const path of paths){if(seen.has(path.buyer))continue;seen.add(path.buyer);unique.push(path)}if(!unique.length)return'';const visible=unique.slice(0,20);const width=1100,rowHeight=55,height=100+visible.length*rowHeight;const sellerLeft={x:80,y:height/2},sellerRight={x:1020,y:height/2},buyerX=390,depositX=710;const rows=visible.map((path,index)=>{const y=58+index*rowHeight;const paymentHref=path.sellerPaymentTx?'https://base.blockscout.com/tx/'+path.sellerPaymentTx:'#';const depositHref=path.depositTx?'https://base.blockscout.com/tx/'+path.depositTx:'#';const usageHref=path.firstSellerUsageTx?'https://base.blockscout.com/tx/'+path.firstSellerUsageTx:'#';return'<path class="loop-edge payment" d="M '+(sellerLeft.x+22)+' '+sellerLeft.y+' Q 235 '+y+' '+(buyerX-10)+' '+y+'"><title>Seller paid '+money(path.sellerPaymentUsdc)+'; '+formatGap(path.depositDelaySeconds)+' until matched deposit</title></path><path class="loop-edge deposit" d="M '+(buyerX+10)+' '+y+' L '+(depositX-10)+' '+y+'"><title>Buyer deposited '+money(path.depositUsdc)+'; '+(path.exactDepositAmountMatch?'exact amount match':'nearest later deposit')+'</title></path><path class="loop-edge usage" d="M '+(depositX+10)+' '+y+' Q 865 '+y+' '+(sellerRight.x-22)+' '+sellerRight.y+'"><title>First subsequent seller settlement '+money(path.firstSellerUsageUsdc)+' after '+formatGap(path.usageDelaySeconds)+'</title></path><a href="'+paymentHref+'" target="_blank" class="loop-node buyer"><circle cx="'+buyerX+'" cy="'+y+'" r="8"/><text x="'+(buyerX-15)+'" y="'+(y-12)+'" text-anchor="end">'+short(path.buyer)+'</text></a><a href="'+depositHref+'" target="_blank" class="loop-node deposit"><circle cx="'+depositX+'" cy="'+y+'" r="8"/><text x="'+(depositX+15)+'" y="'+(y-12)+'">'+money(path.depositUsdc)+' deposit</text></a><a href="'+usageHref+'" target="_blank"><title>Open first subsequent settlement</title></a>'}).join('');return'<div class="loop-panel"><h4>Seller payment → buyer deposit → seller usage</h4><div class="chart-subtitle">Each row links a seller payment, a later buyer deposit, and later paid usage with the same seller.</div><svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Seller payment to buyer deposit to seller usage graph">'+rows+'<a href="https://base.blockscout.com/address/'+s.seller+'" target="_blank" class="loop-node seller"><circle cx="'+sellerLeft.x+'" cy="'+sellerLeft.y+'" r="22"/><text x="'+sellerLeft.x+'" y="'+(sellerLeft.y+38)+'" text-anchor="middle">seller pays</text></a><a href="https://antscan.co/account/'+s.seller+'" target="_blank" class="loop-node seller"><circle cx="'+sellerRight.x+'" cy="'+sellerRight.y+'" r="22"/><text x="'+sellerRight.x+'" y="'+(sellerRight.y+38)+'" text-anchor="middle">seller earns</text></a></svg><div class="graph-legend"><span><i class="legend-line" style="background:var(--orange)"></i>seller payment</span><span><i class="legend-line source"></i>buyer deposit</span><span><i class="legend-line usage"></i>subsequent seller usage</span></div></div>'}
    function returnPathTable(paths){if(!paths.length)return'';return'<div class="table-wrap flow-table"><table><thead><tr><th>Buyer</th><th>Seller payment</th><th>Delay to deposit</th><th>Buyer deposit</th><th>Amount match</th><th>First later seller usage</th><th>Delay to usage</th><th>Lifetime seller volume</th><th>Classification</th></tr></thead><tbody>'+paths.slice(0,50).map(path=>'<tr><td class="address"><a href="https://base.blockscout.com/address/'+path.buyer+'" target="_blank">'+short(path.buyer)+'</a></td><td><a href="https://base.blockscout.com/tx/'+path.sellerPaymentTx+'" target="_blank">'+money(path.sellerPaymentUsdc)+'</a></td><td>'+formatGap(path.depositDelaySeconds)+'</td><td><a href="https://base.blockscout.com/tx/'+path.depositTx+'" target="_blank">'+money(path.depositUsdc)+'</a></td><td>'+(path.exactDepositAmountMatch?'Exact':'Nearest later')+'</td><td><a href="https://base.blockscout.com/tx/'+path.firstSellerUsageTx+'" target="_blank">'+money(path.firstSellerUsageUsdc)+'</a></td><td>'+formatGap(path.usageDelaySeconds)+'</td><td>'+money(path.lifetimeSellerVolumeUsdc)+'</td><td>'+esc(path.classification.replaceAll('_',' '))+'</td></tr>').join('')+'</tbody></table></div><div class="analysis-note">A matched path means the events occurred in this order. USDC is fungible, so the scanner does not claim that the identical token units returned to the seller.</div>'}
    function sellerFlowTable(recipients,indirectPaths,passThroughPaths){if(!recipients.length)return'<div class="muted">No positive-value outbound USDC transfers were observed in the available seller trace.</div>';const pathsByRelay=new Map();for(const path of indirectPaths){const paths=pathsByRelay.get(path.relay)||[];paths.push(path);pathsByRelay.set(path.relay,paths)}const passThroughByRecipient=new Map();for(const path of passThroughPaths){const paths=passThroughByRecipient.get(path.recipient)||[];paths.push(path);passThroughByRecipient.set(path.recipient,paths)}function sequenceCell(recipient){const paths=pathsByRelay.get(recipient.recipient)||[];const passThrough=passThroughByRecipient.get(recipient.recipient)||[];const addressLink=address=>'<a class="address" href="https://base.blockscout.com/address/'+address+'" target="_blank">'+short(address)+'</a>';if(paths.length){const first=paths[0];const routes=new Set(paths.map(path=>path.intermediary+'>'+path.funder));const forwarded=paths.reduce((sum,path)=>sum+(path.funderReceiptUsdc||0),0);return'<div class="flow-sequence">'+addressLink(first.seller)+' <b>→</b> '+addressLink(first.relay)+' <b>→</b> '+addressLink(first.intermediary)+' <b>→</b> '+addressLink(first.funder)+'</div><div class="muted">'+paths.length+' matched path'+(paths.length===1?'':'s')+' · '+money(forwarded)+(routes.size>1?' · '+routes.size+' downstream routes':'')+'</div>'}if(passThrough.length){const first=passThrough[0];const destinations=new Set(passThrough.map(path=>path.destination));const forwarded=passThrough.reduce((sum,path)=>sum+(path.forwardedUsdc||0),0);return'<div class="flow-sequence">'+addressLink(first.seller)+' <b>→</b> '+addressLink(first.recipient)+' <b>→</b> '+addressLink(first.destination)+'</div><div class="muted">'+passThrough.length+' matched forward'+(passThrough.length===1?'':'s')+' · '+money(forwarded)+(destinations.size>1?' · '+destinations.size+' destinations':'')+'</div>'}return'<span class="muted">—</span>'}return'<div class="table-wrap flow-table"><table><thead><tr><th>Recipient</th><th>Relationship</th><th>Downstream sequence</th><th>Amount</th><th>Transfers</th><th>Observed period</th></tr></thead><tbody>'+recipients.slice(0,50).map(recipient=>'<tr><td class="address"><a href="https://base.blockscout.com/address/'+recipient.recipient+'" target="_blank">'+short(recipient.recipient)+'</a></td><td class="'+(recipient.affiliated?'affiliated':'')+'">'+esc(recipient.relation.replaceAll('_',' '))+'</td><td>'+sequenceCell(recipient)+'</td><td>'+money(recipient.amountUsdc)+'</td><td>'+recipient.transactions+'</td><td>'+date(recipient.firstAt)+' – '+date(recipient.lastAt)+'</td></tr>').join('')+'</tbody></table></div>'}
    function hideSeller(){els.drawer.classList.remove('open');els.drawer.setAttribute('aria-hidden','true')}
    function closeSeller(){hideSeller();if(history.state?.antseedSeller)history.back();else history.replaceState(null,'',location.pathname+location.search)}
    function syncSellerRoute(){const address=new URLSearchParams(location.hash.slice(1)).get('seller');if(address)openSeller(address,false);else hideSeller()}
    function openMethodology(){hideReasonTooltip();els.methodology.classList.add('open');els.methodology.setAttribute('aria-hidden','false');els.methodology.querySelector('.detail').scrollTop=0;els.methodologyClose.focus()}
    function closeMethodology(){els.methodology.classList.remove('open');els.methodology.setAttribute('aria-hidden','true');els.methodologyOpen.focus()}
    for(const element of [els.search,els.verdict,els.evidence,els.completeness])element.addEventListener(element.tagName==='INPUT'?'input':'change',renderRows);
    els.rows.addEventListener('mouseover',event=>{const tag=event.target.closest?.('.reason-tag');if(tag)showReasonTooltip(tag)});
    els.rows.addEventListener('mouseout',event=>{const tag=event.target.closest?.('.reason-tag');if(tag&&!tag.contains(event.relatedTarget))hideReasonTooltip()});
    els.rows.addEventListener('focusin',event=>{const tag=event.target.closest?.('.reason-tag');if(tag)showReasonTooltip(tag)});
    els.rows.addEventListener('focusout',event=>{if(event.target.closest?.('.reason-tag'))hideReasonTooltip()});
    window.addEventListener('scroll',hideReasonTooltip,true);
    els.methodologyOpen.addEventListener('click',openMethodology);els.methodologyClose.addEventListener('click',closeMethodology);els.methodologyBackdrop.addEventListener('click',closeMethodology);
    els.backdrop.addEventListener('click',closeSeller);window.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(els.methodology.classList.contains('open'))closeMethodology();else closeSeller()});window.addEventListener('popstate',syncSellerRoute);
    renderRows();syncSellerRoute();
  </script>
</body>
</html>
`;
}

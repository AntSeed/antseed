/**
 * Self-contained HTML for `GET /_antseed/routing-decisions/dashboard` --
 * opened in the user's default browser from the desktop app's Profile pill
 * (see apps/desktop/src/main/ipc/payments.ts's `payments:open-savings-page`).
 *
 * Deliberately NOT added to apps/payments' web SPA: that app's own App.tsx
 * states plainly "The portal dashboard is retired -- every view lives in the
 * desktop app (or the CLI). This page exists only for the actions that need
 * an external wallet signature." A read-only sessions/metrics view needs no
 * wallet signature, so it doesn't belong there. This route reuses the same
 * user-facing mechanism (a localhost page opened via shell.openExternal) on
 * the buyer-proxy's own already-running, already-unauthenticated control
 * plane instead, which already serves the JSON this page reads
 * (`/_antseed/routing-decisions`, same origin, no new server or auth needed).
 */

function escapeForHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * `routerName` is the active router plugin's short id (e.g. `acme-router`,
 * from `AntseedRouterPlugin.name`), threaded down from CLI startup -- see
 * `BuyerProxyConfig.routerName` in buyer-proxy.ts. Title-cased for display,
 * e.g. "Model-routing savings (Acme Router)". Falls back to the generic
 * title when no router plugin identity reached this proxy.
 */
export function getRoutingSavingsDashboardHtml(routerName?: string): string {
  const sectionTitle = routerName
    ? `Model-routing savings (${escapeForHtml(routerName.charAt(0).toUpperCase() + routerName.slice(1))})`
    : 'Auto-routing savings'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${sectionTitle}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* Same token set as apps/desktop/src/renderer/global.scss -- this page
     lives outside the Electron renderer (opened via shell.openExternal), so
     the tokens are copied rather than shared, but the values are the
     AntSeed brand palette, not a page-local invention. */
  :root {
    color-scheme: light dark;
    --bg-primary: #fbf9f4;
    --bg-card: #ffffff;
    --text-primary: #111714;
    --text-secondary: #4b5450;
    --text-muted: #6b7570;
    --accent: #008359;
    --accent-rgb: 0, 131, 89;
    --border: #d4dbd7;
    --border-light: #e4e9e5;
    --danger: #ef4444;
    --font-sans: 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
    --radius: 16px;
    --radius-sm: 8px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-primary: #1c1c1e;
      --bg-card: #2a2a2c;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #8b949e;
      --accent: #1fd87a;
      --accent-rgb: 31, 216, 122;
      --border: rgba(255, 255, 255, 0.08);
      --border-light: rgba(255, 255, 255, 0.04);
      --danger: #ff7b72;
    }
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 var(--font-sans);
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 20px 64px;
    color: var(--text-primary);
    background: var(--bg-primary);
    -webkit-font-smoothing: antialiased;
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
  .brand svg { flex: none; color: var(--accent); }
  h1 { font-size: 20px; font-weight: 600; margin: 0; }
  .stats { display: flex; flex-direction: column; gap: 4px; margin-bottom: 20px; }
  .stats-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .card {
    flex: 1 1 160px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: var(--text-muted); margin-bottom: 4px; }
  .card .value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .card .value .pct { font-size: 13px; font-weight: 600; color: var(--accent); margin-left: 6px; }
  .card .sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
  .tool-pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 500; color: var(--text-secondary);
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 999px; padding: 4px 12px; margin-left: 10px;
    vertical-align: middle;
  }
  .table-wrap { overflow-x: auto; }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; font-size: 13px; color: var(--text-muted); }
  .toolbar select {
    appearance: none;
    font: inherit; font-size: 13px; padding: 6px 28px 6px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background-color: var(--bg-card); color: var(--text-primary);
    background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%236b7570' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
  }
  .toolbar select:focus { outline: none; border-color: var(--accent); }
  .back { display: inline-block; margin-bottom: 14px; font-size: 13px; font-weight: 500; color: var(--accent); cursor: pointer; text-decoration: none; }
  .back:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600; padding: 0 10px 8px; border-bottom: 1px solid var(--border); }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td { padding: 9px 10px; border-bottom: 1px solid var(--border-light); }
  tr[data-session] { cursor: pointer; }
  tr.turn-row { cursor: pointer; }
  tr.turn-expansion td { padding: 14px 16px; background: var(--bg-primary); border-bottom: 1px solid var(--border); cursor: default; }
  .expansion-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: var(--text-muted); margin: 12px 0 6px; }
  .expansion-label:first-child { margin-top: 0; }
  table.considered { margin-bottom: 4px; }
  table.considered th { padding: 0 8px 6px; font-size: 10px; }
  table.considered td { padding: 6px 8px; font-size: 13px; }
  table.considered tr.picked td { font-weight: 600; color: var(--accent); }
  .prompt-preview { white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; margin: 0; max-height: 220px; overflow-y: auto; }
  .empty-inline { color: var(--text-muted); font-size: 13px; margin: 0; }
  tr:hover td { background: rgba(var(--accent-rgb), 0.05); }
  .empty, .error { color: var(--text-muted); padding: 40px 0; text-align: center; }
  .error { color: var(--danger); }
  h2 { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
  .session-header { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .session-header h2 { margin: 0 0 12px; }
</style>
</head>
<body>
<div class="brand">
  <svg width="24" height="24" viewBox="0 -1.5 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M14 9.62502C14.9665 9.62502 15.75 8.76317 15.75 7.70002C15.75 6.63688 14.9665 5.77502 14 5.77502C13.0335 5.77502 12.25 6.63688 12.25 7.70002C12.25 8.76317 13.0335 9.62502 14 9.62502Z" fill="currentColor"/>
    <path d="M13.9998 15.4C15.3529 15.4 16.4498 14.1464 16.4498 12.6C16.4498 11.0537 15.3529 9.80005 13.9998 9.80005C12.6467 9.80005 11.5498 11.0537 11.5498 12.6C11.5498 14.1464 12.6467 15.4 13.9998 15.4Z" fill="currentColor"/>
    <path d="M14.0001 23.45C15.7398 23.45 17.1501 21.5696 17.1501 19.25C17.1501 16.9305 15.7398 15.05 14.0001 15.05C12.2604 15.05 10.8501 16.9305 10.8501 19.25C10.8501 21.5696 12.2604 23.45 14.0001 23.45Z" fill="currentColor"/>
    <path opacity="0.7" d="M12.9498 5.94998L9.7998 2.09998" stroke="currentColor" stroke-width="0.6" stroke-linecap="round"/>
    <path opacity="0.7" d="M15.0498 5.94998L18.1998 2.09998" stroke="currentColor" stroke-width="0.6" stroke-linecap="round"/>
    <path d="M9.7998 2.97498C10.283 2.97498 10.6748 2.58322 10.6748 2.09998C10.6748 1.61673 10.283 1.22498 9.7998 1.22498C9.31655 1.22498 8.9248 1.61673 8.9248 2.09998C8.9248 2.58322 9.31655 2.97498 9.7998 2.97498Z" fill="currentColor"/>
    <path d="M18.2002 2.97498C18.6835 2.97498 19.0752 2.58322 19.0752 2.09998C19.0752 1.61673 18.6835 1.22498 18.2002 1.22498C17.717 1.22498 17.3252 1.61673 17.3252 2.09998C17.3252 2.58322 17.717 2.97498 18.2002 2.97498Z" fill="currentColor"/>
    <path opacity="0.5" d="M12.25 11.2001L6.125 7.70007" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path opacity="0.5" d="M15.75 11.2001L21.875 7.70007" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path d="M6.2998 8.57495C6.78305 8.57495 7.1748 8.1832 7.1748 7.69995C7.1748 7.2167 6.78305 6.82495 6.2998 6.82495C5.81655 6.82495 5.4248 7.2167 5.4248 7.69995C5.4248 8.1832 5.81655 8.57495 6.2998 8.57495Z" fill="currentColor"/>
    <path d="M21.7002 8.57495C22.1835 8.57495 22.5752 8.1832 22.5752 7.69995C22.5752 7.2167 22.1835 6.82495 21.7002 6.82495C21.217 6.82495 20.8252 7.2167 20.8252 7.69995C20.8252 8.1832 21.217 8.57495 21.7002 8.57495Z" fill="currentColor"/>
    <path opacity="0.5" d="M11.5499 13.3L4.8999 14" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path opacity="0.5" d="M16.4502 13.3L23.1002 14" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path d="M4.8999 14.875C5.38315 14.875 5.7749 14.4832 5.7749 14C5.7749 13.5168 5.38315 13.125 4.8999 13.125C4.41666 13.125 4.0249 13.5168 4.0249 14C4.0249 14.4832 4.41666 14.875 4.8999 14.875Z" fill="currentColor"/>
    <path d="M23.1001 14.875C23.5833 14.875 23.9751 14.4832 23.9751 14C23.9751 13.5168 23.5833 13.125 23.1001 13.125C22.6168 13.125 22.2251 13.5168 22.2251 14C22.2251 14.4832 22.6168 14.875 23.1001 14.875Z" fill="currentColor"/>
    <path opacity="0.5" d="M11.9001 18.2L5.6001 21" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path opacity="0.5" d="M16.1001 18.2L22.4001 21" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path d="M5.6001 21.875C6.08334 21.875 6.4751 21.4832 6.4751 21C6.4751 20.5168 6.08334 20.125 5.6001 20.125C5.11685 20.125 4.7251 20.5168 4.7251 21C4.7251 21.4832 5.11685 21.875 5.6001 21.875Z" fill="currentColor"/>
    <path d="M22.3999 21.875C22.8832 21.875 23.2749 21.4832 23.2749 21C23.2749 20.5168 22.8832 20.125 22.3999 20.125C21.9167 20.125 21.5249 20.5168 21.5249 21C21.5249 21.4832 21.9167 21.875 22.3999 21.875Z" fill="currentColor"/>
    <path opacity="0.15" d="M6.2999 7.69995L4.8999 14" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path opacity="0.15" d="M21.7002 7.69995L23.1002 14" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path opacity="0.15" d="M4.8999 14L5.5999 21" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
    <path opacity="0.15" d="M23.0999 14L22.3999 21" stroke="currentColor" stroke-width="0.52" stroke-linecap="round"/>
  </svg>
  <h1>${sectionTitle}</h1>
</div>
<div class="toolbar">
  <label for="baseline-select">Comparing against</label>
  <select id="baseline-select"></select>
</div>
<div id="stats" class="stats"></div>
<div id="content"></div>
<script>
(function () {
  function fmtUsd(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '&mdash;';
    if (n === 0) return '$0';
    if (n < 0.01) return '<$0.01';
    if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
    return '$' + n.toFixed(2);
  }
  function fmtDate(ms) {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    // textContent -> innerHTML escapes &, <, > but NOT " -- browsers only
    // quote-escape inside an actual attribute-value serialization, not text
    // nodes. This helper is used inside a title="..." attribute value too
    // (the baseline-price hover), so it must be safe there as well.
    return div.innerHTML.replace(/"/g, '&quot;');
  }
  function fmtPricePair(price) {
    if (!price) return null;
    var cached = price.cachedInUsdPerM != null ? ' / $' + price.cachedInUsdPerM.toFixed(2) + ' cached' : '';
    return '$' + price.inUsdPerM.toFixed(2) + ' in / $' + price.outUsdPerM.toFixed(2) + ' out' + cached + ' per M tokens';
  }
  function computeSavings(rows, baselineModel) {
    var actualUsd = 0, baselineUsd = 0, models = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row.actualModel || !validUsage(row)) continue;
      var baseline = row.baselinePrices && row.baselinePrices[baselineModel];
      if (!validPrice(baseline)) continue;
      var fresh = Math.max(0, (row.actualPromptTokens || 0) - (row.actualCachedTokens || 0));
      var cached = row.actualCachedTokens || 0;
      var output = row.actualCompletionTokens || 0;
      if (fresh === 0 && cached === 0 && output === 0) continue;
      var cachedPrice = baseline.cachedInUsdPerM != null ? baseline.cachedInUsdPerM : baseline.inUsdPerM;
      var rowBaseline = (fresh * baseline.inUsdPerM + cached * cachedPrice + output * baseline.outUsdPerM) / 1000000;
      if (rowBaseline <= 0) continue;
      baselineUsd += rowBaseline;
      actualUsd += row.actualUsdcPaid;
      models[row.actualModel] = true;
    }
    if (baselineUsd <= 0) return null;
    return { actualUsd: actualUsd, baselineUsd: baselineUsd, savedUsd: Math.max(0, baselineUsd - actualUsd) };
  }
  function validAmount(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0;
  }
  function validPrice(price) {
    return price && validAmount(price.inUsdPerM) && validAmount(price.outUsdPerM) &&
      (price.cachedInUsdPerM == null || validAmount(price.cachedInUsdPerM));
  }
  function validUsage(row) {
    return validAmount(row.actualUsdcPaid) && validAmount(row.actualPromptTokens) &&
      validAmount(row.actualCachedTokens) && validAmount(row.actualCompletionTokens) &&
      row.actualCachedTokens <= row.actualPromptTokens;
  }
  function allBaselineModels(rows) {
    var counts = {};
    rows.forEach(function (row) {
      Object.keys(row.baselinePrices || {}).forEach(function (key) {
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    // Every model the routing peer ever RANKED as a candidate ends up as a
    // baselinePrices key -- found live: 217 distinct models across 25 rows,
    // most of them image-generation services (flux-2-pro, krea-v2-large,
    // ideogram-v4, ...) that were considered and priced but never actually
    // chosen for a text completion. Key presence, or even a real positive
    // computeSavings figure, isn't enough to exclude those -- an image
    // model's per-token price is still a real number, so it still produces
    // a "computable" (if nonsensical) comparison. The one signal that
    // actually distinguishes "a model this router would route real chat
    // turns to" is having been the ACTUAL chosen model on at least one row
    // somewhere in the set.
    var actualModels = {};
    rows.forEach(function (row) {
      if (row.actualModel) actualModels[row.actualModel] = true;
    });
    return Object.keys(counts)
      .filter(function (key) { return actualModels[key] && computeSavings(rows, key) !== null; })
      .sort(function (a, b) { return counts[b] - counts[a]; });
  }
  function groupBySession(rows) {
    var byKey = {};
    rows.forEach(function (row) {
      if (!row.conversationKey) return;
      (byKey[row.conversationKey] = byKey[row.conversationKey] || []).push(row);
    });
    return Object.keys(byKey).map(function (key) {
      var sessionRows = byKey[key].sort(function (a, b) { return a.atMs - b.atMs; });
      var lastActiveAt = Math.max.apply(null, sessionRows.map(function (r) { return r.atMs; }));
      return { conversationKey: key, rows: sessionRows, turnCount: sessionRows.length, lastActiveAt: lastActiveAt };
    }).sort(function (a, b) { return b.lastActiveAt - a.lastActiveAt; });
  }
  var allRows = [];
  var currentBaseline = null;
  var allConversations = [];
  var expandedTurnIndex = -1;

  function findConversation(conversationKey) {
    for (var i = 0; i < allConversations.length; i++) {
      if (allConversations[i].sessionKey === conversationKey) return allConversations[i];
    }
    return null;
  }

  function statsRowHtml(rows, baselineModel) {
    var savings = computeSavings(rows, baselineModel) || { baselineUsd: null, actualUsd: null, savedUsd: null };
    var pct = savings.baselineUsd > 0 ? Math.round((savings.savedUsd / savings.baselineUsd) * 100) : null;
    return '<div class="stats-row">' +
      '<div class="card"><div class="label">Baseline</div><div class="value">' + fmtUsd(savings.baselineUsd) + '</div></div>' +
      '<div class="card"><div class="label">Observed / estimated cost</div><div class="value">' + fmtUsd(savings.actualUsd) + '</div></div>' +
      '<div class="card"><div class="label">Saved</div><div class="value">' + fmtUsd(savings.savedUsd) + (pct !== null ? '<span class="pct">' + pct + '%</span>' : '') + '</div></div>' +
      '</div>';
  }
  function renderStats(rows, baselineModel) {
    document.getElementById('stats').innerHTML = statsRowHtml(rows, baselineModel);
  }
  function savedCardHtml(label, savings, baselineLabel) {
    var pct = savings.baselineUsd > 0 ? Math.round((savings.savedUsd / savings.baselineUsd) * 100) : null;
    var hover = savings.baselineUsd > 0 ? fmtUsd(savings.actualUsd) + ' observed / estimated cost vs ' + fmtUsd(savings.baselineUsd) + ' ' + (baselineLabel || 'baseline') : '';
    return '<div class="card"' + (hover ? ' title="' + escapeHtml(hover) + '"' : '') + '>' +
      '<div class="label">' + label + '</div>' +
      '<div class="value">' + fmtUsd(savings.savedUsd) + (pct !== null ? '<span class="pct">' + pct + '%</span>' : '') + '</div>' +
      '</div>';
  }
  // Retail-price comparison, kept separate from computeSavings' own
  // AntSeed-network baseline -- only counts a row if it ALSO has a valid
  // AntSeed baseline for the same model, so this figure and the
  // AntSeed-baseline one are computed over the exact same row set and stay
  // directly comparable/stackable.
  function computeOpenRouterSavings(rows, baselineModel, orPrice) {
    if (!validPrice(orPrice)) return null;
    var actualUsd = 0, baselineUsd = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!computeSavings([row], baselineModel)) continue;
      var fresh = Math.max(0, (row.actualPromptTokens || 0) - (row.actualCachedTokens || 0));
      var cached = row.actualCachedTokens || 0;
      var output = row.actualCompletionTokens || 0;
      if (fresh === 0 && cached === 0 && output === 0) continue;
      var inputPrice = orPrice.inUsdPerM != null ? orPrice.inUsdPerM : 0;
      var cachedPrice = orPrice.cachedInUsdPerM != null ? orPrice.cachedInUsdPerM : inputPrice;
      var outputPrice = orPrice.outUsdPerM != null ? orPrice.outUsdPerM : 0;
      var rowBaseline = (fresh * inputPrice + cached * cachedPrice + output * outputPrice) / 1000000;
      if (rowBaseline <= 0) continue;
      baselineUsd += rowBaseline;
      actualUsd += row.actualUsdcPaid;
    }
    if (baselineUsd <= 0) return null;
    return { actualUsd: actualUsd, baselineUsd: baselineUsd, savedUsd: Math.max(0, baselineUsd - actualUsd) };
  }
  var openRouterPriceCache = {};
  function fetchOpenRouterPrice(model, callback) {
    if (Object.prototype.hasOwnProperty.call(openRouterPriceCache, model)) {
      callback(openRouterPriceCache[model]);
      return;
    }
    fetch('/_antseed/openrouter-reference-prices?models=' + encodeURIComponent(model))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var price = (data && data.prices && data.prices[model]) || null;
        openRouterPriceCache[model] = price;
        callback(price);
      })
      .catch(function () {
        callback(null);
      });
  }
  var statsRenderToken = 0;
  function renderSessionListStats(rows, baselineModel) {
    var token = ++statsRenderToken;
    var sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var recentRows = rows.filter(function (r) { return r.atMs >= sevenDaysAgo; });
    var week = computeSavings(recentRows, baselineModel) || { baselineUsd: null, actualUsd: null, savedUsd: null };
    var allTime = computeSavings(rows, baselineModel) || { baselineUsd: null, actualUsd: null, savedUsd: null };
    function paint(openRouterCardHtml) {
      if (token !== statsRenderToken) return; // superseded by a newer render
      document.getElementById('stats').innerHTML = '<div class="stats-row">' +
        savedCardHtml('Saved, 1w', week) +
        savedCardHtml('Saved, all time', allTime) +
        '<div class="card"><div class="label">Turns routed</div><div class="value">' + rows.length + '</div></div>' +
        (openRouterCardHtml || '') +
        '</div>';
    }
    paint('');
    if (baselineModel) {
      fetchOpenRouterPrice(baselineModel, function (orPrice) {
        var orSavings = computeOpenRouterSavings(rows, baselineModel, orPrice);
        if (orSavings) paint(savedCardHtml('Saved vs OpenRouter', orSavings, 'OpenRouter retail price'));
      });
    }
  }
  function sessionToolLabel(conversationKey) {
    var conv = findConversation(conversationKey);
    return (conv && conv.tool) ? conv.tool : null;
  }
  function renderSessionList() {
    renderSessionListStats(allRows, currentBaseline);
    var sessions = groupBySession(allRows);
    var html = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Session</th><th>Tool</th><th>Last active</th><th class="num">Turns</th><th class="num">Baseline</th><th class="num">Observed / estimated cost</th><th class="num">Saved</th>' +
      '</tr></thead><tbody>';
    sessions.forEach(function (session) {
      var savings = computeSavings(session.rows, currentBaseline);
      var toolLabel = sessionToolLabel(session.conversationKey);
      html += '<tr data-session="' + session.conversationKey + '">' +
        '<td>' + session.conversationKey.slice(0, 18) + '&hellip;</td>' +
        '<td>' + (toolLabel ? escapeHtml(toolLabel) : '&mdash;') + '</td>' +
        '<td>' + fmtDate(session.lastActiveAt) + '</td>' +
        '<td class="num">' + session.turnCount + '</td>' +
        '<td class="num">' + (savings ? fmtUsd(savings.baselineUsd) : '&mdash;') + '</td>' +
        '<td class="num">' + (savings ? fmtUsd(savings.actualUsd) : '&mdash;') + '</td>' +
        '<td class="num">' + (savings ? fmtUsd(savings.savedUsd) : '&mdash;') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    document.getElementById('content').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-session]'), function (tr) {
      tr.addEventListener('click', function () { renderSessionDetail(tr.getAttribute('data-session')); });
    });
  }
  function renderTurnExpansion(row) {
    var baselinePrice = row.baselinePrices && row.baselinePrices[currentBaseline];
    var html = '<tr class="turn-expansion"><td colspan="8">';
    if (row.consideredCandidates && row.consideredCandidates.length) {
      html += '<div class="expansion-label">Considered</div>' +
        '<table class="considered"><thead><tr><th>Model</th><th>Seller</th><th class="num">In</th><th class="num">Out</th><th class="num">Cached</th></tr></thead><tbody>';
      row.consideredCandidates.forEach(function (c) {
        html += '<tr' + (c.model === row.actualModel && c.peer === row.actualPeer ? ' class="picked"' : '') + '>' +
          '<td>' + escapeHtml(c.model) + '</td>' +
          '<td>' + escapeHtml(c.peer.slice(0, 8)) + '&hellip;</td>' +
          '<td class="num">$' + c.inUsdPerM.toFixed(2) + '</td>' +
          '<td class="num">$' + c.outUsdPerM.toFixed(2) + '</td>' +
          '<td class="num">' + (c.cachedInUsdPerM != null ? '$' + c.cachedInUsdPerM.toFixed(2) : '&mdash;') + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<div class="expansion-label">Considered</div><p class="empty-inline">No candidate data for this turn (reused a prior routing decision, or predates this feature).</p>';
    }
    html += '<div class="expansion-label">Baseline</div><p>' +
      (baselinePrice ? escapeHtml(currentBaseline) + ' &mdash; ' + fmtPricePair(baselinePrice) : 'No baseline price recorded for ' + escapeHtml(currentBaseline || 'this model') + ' on this turn.') +
      '</p>';
    html += '<div class="expansion-label">Prompt</div>' +
      (row.inputMessagePreview ? '<pre class="prompt-preview">' + escapeHtml(row.inputMessagePreview) + '</pre>' : '<p class="empty-inline">No prompt recorded for this turn.</p>');
    html += '</td></tr>';
    return html;
  }
  function renderSessionDetail(conversationKey) {
    var rows = allRows.filter(function (r) { return r.conversationKey === conversationKey; }).sort(function (a, b) { return a.atMs - b.atMs; });
    renderStats(rows, currentBaseline);
    var conv = findConversation(conversationKey);
    var metaParts = [rows.length + ' turn' + (rows.length === 1 ? '' : 's')];
    var titleLabel = (conv && conv.label) ? escapeHtml(conv.label) : (conversationKey.slice(0, 24) + '&hellip;');
    var toolLabelRaw = (conv && conv.tool) ? conv.tool : null;
    var html = '<a class="back" id="back-link">&larr; All sessions</a>' +
      '<div class="session-header"><h2>' + titleLabel + ' &mdash; ' + metaParts.join(', ') + '</h2>' +
      (toolLabelRaw ? '<span class="tool-pill">' + escapeHtml(toolLabelRaw) + '</span>' : '') + '</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th>Time</th><th>Model</th><th class="num">Input</th><th class="num">Cached</th><th class="num">Output</th>' +
      '<th class="num">Baseline</th><th class="num">Observed / estimated cost</th><th class="num">Saved</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (row, index) {
      var rowSavings = computeSavings([row], currentBaseline);
      var freshInput = Math.max(0, (row.actualPromptTokens || 0) - (row.actualCachedTokens || 0));
      var baselinePrice = row.baselinePrices && row.baselinePrices[currentBaseline];
      var hoverTitle = baselinePrice ? 'vs ' + currentBaseline + ': ' + fmtPricePair(baselinePrice) : '';
      html += '<tr class="turn-row" data-turn-index="' + index + '"' + (hoverTitle ? ' title="' + escapeHtml(hoverTitle) + '"' : '') + '>' +
        '<td>' + fmtDate(row.atMs) + '</td>' +
        '<td>' + (row.actualModel ? escapeHtml(row.actualModel) : '&mdash;') + '</td>' +
        '<td class="num">' + freshInput + '</td>' +
        '<td class="num">' + (row.actualCachedTokens || 0) + '</td>' +
        '<td class="num">' + (row.actualCompletionTokens || 0) + '</td>' +
        '<td class="num">' + (rowSavings ? fmtUsd(rowSavings.baselineUsd) : '&mdash;') + '</td>' +
        '<td class="num">' + fmtUsd(row.actualUsdcPaid) + '</td>' +
        '<td class="num">' + (rowSavings ? fmtUsd(rowSavings.savedUsd) : '&mdash;') + '</td>' +
        '</tr>';
      if (index === expandedTurnIndex) html += renderTurnExpansion(row);
    });
    html += '</tbody></table></div>';
    document.getElementById('content').innerHTML = html;
    document.getElementById('back-link').addEventListener('click', function () {
      expandedTurnIndex = -1;
      renderSessionList();
    });
    Array.prototype.forEach.call(document.querySelectorAll('tr.turn-row'), function (tr) {
      tr.addEventListener('click', function () {
        var index = Number(tr.getAttribute('data-turn-index'));
        expandedTurnIndex = expandedTurnIndex === index ? -1 : index;
        renderSessionDetail(conversationKey);
      });
    });
  }
  function populateBaselineSelect(rows, storedBaseline) {
    var select = document.getElementById('baseline-select');
    var models = allBaselineModels(rows);
    currentBaseline = (storedBaseline && models.indexOf(storedBaseline) !== -1) ? storedBaseline : models[0];
    select.innerHTML = models.map(function (m) {
      return '<option value="' + m + '"' + (m === currentBaseline ? ' selected' : '') + '>' + m + '</option>';
    }).join('');
    select.addEventListener('change', function () {
      currentBaseline = select.value;
      renderSessionList();
      // Shared with the desktop app's own savings text -- see
      // _savingsBaselineModel in apps/cli/src/proxy/buyer-proxy.ts.
      fetch('/_antseed/routing-decisions/baseline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseline: currentBaseline }),
      }).catch(function () {});
    });
  }
  function render(rows, storedBaseline, conversations) {
    allRows = rows;
    allConversations = conversations || [];
    if (!rows.length) {
      document.getElementById('stats').innerHTML = '';
      document.getElementById('content').innerHTML = '<p class="empty">No auto-routed sessions yet.</p>';
      document.querySelector('.toolbar').style.display = 'none';
      return;
    }
    populateBaselineSelect(rows, storedBaseline);
    renderSessionList();
  }
  Promise.all([
    fetch('/_antseed/routing-decisions').then(function (res) { return res.json(); }),
    fetch('/_antseed/routing-decisions/baseline').then(function (res) { return res.json(); }).catch(function () { return null; }),
    // Session metadata (which tool/harness, a user-given label) isn't on the
    // ledger row itself -- conversationKey is deliberately the bare
    // sessionKey, not tool-qualified (see RoutingDecisionRow's own doc
    // comment), so it's matched up client-side by sessionKey instead.
    fetch('/_antseed/conversations').then(function (res) { return res.json(); }).catch(function () { return null; }),
  ])
    .then(function (results) {
      var body = results[0];
      var baselineBody = results[1];
      var conversationsBody = results[2];
      render((body && body.rows) || [], baselineBody && baselineBody.baseline, conversationsBody && conversationsBody.conversations);
    })
    .catch(function (err) {
      document.getElementById('content').innerHTML = '<p class="error">Could not load routing data: ' + (err && err.message ? err.message : err) + '</p>';
    });
})();
</script>
</body>
</html>
`
}

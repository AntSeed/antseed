const PROVIDER_COLORS = {
  anthropic: '#e94560',
  openai: '#00c853',
  google: '#4285f4',
  moonshot: '#ffd600',
};

export function initDashboardRenderModule({
  elements,
  uiState,
  safeNumber,
  safeArray,
  safeString,
  safeObject,
  formatTimestamp,
  formatRelativeTime,
  formatDuration,
  formatInt,
  formatPercent,
  formatMoney,
  formatPrice,
  formatLatency,
  formatShortId,
  formatEndpoint,
  getCapacityColor,
  setText,
  setBadgeTone,
  isModeRunning,
  getActiveView,
  setActiveView,
  appendSystemLog,
  populateSettingsForm,
}: any) {
  function defaultNetworkStats() {
    return {
      totalPeers: 0,
      dhtNodeCount: 0,
      dhtHealthy: false,
      lastScanAt: null,
      totalLookups: 0,
      successfulLookups: 0,
      lookupSuccessRate: 0,
      averageLookupLatencyMs: 0,
      healthReason: 'dashboard offline',
    };
  }

  function networkHealth(stats, peerCount) {
    const healthy = Boolean(stats?.dhtHealthy);
    if (healthy) {
      return { label: 'Healthy', tone: 'active' };
    }
    if (peerCount > 0) {
      return { label: 'Limited', tone: 'warn' };
    }
    return { label: 'Down', tone: 'bad' };
  }

  function normalizeNetworkData(networkData, peersData) {
    const networkPeers = safeArray(networkData?.peers);
    const daemonPeers = safeArray(peersData?.peers);
    const stats = networkData?.stats && typeof networkData.stats === 'object'
      ? { ...defaultNetworkStats(), ...networkData.stats }
      : defaultNetworkStats();

    const merged = new Map();

    for (const peer of networkPeers) {
      const peerId = safeString(peer.peerId, '').trim();
      if (peerId.length === 0) continue;

      merged.set(peerId, {
        peerId,
        host: safeString(peer.host, ''),
        port: safeNumber(peer.port, 0),
        providers: safeArray(peer.providers),
        inputUsdPerMillion: safeNumber(peer.inputUsdPerMillion, 0),
        outputUsdPerMillion: safeNumber(peer.outputUsdPerMillion, 0),
        capacityMsgPerHour: safeNumber(peer.capacityMsgPerHour, 0),
        reputation: safeNumber(peer.reputation, 0),
        lastSeen: safeNumber(peer.lastSeen, 0),
        source: safeString(peer.source, 'dht'),
        location: null,
      });
    }

    for (const peer of daemonPeers) {
      const peerId = safeString(peer.peerId, '').trim();
      if (peerId.length === 0) continue;

      const existing = merged.get(peerId) ?? {
        peerId,
        host: '',
        port: 0,
        providers: [],
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        capacityMsgPerHour: 0,
        reputation: 0,
        lastSeen: 0,
        source: 'daemon',
        location: null,
      };

      const providers = safeArray(peer.providers);
      if (providers.length > 0) {
        existing.providers = providers;
      }

      if (safeNumber(peer.inputUsdPerMillion, 0) > 0) {
        existing.inputUsdPerMillion = safeNumber(peer.inputUsdPerMillion, 0);
      }

      if (safeNumber(peer.outputUsdPerMillion, 0) > 0) {
        existing.outputUsdPerMillion = safeNumber(peer.outputUsdPerMillion, 0);
      }

      if (safeNumber(peer.capacityMsgPerHour, 0) > 0) {
        existing.capacityMsgPerHour = safeNumber(peer.capacityMsgPerHour, 0);
      }

      if (safeNumber(peer.reputation, 0) > 0) {
        existing.reputation = safeNumber(peer.reputation, 0);
      }

      existing.location = typeof peer.location === 'string' ? peer.location : existing.location;
      if (!existing.source || existing.source === 'dht') {
        existing.source = safeString(peer.source, 'daemon');
      }

      merged.set(peerId, existing);
    }

    const peers = Array.from(merged.values()).sort((a, b) => {
      if (b.reputation !== a.reputation) {
        return b.reputation - a.reputation;
      }
      return b.lastSeen - a.lastSeen;
    });

    stats.totalPeers = peers.length;

    return {
      peers,
      stats,
    };
  }

  function buildEmptyRow(columnCount, message) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columnCount;
    cell.className = 'empty';
    cell.textContent = message;
    row.appendChild(cell);
    return row;
  }

  function renderOverviewPeers(peers) {
    if (!elements.overviewPeersBody) return;

    elements.overviewPeersBody.innerHTML = '';
    const topPeers = peers.slice(0, 6);

    if (topPeers.length === 0) {
      elements.overviewPeersBody.appendChild(buildEmptyRow(3, 'No peers yet.'));
      return;
    }

    for (const peer of topPeers) {
      const row = document.createElement('tr');

      const peerCell = document.createElement('td');
      peerCell.textContent = formatShortId(peer.peerId);
      peerCell.title = peer.peerId;

      const providersCell = document.createElement('td');
      providersCell.textContent = peer.providers.length > 0 ? peer.providers.join(', ') : 'n/a';

      const reputationCell = document.createElement('td');
      reputationCell.textContent = formatInt(peer.reputation);

      row.append(peerCell, providersCell, reputationCell);
      elements.overviewPeersBody.appendChild(row);
    }
  }

  function renderCapacityRing(percent, proxyPort, sessions, peerCount, dhtNodes) {
    const arc = elements.capacityArc;
    if (arc) {
      const circumference = 2 * Math.PI * 40;
      const offset = circumference - (percent / 100) * circumference;
      const color = getCapacityColor(percent);
      arc.setAttribute('stroke-dasharray', String(circumference));
      arc.setAttribute('stroke-dashoffset', String(offset));
      arc.setAttribute('stroke', color);
      if (elements.capacityPercent) {
        elements.capacityPercent.textContent = `${Math.round(percent)}%`;
        elements.capacityPercent.style.color = color;
      }
    }
    setText(elements.ovProxyPort, proxyPort > 0 ? String(proxyPort) : '-');
    setText(elements.ovCapSessions, formatInt(sessions));
    setText(elements.ovCapPeers, formatInt(peerCount));
    setText(elements.ovCapDht, formatInt(dhtNodes));
  }

  function renderMiniChart(dailyData) {
    const container = elements.miniChartContainer;
    if (!container) return;

    const data = safeArray(dailyData).slice(-14).map((d) => ({
      date: safeString(d.date, ''),
      amount: safeNumber(typeof d.amount === 'string' ? parseFloat(d.amount) : d.amount, 0),
    }));

    if (data.length === 0) {
      container.innerHTML = '<div class="mini-chart-empty">No earnings data yet</div>';
      return;
    }

    const max = Math.max(...data.map((d) => d.amount), 0.01);

    let html = '<div class="mini-chart-bars">';
    for (const d of data) {
      const height = Math.max(2, (d.amount / max) * 60);
      html += `<div class="mini-chart-bar-group" title="${d.date}: $${d.amount.toFixed(2)}">`;
      html += `<div class="mini-chart-bar" style="height:${height}px"></div>`;
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="mini-chart-labels">';
    html += `<span>${data[0].date.slice(5)}</span>`;
    html += `<span>${data[data.length - 1].date.slice(5)}</span>`;
    html += '</div>';

    container.innerHTML = html;
  }

  function drawLineChart(canvas, dailyData) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    const data = safeArray(dailyData).map((d) => ({
      date: safeString(d.date, ''),
      amount: safeNumber(typeof d.amount === 'string' ? parseFloat(d.amount) : d.amount, 0),
    }));

    if (data.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No earnings data yet', w / 2, h / 2);
      return;
    }

    const pad = { top: 20, right: 20, bottom: 30, left: 50 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    const max = Math.max(...data.map((d) => d.amount), 0.01) * 1.1;

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i += 1) {
      const y = pad.top + (plotH / gridLines) * i;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();

      const val = max - (max / gridLines) * i;
      ctx.setLineDash([]);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`$${val.toFixed(2)}`, pad.left - 6, y + 4);
    }

    ctx.setLineDash([]);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < data.length; i += 1) {
      const x = pad.left + (i / Math.max(data.length - 1, 1)) * plotW;
      const y = pad.top + plotH - (data[i].amount / max) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'center';
    const labelStep = Math.max(1, Math.floor(data.length / 6));
    for (let i = 0; i < data.length; i += labelStep) {
      const x = pad.left + (i / Math.max(data.length - 1, 1)) * plotW;
      ctx.fillText(data[i].date.slice(5), x, h - 8);
    }
    if (data.length > 1) {
      const lastX = pad.left + plotW;
      ctx.fillText(data[data.length - 1].date.slice(5), lastX, h - 8);
    }
  }

  function drawPieChart(canvas, providerData) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    const data = safeArray(providerData).map((d) => ({
      provider: safeString(d.provider, 'unknown'),
      amount: safeNumber(typeof d.amount === 'string' ? parseFloat(d.amount) : d.amount, 0),
    })).filter((d) => d.amount > 0);

    if (data.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No provider data yet', w / 2, h / 2);
      return;
    }

    const total = data.reduce((sum, d) => sum + d.amount, 0);
    const cx = w * 0.4;
    const cy = h / 2;
    const r = Math.min(cx - 20, cy - 20, 80);

    let startAngle = -Math.PI / 2;
    for (const d of data) {
      const sliceAngle = (d.amount / total) * 2 * Math.PI;
      const color = (PROVIDER_COLORS as Record<string, string>)[String(d.provider)] || '#888';

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      startAngle += sliceAngle;
    }

    const legendX = cx + r + 30;
    let legendY = cy - (data.length * 20) / 2;
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'left';
    for (const d of data) {
      const color = (PROVIDER_COLORS as Record<string, string>)[String(d.provider)] || '#888';
      const pct = ((d.amount / total) * 100).toFixed(0);
      ctx.fillStyle = color;
      ctx.fillRect(legendX, legendY, 10, 10);
      ctx.fillStyle = '#f1f5f9';
      ctx.fillText(`${d.provider} ${pct}% ($${d.amount.toFixed(2)})`, legendX + 16, legendY + 9);
      legendY += 20;
    }
  }

  function sortItems(items, sortState) {
    const { key, dir } = sortState;
    return [...items].sort((a, b) => {
      let va = a[key];
      let vb = b[key];
      if (Array.isArray(va)) va = va.join(', ');
      if (Array.isArray(vb)) vb = vb.join(', ');
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  function updateSortHeaders(thead, sortState) {
    if (!thead) return;
    const ths = thead.querySelectorAll('.sortable');
    for (const th of ths) {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === sortState.key) {
        th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    }
  }

  function filterPeers(peers, filterText) {
    if (!filterText) return peers;
    const lower = filterText.toLowerCase();
    return peers.filter((peer) => {
      const searchable = [
        peer.peerId,
        safeString(peer.source, ''),
        peer.providers.join(' '),
        formatPrice(peer.inputUsdPerMillion),
        formatPrice(peer.outputUsdPerMillion),
        String(peer.capacityMsgPerHour),
        String(peer.reputation),
        safeString(peer.location, ''),
        formatEndpoint(peer),
      ].join(' ').toLowerCase();
      return searchable.includes(lower);
    });
  }

  function renderPeersTable(peers) {
    if (!elements.peersBody) return;
    uiState.lastPeers = peers;

    const filtered = filterPeers(peers, uiState.peerFilter);
    const sorted = sortItems(filtered, uiState.peerSort);
    updateSortHeaders(elements.peersHead, uiState.peerSort);

    elements.peersBody.innerHTML = '';
    if (sorted.length === 0) {
      elements.peersBody.appendChild(buildEmptyRow(9, peers.length > 0 ? 'No peers match filter.' : 'No peers discovered yet.'));
      return;
    }

    for (const peer of sorted) {
      const row = document.createElement('tr');

      const peerId = document.createElement('td');
      peerId.textContent = formatShortId(peer.peerId);
      peerId.title = peer.peerId;

      const source = document.createElement('td');
      source.textContent = safeString(peer.source, 'n/a').toUpperCase();

      const providers = document.createElement('td');
      providers.textContent = peer.providers.length > 0 ? peer.providers.join(', ') : 'n/a';

      const inputPrice = document.createElement('td');
      inputPrice.textContent = formatPrice(peer.inputUsdPerMillion);

      const outputPrice = document.createElement('td');
      outputPrice.textContent = formatPrice(peer.outputUsdPerMillion);

      const capacity = document.createElement('td');
      capacity.textContent = peer.capacityMsgPerHour > 0 ? `${formatInt(peer.capacityMsgPerHour)}/h` : 'n/a';

      const reputation = document.createElement('td');
      reputation.textContent = formatInt(peer.reputation);

      const location = document.createElement('td');
      location.textContent = peer.location && peer.location.trim().length > 0 ? peer.location : '-';

      const endpoint = document.createElement('td');
      endpoint.textContent = formatEndpoint(peer);

      row.append(peerId, source, providers, inputPrice, outputPrice, capacity, reputation, location, endpoint);
      elements.peersBody.appendChild(row);
    }
  }

  function renderSessionsTable(payload) {
    if (!elements.sessionsBody) return;
    uiState.lastSessionsPayload = payload;

    const sessions = sortItems(safeArray(payload?.sessions), uiState.sessionSort);
    updateSortHeaders(elements.sessionsHead, uiState.sessionSort);

    elements.sessionsBody.innerHTML = '';

    if (sessions.length === 0) {
      elements.sessionsBody.appendChild(buildEmptyRow(8, 'No sessions yet.'));
      return;
    }

    for (const session of sessions) {
      const row = document.createElement('tr');

      const sessionId = document.createElement('td');
      sessionId.textContent = formatShortId(session.sessionId, 10, 6);
      sessionId.title = safeString(session.sessionId, '');

      const provider = document.createElement('td');
      provider.textContent = safeString(session.provider, 'n/a');

      const started = document.createElement('td');
      started.textContent = formatTimestamp(session.startedAt);

      const tokens = document.createElement('td');
      tokens.textContent = formatInt(session.totalTokens);

      const requests = document.createElement('td');
      requests.textContent = formatInt(session.totalRequests);

      const duration = document.createElement('td');
      duration.textContent = formatDuration(session.durationMs);

      const latency = document.createElement('td');
      latency.textContent = formatLatency(session.avgLatencyMs);

      const switches = document.createElement('td');
      switches.textContent = formatInt(session.peerSwitches);

      row.append(sessionId, provider, started, tokens, requests, duration, latency, switches);
      elements.sessionsBody.appendChild(row);
    }
  }

  function renderOfflineState(message) {
    setText(elements.peersMessage, message);
    setText(elements.sessionsMessage, message);
    setText(elements.earningsMessage, message);
    setText(elements.configMessage, message);

    setText(elements.ovNodeState, 'offline');
    setText(elements.ovPeers, '0');
    setText(elements.ovSessions, '0');
    setText(elements.ovEarnings, '$0.00');
    setText(elements.ovDhtHealth, 'Down');
    setText(elements.ovUptime, '-');
    setText(elements.ovPeersCount, '0');

    renderOverviewPeers([]);
    renderCapacityRing(0, 0, 0, 0, 0);
    renderMiniChart([]);
    renderPeersTable([]);
    renderSessionsTable({ sessions: [] });
    drawLineChart(elements.earningsLineChart, []);
    drawPieChart(elements.earningsPieChart, []);

    setText(elements.earnToday, '$0.00');
    setText(elements.earnWeek, '$0.00');
    setText(elements.earnMonth, '$0.00');

    setText(elements.connectionStatus, message);
    setText(elements.connectionNetwork, message);
    setText(elements.connectionSources, message);
    setText(elements.connectionNotes, message);
    setText(elements.overviewDataSources, message);

    setBadgeTone(elements.overviewBadge, 'idle', 'Idle');
    setBadgeTone(elements.peersMeta, 'idle', '0 peers');
    setBadgeTone(elements.sessionsMeta, 'idle', '0 sessions');
    setBadgeTone(elements.earningsMeta, 'idle', 'month');
    setBadgeTone(elements.connectionMeta, 'idle', 'offline');
    setBadgeTone(elements.configMeta, 'idle', 'offline');
  }

  function renderDashboardData(results) {
    const networkOk = results.network.ok || results.peers.ok;
    const normalizedNetwork = normalizeNetworkData(
      results.network.ok ? results.network.data : null,
      results.peers.ok ? results.peers.data : null,
    );

    const peers = normalizedNetwork.peers;
    const stats = normalizedNetwork.stats;
    const dht = networkHealth(stats, peers.length);

    const statusPayload = results.status.ok ? results.status.data : null;
    const sessionsPayload = results.sessions.ok ? results.sessions.data : null;
    const earningsPayload = results.earnings.ok ? results.earnings.data : null;
    const dataSourcesPayload = results.dataSources.ok ? results.dataSources.data : null;
    const configPayload = results.config.ok ? results.config.data : null;

    const daemonStateRoot = safeObject(uiState.daemonState?.state);
    const daemonActiveSessions = safeNumber(daemonStateRoot?.activeSessions, 0);
    const daemonSessionDetails = safeArray(daemonStateRoot?.activeSessionDetails);
    const daemonDetailsCount = daemonSessionDetails.length;

    const buyerRuntimeState = isModeRunning('connect') ? 'connected' : 'offline';
    const activeSessions = Math.max(
      safeNumber(statusPayload?.activeSessions, safeNumber(sessionsPayload?.total, 0)),
      daemonActiveSessions,
      daemonDetailsCount,
    );
    const earningsToday = earningsPayload?.today ?? statusPayload?.earningsToday ?? '0';
    const proxyPort = safeNumber(statusPayload?.proxyPort, 0);

    setText(elements.ovNodeState, buyerRuntimeState);
    setText(elements.ovPeers, formatInt(peers.length));
    setText(elements.ovSessions, formatInt(activeSessions));
    setText(elements.ovEarnings, formatMoney(earningsToday));
    setText(elements.ovDhtHealth, dht.label);
    setText(elements.ovUptime, proxyPort > 0 ? String(proxyPort) : '-');
    setText(elements.ovPeersCount, formatInt(peers.length));

    uiState.lastActiveSessions = activeSessions;

    setBadgeTone(
      elements.overviewBadge,
      buyerRuntimeState === 'offline' ? 'idle' : dht.tone,
      `${buyerRuntimeState.toUpperCase()} • DHT ${dht.label}`,
    );

    renderOverviewPeers(peers);

    const capacityPercent = safeNumber(statusPayload?.capacityUsedPercent, 0);
    renderCapacityRing(capacityPercent, proxyPort, activeSessions, peers.length, stats.dhtNodeCount);

    if (results.earnings.ok) {
      renderMiniChart(safeArray(earningsPayload?.daily));
    }

    renderPeersTable(peers);

    if (networkOk) {
      setText(elements.peersMessage, `Peer visibility merged from daemon and DHT. Last scan: ${formatRelativeTime(stats.lastScanAt)}`);
    } else {
      const msg = results.network.error ?? results.peers.error ?? 'network unavailable';
      setText(elements.peersMessage, `Unable to load peers: ${msg}`);
    }

    setBadgeTone(
      elements.peersMeta,
      dht.tone,
      `${formatInt(peers.length)} peers • DHT ${dht.label}`,
    );

    const sessionRowsFromApi = safeArray(sessionsPayload?.sessions);
    const totalSessionsFromApi = safeNumber(sessionsPayload?.total, sessionRowsFromApi.length);
    const missingLiveSessions = Math.max(0, activeSessions - totalSessionsFromApi);

    let sessionsForTable = sessionsPayload;
    let usingLiveSessionFallback = false;
    let sessionsUnavailable = false;

    if (!results.sessions.ok) {
      sessionsUnavailable = true;
    }

    if (sessionRowsFromApi.length === 0 && (activeSessions > 0 || daemonDetailsCount > 0)) {
      const now = Date.now();
      const fromDaemon = daemonSessionDetails
        .map((entry, index) => {
          const row = safeObject(entry);
          if (!row) {
            return null;
          }
          const startedAt = safeNumber(row.startedAt, now);
          return {
            sessionId: safeString(row.sessionId, `live-${index + 1}`),
            provider: safeString(row.provider, 'live'),
            startedAt,
            totalTokens: safeNumber(row.totalTokens, 0),
            totalRequests: safeNumber(row.totalRequests, 0),
            durationMs: Math.max(0, now - startedAt),
            avgLatencyMs: safeNumber(row.avgLatencyMs, 0),
            peerSwitches: 0,
          };
        })
        .filter((item) => item !== null);

      const fallbackRows = fromDaemon.length > 0
        ? fromDaemon
        : Array.from({ length: Math.max(1, Math.round(activeSessions)) }, (_, index) => ({
          sessionId: `live-${index + 1}`,
          provider: 'live',
          startedAt: now,
          totalTokens: 0,
          totalRequests: 0,
          durationMs: 0,
          avgLatencyMs: 0,
          peerSwitches: 0,
        }));
      sessionsForTable = {
        sessions: fallbackRows,
        total: fallbackRows.length,
      };
      usingLiveSessionFallback = true;
    }

    const sessionDebugKey = [
      `status=${safeNumber(statusPayload?.activeSessions, -1)}`,
      `daemon=${daemonActiveSessions}`,
      `details=${daemonDetailsCount}`,
      `apiTotal=${totalSessionsFromApi}`,
      `apiRows=${sessionRowsFromApi.length}`,
      `apiOk=${results.sessions.ok}`,
      `fallback=${usingLiveSessionFallback}`,
    ].join('|');
    if (sessionDebugKey !== uiState.lastSessionDebugKey) {
      uiState.lastSessionDebugKey = sessionDebugKey;
      appendSystemLog(`Session debug: ${sessionDebugKey}`);
    }

    renderSessionsTable(sessionsForTable);
    if (results.sessions.ok || usingLiveSessionFallback) {
      const totalSessions = Math.max(totalSessionsFromApi, activeSessions);
      setBadgeTone(elements.sessionsMeta, totalSessions > 0 ? 'active' : 'idle', `${formatInt(totalSessions)} sessions`);
      if (usingLiveSessionFallback) {
        setText(
          elements.sessionsMessage,
          sessionsUnavailable
            ? `${formatInt(activeSessions)} active session(s) detected from daemon state. Sessions API is degraded, showing live placeholders.`
            : `${formatInt(activeSessions)} active session(s) detected from daemon state. Detailed metering rows will appear as writes land.`,
        );
      } else if (missingLiveSessions > 0) {
        setText(
          elements.sessionsMessage,
          `Showing ${formatInt(totalSessionsFromApi)} metered session(s). ${formatInt(missingLiveSessions)} live session(s) are still syncing.`,
        );
      } else {
        setText(elements.sessionsMessage, 'Session metrics from metering storage.');
      }
    } else {
      setBadgeTone(elements.sessionsMeta, 'warn', 'sessions unavailable');
      setText(elements.sessionsMessage, `Unable to load sessions: ${results.sessions.error ?? 'unknown error'}`);
    }

    if (results.earnings.ok) {
      setText(elements.earnToday, formatMoney(earningsPayload?.today));
      setText(elements.earnWeek, formatMoney(earningsPayload?.thisWeek));
      setText(elements.earnMonth, formatMoney(earningsPayload?.thisMonth));

      drawLineChart(elements.earningsLineChart, safeArray(earningsPayload?.daily));
      drawPieChart(elements.earningsPieChart, safeArray(earningsPayload?.byProvider));

      setText(elements.earningsMessage, 'Earnings from metering data.');
      setBadgeTone(elements.earningsMeta, 'active', uiState.earningsPeriod);
    } else {
      setText(elements.earningsMessage, `Unable to load earnings: ${results.earnings.error ?? 'unknown error'}`);
      setText(elements.earnToday, '$0.00');
      setText(elements.earnWeek, '$0.00');
      setText(elements.earnMonth, '$0.00');
      drawLineChart(elements.earningsLineChart, []);
      drawPieChart(elements.earningsPieChart, []);
      setBadgeTone(elements.earningsMeta, 'warn', 'degraded');
    }

    if (results.status.ok) {
      const buyerStatus = {
        buyerRuntime: buyerRuntimeState,
        proxyPort: proxyPort > 0 ? proxyPort : null,
        activeSessions,
        peerCount: peers.length,
        dht: {
          health: dht.label,
          healthy: Boolean(stats.dhtHealthy),
          nodeCount: safeNumber(stats.dhtNodeCount, 0),
          lastScanAt: stats.lastScanAt,
          lookupSuccessRate: safeNumber(stats.lookupSuccessRate, 0),
          averageLookupLatencyMs: safeNumber(stats.averageLookupLatencyMs, 0),
        },
      };
      setText(elements.connectionStatus, JSON.stringify(buyerStatus, null, 2));
    } else {
      setText(elements.connectionStatus, `Unable to load status: ${results.status.error ?? 'unknown error'}`);
    }

    if (networkOk) {
      setText(elements.connectionNetwork, JSON.stringify({ peers: peers.slice(0, 200), stats }, null, 2));
    } else {
      setText(elements.connectionNetwork, `Unable to load network: ${results.network.error ?? 'unknown error'}`);
    }

    if (results.dataSources.ok) {
      setText(elements.connectionSources, JSON.stringify(dataSourcesPayload, null, 2));
    } else {
      setText(elements.connectionSources, `Unable to load data sources: ${results.dataSources.error ?? 'unknown error'}`);
    }

    const degradedReasons = safeArray(dataSourcesPayload?.degradedReasons)
      .filter((item) => typeof item === 'string' && item.trim().length > 0);

    const notes = [
      `Buyer runtime: ${buyerRuntimeState}`,
      `Proxy port: ${proxyPort > 0 ? proxyPort : 'not available'}`,
      `Active sessions: ${formatInt(activeSessions)}`,
      `DHT health: ${dht.label}`,
      `DHT nodes: ${formatInt(stats.dhtNodeCount)}`,
      `Lookup success: ${formatPercent(stats.lookupSuccessRate * 100)}`,
      `Avg lookup latency: ${formatLatency(stats.averageLookupLatencyMs)}`,
      `Last scan: ${formatRelativeTime(stats.lastScanAt)}`,
    ];

    if (safeString(stats.healthReason, '').length > 0) {
      notes.push(`DHT reason: ${stats.healthReason}`);
    }

    if (degradedReasons.length > 0) {
      notes.push(`Data source degraded: ${degradedReasons.join(' | ')}`);
    }

    setText(elements.connectionNotes, notes.join('\n'));
    setBadgeTone(elements.connectionMeta, dht.tone, `DHT ${dht.label}`);

    if (results.config.ok) {
      const config = configPayload?.config ?? configPayload;
      populateSettingsForm(config);

      const pluginCount = safeArray(config?.plugins).length;
      setBadgeTone(elements.configMeta, 'active', `${pluginCount} plugins`);
      setText(elements.configMessage, 'Settings loaded from dashboard API.');
    } else {
      setText(elements.configMessage, `Unable to load config: ${results.config.error ?? 'unknown error'}`);
      setBadgeTone(elements.configMeta, 'warn', 'config unavailable');
    }
  }

  function initSortableHeaders() {
    if (elements.peersHead) {
      elements.peersHead.addEventListener('click', (e) => {
        const th = e.target.closest('.sortable');
        if (!th) return;
        const key = th.dataset.sort;
        if (uiState.peerSort.key === key) {
          uiState.peerSort.dir = uiState.peerSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          uiState.peerSort = { key, dir: 'asc' };
        }
        renderPeersTable(uiState.lastPeers);
      });
    }

    if (elements.sessionsHead) {
      elements.sessionsHead.addEventListener('click', (e) => {
        const th = e.target.closest('.sortable');
        if (!th) return;
        const key = th.dataset.sort;
        if (uiState.sessionSort.key === key) {
          uiState.sessionSort.dir = uiState.sessionSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          uiState.sessionSort = { key, dir: 'asc' };
        }
        if (uiState.lastSessionsPayload) {
          renderSessionsTable(uiState.lastSessionsPayload);
        }
      });
    }
  }

  function bindPeerFilter() {
    if (elements.peerFilter) {
      elements.peerFilter.addEventListener('input', (e) => {
        uiState.peerFilter = e.target.value;
        renderPeersTable(uiState.lastPeers);
      });
    }
  }

  return {
    renderDashboardData,
    renderPeersTable,
    renderSessionsTable,
    renderOfflineState,
    initSortableHeaders,
    bindPeerFilter,
  };
}

export function initDashboardRenderModule({
  elements,
  uiState,
  safeNumber,
  safeArray,
  safeString,
  safeObject,
  formatRelativeTime,
  formatInt,
  formatPercent,
  formatLatency,
  formatShortId,
  formatEndpoint,
  setText,
  setBadgeTone,
  isModeRunning,
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
        String(peer.inputUsdPerMillion),
        String(peer.outputUsdPerMillion),
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
      inputPrice.textContent = String(peer.inputUsdPerMillion);

      const outputPrice = document.createElement('td');
      outputPrice.textContent = String(peer.outputUsdPerMillion);

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

  function renderOfflineState(message) {
    setText(elements.peersMessage, message);
    setText(elements.configMessage, message);

    setText(elements.ovNodeState, 'offline');
    setText(elements.ovPeers, '0');
    setText(elements.ovDhtHealth, 'Down');
    setText(elements.ovUptime, '-');
    setText(elements.ovPeersCount, '0');

    renderOverviewPeers([]);
    renderPeersTable([]);

    setText(elements.connectionStatus, message);
    setText(elements.connectionNetwork, message);
    setText(elements.connectionSources, message);
    setText(elements.connectionNotes, message);
    setText(elements.overviewDataSources, message);

    setBadgeTone(elements.overviewBadge, 'idle', 'Idle');
    setBadgeTone(elements.peersMeta, 'idle', '0 peers');
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
    const dataSourcesPayload = results.dataSources.ok ? results.dataSources.data : null;
    const configPayload = results.config.ok ? results.config.data : null;

    const daemonStateRoot = safeObject(uiState.daemonState?.state);
    const daemonActiveSessions = safeNumber(daemonStateRoot?.activeSessions, 0);
    const daemonSessionDetails = safeArray(daemonStateRoot?.activeSessionDetails);
    const daemonDetailsCount = daemonSessionDetails.length;

    const buyerRuntimeState = isModeRunning('connect') ? 'connected' : 'offline';
    const activeSessions = Math.max(
      safeNumber(statusPayload?.activeSessions, 0),
      daemonActiveSessions,
      daemonDetailsCount,
    );
    const proxyPort = safeNumber(statusPayload?.proxyPort, 0);

    setText(elements.ovNodeState, buyerRuntimeState);
    setText(elements.ovPeers, formatInt(peers.length));
    setText(elements.ovDhtHealth, dht.label);
    setText(elements.ovUptime, proxyPort > 0 ? String(proxyPort) : '-');
    setText(elements.ovPeersCount, formatInt(peers.length));

    setBadgeTone(
      elements.overviewBadge,
      buyerRuntimeState === 'offline' ? 'idle' : dht.tone,
      `${buyerRuntimeState.toUpperCase()} • DHT ${dht.label}`,
    );

    renderOverviewPeers(peers);
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

    const debugKey = [
      `active=${activeSessions}`,
      `daemon=${daemonActiveSessions}`,
      `details=${daemonDetailsCount}`,
      `peers=${peers.length}`,
    ].join('|');
    if (debugKey !== uiState.lastDebugKey) {
      uiState.lastDebugKey = debugKey;
      appendSystemLog(`Buyer status debug: ${debugKey}`);
    }
  }

  function initSortableHeaders() {
    if (elements.peersHead) {
      elements.peersHead.addEventListener('click', (e) => {
        const th = (e.target as HTMLElement | null)?.closest('.sortable') as HTMLElement | null;
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
  }

  function bindPeerFilter() {
    if (elements.peerFilter) {
      elements.peerFilter.addEventListener('input', (e) => {
        uiState.peerFilter = (e.target as HTMLInputElement).value;
        renderPeersTable(uiState.lastPeers);
      });
    }
  }

  return {
    renderDashboardData,
    renderPeersTable,
    renderOfflineState,
    initSortableHeaders,
    bindPeerFilter,
  };
}

import type { RendererUiState, BadgeTone, PeerEntry } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import { safeNumber, safeArray, safeString, safeObject } from '../core/safe';
import {
  formatRelativeTime,
  formatInt,
  formatPercent,
  formatLatency,
  formatEndpoint,
} from '../core/format';

type DashboardRenderModuleOptions = {
  uiState: RendererUiState;
  isModeRunning: (mode: string) => boolean;
  appendSystemLog: (message: string) => void;
  populateSettingsForm: (config: unknown) => void;
};

function defaultNetworkStats() {
  return {
    totalPeers: 0,
    dhtNodeCount: 0,
    dhtHealthy: false,
    lastScanAt: null as number | null,
    totalLookups: 0,
    successfulLookups: 0,
    lookupSuccessRate: 0,
    averageLookupLatencyMs: 0,
    healthReason: 'dashboard offline',
  };
}

function networkHealth(
  stats: ReturnType<typeof defaultNetworkStats>,
  peerCount: number,
): { label: string; tone: BadgeTone } {
  const healthy = Boolean(stats?.dhtHealthy);
  if (healthy) return { label: 'Healthy', tone: 'active' };
  if (peerCount > 0) return { label: 'Limited', tone: 'warn' };
  return { label: 'Down', tone: 'bad' };
}

function normalizeNetworkData(
  networkData: Record<string, unknown> | null,
  peersData: Record<string, unknown> | null,
): { peers: PeerEntry[]; stats: ReturnType<typeof defaultNetworkStats>; serviceCount: number } {
  const networkPeers = safeArray(networkData?.peers) as Record<string, unknown>[];
  const daemonPeers = safeArray(peersData?.peers) as Record<string, unknown>[];
  const rawStats = networkData?.stats;
  const stats =
    rawStats && typeof rawStats === 'object'
      ? { ...defaultNetworkStats(), ...(rawStats as Record<string, unknown>) }
      : defaultNetworkStats();

  const merged = new Map<string, PeerEntry>();

  for (const peer of networkPeers) {
    const peerId = safeString(peer.peerId, '').trim();
    if (peerId.length === 0) continue;

    const dn = typeof peer.displayName === 'string' && peer.displayName.trim().length > 0 ? peer.displayName.trim() : null;
    merged.set(peerId, {
      peerId,
      displayName: dn,
      host: safeString(peer.host, ''),
      port: safeNumber(peer.port, 0),
      providers: safeArray(peer.providers).map(String),
      services: safeArray(peer.services)
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
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
      displayName: null,
      host: '',
      port: 0,
      providers: [],
      services: [],
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      capacityMsgPerHour: 0,
      reputation: 0,
      lastSeen: 0,
      source: 'daemon',
      location: null,
    };

    const providers = safeArray(peer.providers).map(String);
    if (providers.length > 0) existing.providers = providers;
    const peerServices = safeArray(peer.services)
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (peerServices.length > 0) existing.services = peerServices;
    if (safeNumber(peer.inputUsdPerMillion, 0) > 0) existing.inputUsdPerMillion = safeNumber(peer.inputUsdPerMillion, 0);
    if (safeNumber(peer.outputUsdPerMillion, 0) > 0) existing.outputUsdPerMillion = safeNumber(peer.outputUsdPerMillion, 0);
    if (safeNumber(peer.capacityMsgPerHour, 0) > 0) existing.capacityMsgPerHour = safeNumber(peer.capacityMsgPerHour, 0);
    if (safeNumber(peer.reputation, 0) > 0) existing.reputation = safeNumber(peer.reputation, 0);
    existing.location = typeof peer.location === 'string' ? peer.location : existing.location;
    const daemonDn = typeof peer.displayName === 'string' && (peer.displayName as string).trim().length > 0 ? (peer.displayName as string).trim() : null;
    if (daemonDn) existing.displayName = daemonDn;
    if (!existing.source || existing.source === 'dht') existing.source = safeString(peer.source, 'daemon');

    merged.set(peerId, existing);
  }

  const peers = Array.from(merged.values())
    .filter((peer) => peer.services.length > 0 || peer.providers.length > 0)
    .sort((a, b) => {
      if (b.reputation !== a.reputation) return b.reputation - a.reputation;
      return b.lastSeen - a.lastSeen;
    });

  const services = new Set<string>();
  for (const peer of [...networkPeers, ...daemonPeers]) {
    for (const s of safeArray(peer.services)) {
      if (typeof s !== 'string') continue;
      const normalized = s.trim();
      if (normalized.length > 0) {
        services.add(normalized);
      }
    }
  }

  stats.totalPeers = peers.length;
  return { peers, stats, serviceCount: services.size };
}

export function initDashboardRenderModule({
  uiState,
  isModeRunning,
  appendSystemLog,
  populateSettingsForm,
}: DashboardRenderModuleOptions) {
  function renderOfflineState(message: string): void {
    uiState.peersMessage = message;
    uiState.configMessage = { text: message, type: 'info' };

    uiState.ovNodeState = 'offline';
    uiState.ovPeers = '0';
    uiState.ovDhtHealth = 'Down';
    uiState.ovProxyPort = '-';
    uiState.ovServiceCount = '0';
    uiState.ovLastScan = 'n/a';
    uiState.ovPeersCount = '0';
    uiState.overviewPeers = [];
    uiState.lastPeers = [];

    uiState.connectionStatus = message;
    uiState.connectionNetwork = message;
    uiState.connectionSources = message;
    uiState.connectionNotes = message;
    uiState.overviewDataSources = message;

    uiState.overviewBadge = { tone: 'idle', label: 'Idle' };
    uiState.peersMeta = { tone: 'idle', label: '0 peers' };
    uiState.connectionMeta = { tone: 'idle', label: 'offline' };
    uiState.configMeta = { tone: 'idle', label: 'offline' };

    notifyUiStateChanged();
  }

  function renderDashboardData(results: {
    network: { ok: boolean; data: unknown; error?: string | null };
    peers: { ok: boolean; data: unknown; error?: string | null };
    status: { ok: boolean; data: unknown; error?: string | null };
    dataSources: { ok: boolean; data: unknown; error?: string | null };
    config: { ok: boolean; data: unknown; error?: string | null };
  }): void {
    const networkOk = results.network.ok || results.peers.ok;
    const normalizedNetwork = normalizeNetworkData(
      results.network.ok ? (results.network.data as Record<string, unknown> | null) : null,
      results.peers.ok ? (results.peers.data as Record<string, unknown> | null) : null,
    );

    const peers = normalizedNetwork.peers;
    const stats = normalizedNetwork.stats;
    const serviceCount = normalizedNetwork.serviceCount;
    const dht = networkHealth(stats, peers.length);

    const statusPayload = results.status.ok ? (results.status.data as Record<string, unknown>) : null;
    const dataSourcesPayload = results.dataSources.ok ? (results.dataSources.data as Record<string, unknown> | null) : null;
    const configPayload = results.config.ok ? (results.config.data as Record<string, unknown> | null) : null;

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
    const configRoot = safeObject((configPayload as Record<string, unknown> | null)?.config ?? configPayload);
    const configBuyer = safeObject(configRoot?.buyer);
    const configuredProxyPort = safeNumber(configBuyer?.proxyPort, 0);
    const runtimeProxyPort = safeNumber(statusPayload?.proxyPort, 0);
    const proxyPort = runtimeProxyPort > 0 ? runtimeProxyPort : configuredProxyPort;

    // Overview stats
    uiState.ovNodeState = buyerRuntimeState;
    uiState.ovPeers = formatInt(peers.length);
    uiState.ovDhtHealth = dht.label;
    uiState.ovProxyPort = proxyPort > 0 ? String(proxyPort) : '-';
    uiState.ovServiceCount = formatInt(serviceCount);
    uiState.ovLastScan = formatRelativeTime(stats.lastScanAt);
    uiState.ovPeersCount = formatInt(peers.length);
    uiState.overviewBadge = {
      tone: buyerRuntimeState === 'offline' ? 'idle' : dht.tone,
      label: `${buyerRuntimeState.toUpperCase()} • DHT ${dht.label}`,
    };
    uiState.overviewPeers = peers.slice(0, 6);

    // Peers
    uiState.lastPeers = peers;
    if (networkOk) {
      uiState.peersMessage = `Peer visibility merged from daemon and DHT. Last scan: ${formatRelativeTime(stats.lastScanAt)}`;
    } else {
      const msg = results.network.error ?? results.peers.error ?? 'network unavailable';
      uiState.peersMessage = `Unable to load peers: ${msg}`;
    }
    uiState.peersMeta = {
      tone: dht.tone,
      label: `${formatInt(peers.length)} peers • DHT ${dht.label}`,
    };

    // Connection
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
      uiState.connectionStatus = JSON.stringify(buyerStatus, null, 2);
    } else {
      uiState.connectionStatus = `Unable to load status: ${results.status.error ?? 'unknown error'}`;
    }

    if (networkOk) {
      uiState.connectionNetwork = JSON.stringify({ peers: peers.slice(0, 200), stats }, null, 2);
    } else {
      uiState.connectionNetwork = `Unable to load network: ${results.network.error ?? 'unknown error'}`;
    }

    if (results.dataSources.ok) {
      uiState.connectionSources = JSON.stringify(dataSourcesPayload, null, 2);
    } else {
      uiState.connectionSources = `Unable to load data sources: ${results.dataSources.error ?? 'unknown error'}`;
    }

    const degradedReasons = safeArray(dataSourcesPayload?.degradedReasons).filter(
      (item) => typeof item === 'string' && (item as string).trim().length > 0,
    );

    const notes = [
      `Buyer runtime: ${buyerRuntimeState}`,
      `Proxy port: ${proxyPort > 0 ? proxyPort : 'not available'}`,
      `Active sessions: ${formatInt(activeSessions)}`,
      `DHT health: ${dht.label}`,
      `DHT nodes: ${formatInt(stats.dhtNodeCount)}`,
      `Lookup success: ${formatPercent(safeNumber(stats.lookupSuccessRate, 0) * 100)}`,
      `Avg lookup latency: ${formatLatency(stats.averageLookupLatencyMs)}`,
      `Last scan: ${formatRelativeTime(stats.lastScanAt)}`,
    ];

    if (safeString(stats.healthReason, '').length > 0) {
      notes.push(`DHT reason: ${stats.healthReason}`);
    }
    if (degradedReasons.length > 0) {
      notes.push(`Data source degraded: ${(degradedReasons as string[]).join(' | ')}`);
    }

    uiState.connectionNotes = notes.join('\n');
    uiState.connectionMeta = { tone: dht.tone, label: `DHT ${dht.label}` };

    // Config
    if (results.config.ok) {
      const config = (configPayload as Record<string, unknown> | null)?.config ?? configPayload;
      populateSettingsForm(config);

      const pluginCount = safeArray((config as Record<string, unknown> | null)?.plugins).length;
      uiState.configMeta = { tone: 'active', label: `${pluginCount} plugins` };
      uiState.configMessage = { text: 'Settings loaded from dashboard API.', type: 'info' };
    } else {
      uiState.configMessage = { text: `Unable to load config: ${results.config.error ?? 'unknown error'}`, type: 'error' };
      uiState.configMeta = { tone: 'warn', label: 'config unavailable' };
    }

    // Debug
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

    notifyUiStateChanged();
  }

  return {
    renderDashboardData,
    renderOfflineState,
  };
}

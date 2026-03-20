import { readFile } from 'node:fs/promises';
import { DEFAULT_BUYER_STATE_PATH } from './constants.js';

export type DashboardNetworkPeer = {
  peerId: string;
  displayName: string | null;
  host: string;
  port: number;
  providers: string[];
  services: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  lastSeen: number;
  source: 'dht' | 'daemon';
  online: boolean;
};

export type DashboardNetworkStats = {
  totalPeers: number;
  dhtNodeCount: number;
  dhtHealthy: boolean;
  lastScanAt: number | null;
  totalLookups?: number;
  successfulLookups?: number;
  lookupSuccessRate?: number;
  averageLookupLatencyMs?: number;
  healthReason?: string;
};

export type DashboardNetworkResult = {
  ok: boolean;
  peers: DashboardNetworkPeer[];
  stats: DashboardNetworkStats;
  error: string | null;
};

export const PEER_ONLINE_TTL_MS = 5 * 60_000;

const REFRESH_MIN_INTERVAL_MS = 5_000;

const peerCache = new Map<string, DashboardNetworkPeer>();
let peerCacheLastScanAt: number | null = null;
let peerCacheLastRefreshAt = 0;

export function defaultNetworkStats(): DashboardNetworkStats {
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

export function parsePeerFromRaw(pr: Record<string, unknown>): DashboardNetworkPeer | null {
  if (typeof pr.peerId !== 'string') return null;

  let peerHost = '';
  let peerPort = 0;
  if (typeof pr.publicAddress === 'string') {
    const addr = pr.publicAddress as string;
    const lastColon = addr.lastIndexOf(':');
    peerHost = lastColon > -1 ? addr.slice(0, lastColon) : addr;
    peerPort = lastColon > -1 ? Number(addr.slice(lastColon + 1)) || 0 : 0;
  }

  const displayName = typeof pr.displayName === 'string' && pr.displayName.trim().length > 0
    ? pr.displayName.trim()
    : null;

  const providers = Array.isArray(pr.providers)
    ? (pr.providers as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  const services = Array.isArray(pr.services)
    ? (pr.services as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  return {
    peerId: pr.peerId as string,
    displayName,
    host: peerHost,
    port: peerPort,
    providers,
    services,
    inputUsdPerMillion: Number(pr.defaultInputUsdPerMillion) || 0,
    outputUsdPerMillion: Number(pr.defaultOutputUsdPerMillion) || 0,
    capacityMsgPerHour: (Number(pr.maxConcurrency) || 0) * 60,
    reputation: 100,
    lastSeen: Number(pr.lastSeen) || Date.now(),
    source: 'dht',
    online: true,
  };
}

/** Refresh peer cache from buyer.state.json — merge new, mark stale as offline. */
export async function refreshPeerCache(): Promise<void> {
  // Skip if refreshed recently — the buyer runtime only writes every ~5 min.
  const now = Date.now();
  if (now - peerCacheLastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
    return;
  }
  peerCacheLastRefreshAt = now;

  // Track which peers are in the current file snapshot.
  const seenInFile = new Set<string>();

  try {
    const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawPeers = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];

    for (const p of rawPeers) {
      if (!p || typeof p !== 'object') continue;
      const peer = parsePeerFromRaw(p as Record<string, unknown>);
      if (!peer) continue;

      seenInFile.add(peer.peerId);
      const existing = peerCache.get(peer.peerId);
      if (existing) {
        peer.displayName = peer.displayName ?? existing.displayName;
        peer.providers = peer.providers.length > 0 ? peer.providers : existing.providers;
        peer.services = peer.services.length > 0 ? peer.services : existing.services;
        peer.inputUsdPerMillion = peer.inputUsdPerMillion || existing.inputUsdPerMillion;
        peer.outputUsdPerMillion = peer.outputUsdPerMillion || existing.outputUsdPerMillion;
        peer.capacityMsgPerHour = peer.capacityMsgPerHour || existing.capacityMsgPerHour;
        peer.lastSeen = Math.max(peer.lastSeen, existing.lastSeen);
      }
      peer.online = true;
      peerCache.set(peer.peerId, peer);
    }

    peerCacheLastScanAt = Number(parsed.peersUpdatedAt) || Date.now();
  } catch {
    // File doesn't exist yet — buyer runtime may not be running.
  }

  // Mark peers not in the current file snapshot as offline if stale.
  for (const [id, peer] of peerCache) {
    if (!seenInFile.has(id)) {
      peer.online = now - peer.lastSeen < PEER_ONLINE_TTL_MS;
    }
  }
}

export function getNetworkSnapshot(): DashboardNetworkResult {
  const peers = Array.from(peerCache.values());
  return {
    ok: true,
    peers,
    stats: {
      ...defaultNetworkStats(),
      totalPeers: peers.length,
      dhtHealthy: peers.some((p) => p.online),
      lastScanAt: peerCacheLastScanAt,
    },
    error: null,
  };
}

/**
 * Mark a peer as recently active and online (e.g. after a chat response).
 */
export function touchPeer(peerId: string): boolean {
  const peer = peerCache.get(peerId);
  if (peer) {
    peer.lastSeen = Date.now();
    peer.online = true;
    return true;
  }
  return false;
}

/** Look up a peer by ID from the in-memory cache. */
export function lookupPeer(peerId: string): DashboardNetworkPeer | null {
  return peerCache.get(peerId) ?? null;
}

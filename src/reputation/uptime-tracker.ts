import { EventEmitter } from 'node:events';
import type { PeerId } from '../types/peer.js';

export interface UptimeWindow {
  start: number;
  end: number;
}

export interface PeerUptimeRecord {
  peerId: PeerId;
  windows: UptimeWindow[];
  lastPingAt: number;
}

export interface UptimeTrackerConfig {
  /** How long since last ping before a peer is considered offline (ms). Default: 120_000 (2 min) */
  offlineThresholdMs?: number;
  /** Rolling window for uptime calculation (ms). Default: 7 * 24 * 60 * 60 * 1000 (7 days) */
  windowDurationMs?: number;
}

const DEFAULT_OFFLINE_THRESHOLD = 120_000;
const DEFAULT_WINDOW_DURATION = 7 * 24 * 60 * 60 * 1000;

export class UptimeTracker extends EventEmitter {
  private records: Map<string, PeerUptimeRecord> = new Map();
  private readonly offlineThresholdMs: number;
  private readonly windowDurationMs: number;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: UptimeTrackerConfig) {
    super();
    this.offlineThresholdMs = config?.offlineThresholdMs ?? DEFAULT_OFFLINE_THRESHOLD;
    this.windowDurationMs = config?.windowDurationMs ?? DEFAULT_WINDOW_DURATION;
  }

  /**
   * Record a ping from a peer — marks them as online.
   */
  recordPing(peerId: PeerId): void {
    const now = Date.now();
    const record = this.records.get(peerId);

    if (!record) {
      // New peer — start first window
      this.records.set(peerId, {
        peerId,
        windows: [{ start: now, end: now }],
        lastPingAt: now,
      });
      this.emit('peer-online', peerId);
      return;
    }

    const lastWindow = record.windows[record.windows.length - 1];
    const timeSinceLastPing = now - record.lastPingAt;

    if (timeSinceLastPing > this.offlineThresholdMs) {
      // Was offline — start new window
      if (lastWindow) {
        lastWindow.end = record.lastPingAt;
      }
      record.windows.push({ start: now, end: now });
      this.emit('peer-online', peerId);
    } else if (lastWindow) {
      // Extend current window
      lastWindow.end = now;
    }

    record.lastPingAt = now;
    this.pruneOldWindows(record);
  }

  /**
   * Explicitly record a peer going offline.
   */
  recordOffline(peerId: PeerId): void {
    const record = this.records.get(peerId);
    if (!record) return;

    const lastWindow = record.windows[record.windows.length - 1];
    if (lastWindow) {
      lastWindow.end = Date.now();
    }
    this.emit('peer-offline', peerId);
  }

  /**
   * Calculate uptime rate for a peer over the rolling window.
   * @returns 0.0 to 1.0
   */
  getUptimeRate(peerId: PeerId): number {
    const record = this.records.get(peerId);
    if (!record || record.windows.length === 0) return 0;

    const now = Date.now();
    const windowStart = now - this.windowDurationMs;
    let totalUptime = 0;

    for (const w of record.windows) {
      const effectiveStart = Math.max(w.start, windowStart);
      const effectiveEnd = Math.min(w.end, now);
      if (effectiveEnd > effectiveStart) {
        totalUptime += effectiveEnd - effectiveStart;
      }
    }

    return Math.min(1, totalUptime / this.windowDurationMs);
  }

  /**
   * Get uptime rates for all tracked peers.
   */
  getAllUptimeRates(): Map<PeerId, number> {
    const rates = new Map<PeerId, number>();
    for (const record of this.records.values()) {
      rates.set(record.peerId, this.getUptimeRate(record.peerId));
    }
    return rates;
  }

  /**
   * Start periodic checking for peers that have gone offline.
   */
  startTracking(): void {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(() => {
      const now = Date.now();
      for (const record of this.records.values()) {
        if (now - record.lastPingAt > this.offlineThresholdMs) {
          const lastWindow = record.windows[record.windows.length - 1];
          if (lastWindow && lastWindow.end === record.lastPingAt) {
            // Close the window — peer went offline
            this.emit('peer-offline', record.peerId);
          }
        }
      }
    }, this.offlineThresholdMs);
  }

  /**
   * Stop periodic tracking.
   */
  stopTracking(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private pruneOldWindows(record: PeerUptimeRecord): void {
    const cutoff = Date.now() - this.windowDurationMs;
    record.windows = record.windows.filter(w => w.end > cutoff);
  }
}

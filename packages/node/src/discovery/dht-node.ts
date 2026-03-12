import DHT from "bittorrent-dht";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { PeerId } from "../types/peer.js";
import { OFFICIAL_BOOTSTRAP_NODES, toBootstrapConfig } from "./bootstrap.js";

export interface DHTNodeConfig {
  peerId: PeerId;
  port: number;
  bootstrapNodes: Array<{ host: string; port: number }>;
  reannounceIntervalMs: number;
  operationTimeoutMs: number;
  /** Allow private/loopback IPs in lookup results. Default: false. Set true for local testing. */
  allowPrivateIPs?: boolean;
}

export const DEFAULT_DHT_CONFIG: Omit<DHTNodeConfig, "peerId"> = {
  port: 6881,
  bootstrapNodes: toBootstrapConfig(OFFICIAL_BOOTSTRAP_NODES),
  reannounceIntervalMs: 15 * 60 * 1000,
  operationTimeoutMs: 10_000,
};

function isPublicIP(host: string): boolean {
  if (host === "localhost" || host === "::1") return false;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  if (a === 127) return false; // loopback
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 169 && b === 254) return false; // link-local
  if (a === 0) return false;
  return true;
}

export function topicToInfoHash(topic: string): Buffer {
  return createHash("sha1").update(topic).digest();
}

function normalizeTopicSegment(value: string): string {
  return value.trim().toLowerCase();
}

export function providerTopic(providerName: string): string {
  return "antseed:" + normalizeTopicSegment(providerName);
}

export function normalizeServiceTopicKey(modelName: string): string {
  return normalizeTopicSegment(modelName);
}

export function normalizeServiceSearchTopicKey(modelName: string): string {
  const canonical = normalizeServiceTopicKey(modelName);
  const compact = canonical.replace(/[\s_-]+/g, "");
  return compact.length > 0 ? compact : canonical;
}

export function serviceTopic(modelName: string): string {
  return "antseed:service:" + normalizeServiceTopicKey(modelName);
}

export function serviceSearchTopic(modelName: string): string {
  return "antseed:service-search:" + normalizeServiceSearchTopicKey(modelName);
}

export function capabilityTopic(capability: string, name?: string): string {
  const base = "antseed:" + normalizeTopicSegment(capability);
  return name ? base + ":" + normalizeTopicSegment(name) : base;
}

export class DHTNode {
  private readonly config: DHTNodeConfig;
  private dht: DHT | null = null;
  public readonly events: EventEmitter = new EventEmitter();

  constructor(config: DHTNodeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.dht = new DHT({
        bootstrap: this.config.bootstrapNodes.map(
          (n) => `${n.host}:${n.port}`
        ),
      });

      const timeout = setTimeout(() => {
        // Resolve even on timeout — the DHT may still work with partial bootstrap.
        // This prevents hanging when public bootstrap nodes are unreachable.
        cleanup();
        this.events.emit("ready");
        resolve();
      }, this.config.operationTimeoutMs);

      let settled = false;
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
      };

      this.dht.listen(this.config.port, () => {
        // Socket is bound; now wait for DHT bootstrap to complete.
        // The 'ready' event fires when the routing table has been populated.
        this.dht!.on("ready", () => {
          cleanup();
          this.events.emit("ready");
          resolve();
        });
      });

      this.dht.on("error", (err: Error) => {
        cleanup();
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.dht) {
        resolve();
        return;
      }
      this.dht.destroy(() => {
        this.dht = null;
        resolve();
      });
    });
  }

  async announce(infoHash: Buffer, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.dht) {
        reject(new Error("DHT not started"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error("Announce timeout"));
      }, this.config.operationTimeoutMs);

      this.dht.announce(infoHash, port, (err?: Error) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async lookup(infoHash: Buffer): Promise<Array<{ host: string; port: number }>> {
    return new Promise<Array<{ host: string; port: number }>>((resolve) => {
      if (!this.dht) {
        resolve([]);
        return;
      }

      const peers: Array<{ host: string; port: number }> = [];
      let done = false;

      const onPeer = (peer: { host: string; port: number }, hash: Buffer): void => {
        if (hash.equals(infoHash)) {
          if (peer.port < 1 || peer.port > 65535) return;
          if (!this.config.allowPrivateIPs && !isPublicIP(peer.host)) return;
          peers.push({ host: peer.host, port: peer.port });
        }
      };

      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.dht?.off("peer", onPeer);
        resolve(peers);
      };

      this.dht.on("peer", onPeer);

      const timeout = setTimeout(() => {
        finish();
      }, this.config.operationTimeoutMs);

      this.dht.lookup(infoHash, () => {
        finish();
      });
    });
  }

  getNodeCount(): number {
    if (!this.dht) {
      return 0;
    }
    return this.dht.nodes.toArray().length;
  }

  getPort(): number {
    if (!this.dht) {
      return this.config.port;
    }
    try {
      const addr = this.dht.address();
      return addr?.port ?? this.config.port;
    } catch {
      return this.config.port;
    }
  }
}

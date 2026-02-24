import NatAPI from "@silentbot1/nat-api";
import { debugLog, debugWarn } from "../utils/debug.js";

export interface NatMapping {
  /** The internal port that was mapped. */
  internalPort: number;
  /** The external port on the router (usually same as internal). */
  externalPort: number;
  /** The external/public IP address. */
  externalIp: string;
  /** Protocol that was mapped. */
  protocol: "TCP" | "UDP";
}

export interface NatTraversalResult {
  /** Whether UPnP/NAT-PMP mapping succeeded. */
  success: boolean;
  /** External IP if discovered. */
  externalIp: string | null;
  /** Successfully created mappings. */
  mappings: NatMapping[];
}

/**
 * Automatic NAT traversal via UPnP and NAT-PMP.
 *
 * Requests port forwarding from the router so that inbound connections
 * from the internet can reach the seller's signaling port. This is
 * transparent to the caller — just call `mapPorts()` after binding
 * and `cleanup()` on shutdown.
 */
export class NatTraversal {
  private _nat: NatAPI | null = null;
  private _mappings: NatMapping[] = [];
  private _externalIp: string | null = null;
  private _destroyed = false;

  /**
   * Attempt to map the given ports via UPnP/NAT-PMP.
   *
   * @param ports - Array of { port, protocol } to map.
   * @param timeoutMs - How long to wait before giving up (default 10s).
   * @returns Result indicating success and discovered external IP.
   */
  async mapPorts(
    ports: Array<{ port: number; protocol: "TCP" | "UDP" }>,
    timeoutMs = 10_000,
  ): Promise<NatTraversalResult> {
    this._nat = new NatAPI({
      enablePMP: true,
      enableUPNP: true,
      description: "Antseed P2P",
      ttl: 7200,
    });

    const result: NatTraversalResult = {
      success: false,
      externalIp: null,
      mappings: [],
    };

    // Race against timeout
    try {
      await Promise.race([
        this._doMapping(ports, result),
        rejectAfter(timeoutMs, "NAT traversal timed out"),
      ]);
    } catch (err) {
      // Timeout or error — return partial result
      const msg = err instanceof Error ? err.message : String(err);
      debugWarn(`[NAT] ${msg}`);
    }

    this._mappings = result.mappings;
    this._externalIp = result.externalIp;
    result.success = result.mappings.length > 0;

    return result;
  }

  private async _doMapping(
    ports: Array<{ port: number; protocol: "TCP" | "UDP" }>,
    result: NatTraversalResult,
  ): Promise<void> {
    if (!this._nat) return;

    // Try to get external IP first
    try {
      const ip = await this._nat.externalIp();
      if (ip) {
        result.externalIp = ip;
        debugLog(`[NAT] External IP: ${ip}`);
      }
    } catch {
      debugWarn("[NAT] Could not determine external IP");
    }

    // Map each port
    for (const { port, protocol } of ports) {
      try {
        const mapped = await this._nat.map({
          publicPort: port,
          privatePort: port,
          protocol,
          description: `Antseed ${protocol}`,
        });

        if (mapped) {
          const mapping: NatMapping = {
            internalPort: port,
            externalPort: port,
            externalIp: result.externalIp ?? "",
            protocol,
          };
          result.mappings.push(mapping);
          debugLog(`[NAT] Mapped ${protocol} port ${port}`);
        } else {
          debugWarn(`[NAT] Failed to map ${protocol} port ${port}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugWarn(`[NAT] Error mapping ${protocol} port ${port}: ${msg}`);
      }
    }
  }

  /** The external IP discovered during mapping, if any. */
  get externalIp(): string | null {
    return this._externalIp;
  }

  /** All active port mappings. */
  get mappings(): readonly NatMapping[] {
    return this._mappings;
  }

  /** Remove all port mappings and clean up. */
  async cleanup(): Promise<void> {
    if (this._destroyed || !this._nat) return;
    this._destroyed = true;

    for (const m of this._mappings) {
      try {
        await this._nat.unmap({
          publicPort: m.externalPort,
          privatePort: m.internalPort,
          protocol: m.protocol,
        });
      } catch {
        // Best-effort cleanup
      }
    }

    try {
      await this._nat.destroy();
    } catch {
      // Best-effort cleanup
    }

    this._mappings = [];
    this._nat = null;
  }
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

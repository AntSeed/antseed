/** STUN/TURN server configuration. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Full ICE configuration for a peer connection. */
export interface IceConfig {
  iceServers: IceServer[];
  iceTransportPolicy?: "all" | "relay";
}

/** Returns a sensible default ICE configuration using public STUN servers. */
export function getDefaultIceConfig(): IceConfig {
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ],
    iceTransportPolicy: "all",
  };
}

/** Extract ICE candidate type from an SDP candidate string. */
export function extractCandidateType(
  candidate: string
): "host" | "srflx" | "prflx" | "relay" | "unknown" {
  const match = candidate.match(/typ\s+(host|srflx|prflx|relay)/);
  if (!match) return "unknown";
  return match[1] as "host" | "srflx" | "prflx" | "relay";
}

/**
 * Determine if TURN relay fallback is needed based on gathered candidates.
 * Returns true if no srflx (server-reflexive) candidates were gathered,
 * which typically indicates a symmetric NAT.
 */
export function needsTurnFallback(candidates: string[]): boolean {
  const types = candidates.map(extractCandidateType);
  const hasSrflx = types.includes("srflx");
  const hasRelay = types.includes("relay");
  // Need TURN if we have no server-reflexive candidates
  // (unless we already have relay candidates working)
  return !hasSrflx && !hasRelay;
}

/**
 * Build a complete ICE configuration, optionally adding TURN servers.
 * If turnServers are provided, they are appended to the default STUN servers.
 */
export function buildIceConfig(turnServers?: IceServer[]): IceConfig {
  const config = getDefaultIceConfig();
  if (turnServers && turnServers.length > 0) {
    config.iceServers.push(...turnServers);
  }
  return config;
}

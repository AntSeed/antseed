import type { Router } from '../interfaces/buyer-router.js';
import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest } from '../types/http.js';
import { computeOnChainReputationScore } from '../reputation/on-chain-reputation.js';
import {
  peerHasActiveSubstitutionFlag,
  peerHasModelVerificationWarning,
} from './verification-score.js';
import { extractServiceFromBody } from '../utils/json-codec.js';

export interface DefaultRouterConfig {
  minReputation?: number;  // Default: 0 (no reputation gate)
}

/**
 * Largest request body decoded to extract `service`/`model` for the
 * substitution gate. Larger bodies fall back to the '*' aggregate stats.
 */
const MAX_SERVICE_EXTRACTION_BODY_BYTES = 256 * 1024;
/** ASCII whitespace allowed before a JSON object's opening brace. */
const WHITESPACE_BYTES = new Set([0x20, 0x09, 0x0a, 0x0d]);

export class DefaultRouter implements Router {
  private _minReputation: number;
  private _latencyMap = new Map<string, number>();

  constructor(config?: DefaultRouterConfig) {
    this._minReputation = config?.minReputation ?? 0;
  }

  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    const nowMs = Date.now();
    // The requested service only feeds the substitution gate, and the gate
    // ignores peers without verification data — skip body decoding entirely
    // when no candidate carries any.
    const requestedService = peers.some((p) => p.modelVerification)
      ? this._extractRequestedService(req)
      : null;
    // Exclude (rather than merely deprioritize) sellers carrying a standing
    // model-substitution flag for the requested service — see
    // peerHasActiveSubstitutionFlag for the full rationale.
    const eligible = peers.filter((p) =>
      this._effectiveReputation(p) >= this._minReputation
      && !peerHasActiveSubstitutionFlag(p, requestedService, nowMs),
    );
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      const warningA = peerHasModelVerificationWarning(a, requestedService, nowMs) ? 1 : 0;
      const warningB = peerHasModelVerificationWarning(b, requestedService, nowMs) ? 1 : 0;
      if (warningA !== warningB) return warningA - warningB;
      const priceA = a.defaultInputUsdPerMillion ?? Infinity;
      const priceB = b.defaultInputUsdPerMillion ?? Infinity;
      if (priceA !== priceB) return priceA - priceB;
      // Prefer higher reputation scores (descending)
      const reputationA = this._effectiveReputation(a);
      const reputationB = this._effectiveReputation(b);
      if (reputationA !== reputationB) return reputationB - reputationA;
      const latA = this._latencyMap.get(a.peerId) ?? Infinity;
      const latB = this._latencyMap.get(b.peerId) ?? Infinity;
      return latA - latB;
    });

    return eligible[0] ?? null;
  }

  onResult(peer: PeerInfo, result: { success: boolean; latencyMs: number; tokens: number }): void {
    if (result.success) {
      const prev = this._latencyMap.get(peer.peerId) ?? result.latencyMs;
      this._latencyMap.set(peer.peerId, prev * 0.7 + result.latencyMs * 0.3);
    }
  }

  /**
   * Requested service/model from the JSON request body (`service` falling
   * back to `model`), normalized the way `modelVerification` keys are.
   */
  private _extractRequestedService(req: SerializedHttpRequest): string | null {
    if (req.body.length === 0 || req.body.length > MAX_SERVICE_EXTRACTION_BODY_BYTES) {
      // Oversized bodies skip per-service extraction rather than paying an
      // unbounded decode+parse on every routing decision; the substitution
      // gate still fires via the '*' aggregate, which is never below any
      // per-service count.
      return null;
    }
    // Cheap non-JSON precheck: a JSON object body starts with '{' after
    // optional whitespace — skip decoding binary/non-object payloads.
    let i = 0;
    while (i < req.body.length && WHITESPACE_BYTES.has(req.body[i]!)) i += 1;
    if (req.body[i] !== 0x7b /* '{' */) return null;
    const service = extractServiceFromBody(req.body);
    if (service === undefined || service.trim().length === 0) return null;
    return service.trim().toLowerCase();
  }

  private _effectiveReputation(peer: PeerInfo): number {
    const onChainScore = computeOnChainReputationScore(peer);
    if (onChainScore != null) {
      return onChainScore;
    }
    if (this._isFiniteNonNegative(peer.reputationScore)) {
      return peer.reputationScore;
    }
    return 0;
  }

  private _isFiniteNonNegative(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }
}

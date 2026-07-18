import type { Router } from '../interfaces/buyer-router.js';
import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest } from '../types/http.js';
import { computeOnChainReputationScore } from '../reputation/on-chain-reputation.js';
import { hasModelSubstitutionFlag, MODEL_VERIFICATION_MAX_AGE_MS } from './verification-score.js';
import { tryParseJsonObject } from '../utils/json-codec.js';

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
    const requestedService = this._extractRequestedService(req);
    const eligible = peers.filter((p) =>
      this._effectiveReputation(p) >= this._minReputation
      && !this._hasActiveSubstitutionFlag(p, requestedService),
    );
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
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
   * Exclude (rather than merely deprioritize) sellers carrying a standing
   * model-substitution flag for the requested service. A cheaper price is
   * meaningless when the product itself is in doubt: an active DIFF means at
   * least one approved verifier currently stands by evidence that the seller
   * served a different model than advertised. The exclusion is temporary by
   * construction — the flag lifts as soon as every accusing verifier retracts
   * (attests SAME again), at which point the peer re-enters the candidate set.
   * Peers with no verification data are unaffected (unknown ≠ known bad).
   *
   * The corroboration bar (how many distinct standing-DIFF verifiers exclude)
   * is NOT hardcoded here: enrichment stamps the chain-read points-policy
   * `minDistinctDiffVerifiers` onto each entry as `exclusionThreshold`, and
   * `hasModelSubstitutionFlag` consumes the stamp (offline fallback: 2).
   */
  private _hasActiveSubstitutionFlag(peer: PeerInfo, requestedService: string | null): boolean {
    const mv = peer.modelVerification;
    if (!mv) return false;
    // A flag older than the freshness bound is treated as absent: enrichment
    // stopped refreshing this peer (registry unconfigured, RPC down), so the
    // flag could never lift and would block the seller forever. A stamp-less
    // entry carries no age information and is honored as-is.
    const fetchedAt = peer.modelVerificationFetchedAt;
    if (typeof fetchedAt === 'number' && Number.isFinite(fetchedAt)
      && Date.now() - fetchedAt >= MODEL_VERIFICATION_MAX_AGE_MS) {
      return false;
    }
    if (requestedService) {
      const perService = mv[requestedService];
      if (perService) return hasModelSubstitutionFlag(perService);
    }
    // No per-service stats for this request — fall back to the agent-wide
    // aggregate so a flagged seller cannot dodge the gate by being probed
    // under a differently-keyed service name.
    return hasModelSubstitutionFlag(mv['*']);
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
    const body = tryParseJsonObject(req.body);
    const service = body?.['service'] ?? body?.['model'];
    if (typeof service !== 'string' || service.trim().length === 0) return null;
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

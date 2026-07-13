/**
 * Cross-seller consensus verification (cohort mode).
 *
 * No trusted reference is needed: N sellers claim the same model and are
 * probed with the same probe set. The majority behavior IS the reference;
 * statistical outliers are the liars.
 */

import type {
  CohortConsensus,
  CohortResult,
  CohortSellerStats,
  CohortSellerVerdict,
  FingerprintVerdict,
  KbfProbe,
  MatchEntry,
  MatchVector,
  SellerObservation,
} from './types.js';
import { matchesTolerance } from './verifiers/kbf/scoring.js';
import { binomialOneSidedPValue } from './verifiers/kbf/stats.js';

export interface CohortConsensusOptions {
  /** Minimum sellers in the winning cluster for a valid consensus. Default 3. */
  minConsensusSellers?: number;
  /**
   * Sink for non-fatal diagnostics — currently, observations dropped by the
   * one-vote-per-seller rule (see dedupeObservations). This library is pure
   * and never logs on its own; callers that want visibility into silently
   * discarded input (a CLI, a daemon logger) inject a logger here.
   */
  onWarning?: (message: string) => void;
}

export interface CohortVerdictOptions extends CohortConsensusOptions {
  /** One-sided binomial threshold for DIFF. Default 0.05. */
  alpha?: number;
  /** Minimum consensus-valid probes required to emit verdicts. Default 10. */
  minConsensusProbes?: number;
  /** Minimum per-seller parsed fraction of consensus probes. Default 0.5. */
  minCoverage?: number;
  /** Floor for the honest-error baseline p0. Default 0.02. */
  epsilon?: number;
}

const DEFAULT_MIN_CONSENSUS_SELLERS = 3;
const DEFAULT_ALPHA = 0.05;
const DEFAULT_MIN_CONSENSUS_PROBES = 10;
const DEFAULT_MIN_COVERAGE = 0.5;
const DEFAULT_EPSILON = 0.02;

/**
 * One observation (vote) per seller: repeated `sellerPeerId` (case-insensitive
 * — peer ids are EVM addresses) or `agentId` entries are dropped, first
 * occurrence wins. Without this a single seller could submit its observation
 * N times to fabricate consensus support and the minimum cohort size.
 *
 * NOTE the agentId rule also collapses DISTINCT peer ids that share an
 * agentId: the second peer's observation is silently discarded and it receives
 * no verdict entry. That is intentional — on-chain identity is the agentId, so
 * two peers claiming one agent are one voter at best and a vote-splitting
 * attempt at worst — but callers passing observations whose agentId was not
 * resolved from the chain (unlike the CLI, which resolves and filters) should
 * supply `onWarning` to surface the drop instead of losing it silently.
 */
function dedupeObservations(
  observations: readonly SellerObservation[],
  onWarning?: (message: string) => void,
): readonly SellerObservation[] {
  const seenPeers = new Set<string>();
  const seenAgents = new Set<number>();
  const unique: SellerObservation[] = [];
  for (const observation of observations) {
    const peerKey = observation.sellerPeerId.toLowerCase();
    if (seenPeers.has(peerKey)) {
      onWarning?.(
        `cohort: dropped duplicate observation for seller ${observation.sellerPeerId} ` +
          '(repeated sellerPeerId; one vote per seller, first occurrence wins)',
      );
      continue;
    }
    if (seenAgents.has(observation.agentId)) {
      onWarning?.(
        `cohort: dropped observation for seller ${observation.sellerPeerId} — ` +
          `agentId ${observation.agentId} was already used by an earlier observation ` +
          '(distinct sellers sharing an agentId collapse to one vote; first occurrence wins)',
      );
      continue;
    }
    seenPeers.add(peerKey);
    seenAgents.add(observation.agentId);
    unique.push(observation);
  }
  return unique;
}

function parseableAnswer(answer: number | null | undefined, probe: KbfProbe): number | null {
  if (answer === null || answer === undefined || !Number.isFinite(answer)) {
    return null;
  }
  const [lo, hi] = probe.range;
  if (answer < lo || answer > hi) {
    return null;
  }
  return answer;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) {
    throw new Error('median: empty input');
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Per-probe consensus: cluster the sellers' parseable in-range answers using
 * the probe's tolerance. The consensus value is the median of the largest
 * cluster.
 *
 * CONSISTENCY RULE — support is then RECOMPUTED as the answers within
 * tolerance of that emitted median (the exact predicate scoreAgainstConsensus
 * applies), and the strict-majority / `minConsensusSellers` gates run on the
 * recomputed support. A cluster can be wider than the tolerance around its own
 * median (e.g. answers {0,0,40,80,80,80} with abs-40 tolerance cluster fully
 * around candidate 40, but the median 60 only covers {40,80,80,80}), so gating
 * on raw cluster size would emit a value that some "supporters" then mismatch.
 * With this rule, `supportCounts[i]` always equals the number of cohort
 * sellers whose match vector entry for probe i is 1.
 *
 * Duplicate seller observations are deduplicated first — one vote per seller.
 *
 * Deterministic: candidate centers are evaluated in ascending value order and
 * ties keep the first (smallest) candidate.
 */
export function computeCohortConsensus(
  observations: readonly SellerObservation[],
  probes: readonly KbfProbe[],
  options: CohortConsensusOptions = {},
): CohortConsensus {
  const minConsensusSellers = options.minConsensusSellers ?? DEFAULT_MIN_CONSENSUS_SELLERS;
  const voters = dedupeObservations(observations, options.onWarning);

  const values: Array<number | null> = [];
  const supportCounts: number[] = [];
  const parseableCounts: number[] = [];
  const validProbeIndices: number[] = [];

  for (let probeIndex = 0; probeIndex < probes.length; probeIndex++) {
    const probe = probes[probeIndex]!;
    const parseable: number[] = [];
    for (const observation of voters) {
      const answer = parseableAnswer(observation.answers[probeIndex], probe);
      if (answer !== null) {
        parseable.push(answer);
      }
    }
    parseableCounts.push(parseable.length);

    if (parseable.length === 0) {
      values.push(null);
      supportCounts.push(0);
      continue;
    }

    // Evaluate each answer as a candidate cluster center: members are the
    // answers within the probe tolerance of the candidate.
    const sortedAnswers = [...parseable].sort((a, b) => a - b);
    let bestMembers: number[] = [];
    for (const candidate of sortedAnswers) {
      const centered: KbfProbe = { ...probe, consensus: candidate };
      const members = sortedAnswers.filter((answer) => matchesTolerance(answer, centered));
      if (members.length > bestMembers.length) {
        bestMembers = members;
      }
    }

    // Emit the cluster median, then recompute support against the EMITTED
    // value so support, majority gating, and later match scoring all use the
    // same predicate (see the consistency rule in the function doc).
    const consensusValue = median(bestMembers);
    const emitted: KbfProbe = { ...probe, consensus: consensusValue };
    const support = sortedAnswers.filter((answer) => matchesTolerance(answer, emitted)).length;
    const strictMajority = support * 2 > parseable.length;
    if (!strictMajority || support < minConsensusSellers) {
      values.push(null);
      supportCounts.push(support);
      continue;
    }

    values.push(consensusValue);
    supportCounts.push(support);
    validProbeIndices.push(probeIndex);
  }

  return { values, supportCounts, parseableCounts, validProbeIndices };
}

/**
 * Score one seller against the cohort consensus, over consensus-valid probes
 * only. Returns a match vector of length `consensus.validProbeIndices.length`.
 */
export function scoreAgainstConsensus(
  observation: SellerObservation,
  consensus: CohortConsensus,
  probes: readonly KbfProbe[],
): MatchVector {
  return consensus.validProbeIndices.map((probeIndex): MatchEntry => {
    const probe = probes[probeIndex]!;
    const consensusValue = consensus.values[probeIndex];
    if (consensusValue === null || consensusValue === undefined) {
      return null;
    }
    const answer = parseableAnswer(observation.answers[probeIndex], probe);
    if (answer === null) {
      return null;
    }
    const centered: KbfProbe = { ...probe, consensus: consensusValue };
    return matchesTolerance(answer, centered) ? 1 : 0;
  });
}

function undeterminedSeller(
  observation: SellerObservation,
  reason: string,
  matchVector: MatchVector,
  stats: Partial<CohortSellerStats> & Pick<CohortSellerStats, 'total' | 'parsed' | 'coverage'>,
): CohortSellerVerdict {
  return {
    sellerPeerId: observation.sellerPeerId,
    agentId: observation.agentId,
    verdict: 'UNDETERMINED',
    verdictReason: reason,
    stats: {
      matches: stats.matches ?? 0,
      mismatches: stats.mismatches ?? 0,
      agreementRate: stats.agreementRate ?? null,
      mismatchRate: stats.mismatchRate ?? null,
      p0: null,
      pValue: null,
      total: stats.total,
      parsed: stats.parsed,
      coverage: stats.coverage,
    },
    matchVector,
  };
}

/**
 * Compute per-seller cohort verdicts.
 *
 * Duplicate observations (repeated sellerPeerId or agentId) are dropped before
 * any gate — first occurrence wins, and only unique sellers receive a verdict
 * entry — so one seller can neither vote twice nor pad the cohort size. Each
 * drop is reported through `options.onWarning` when supplied (see
 * dedupeObservations for the distinct-sellers-sharing-an-agentId caveat).
 *
 * Gates:
 * - fewer than 3 unique sellers → every seller is UNDETERMINED (no consensus
 *   basis);
 * - fewer than `minConsensusProbes` consensus-valid probes → all UNDETERMINED;
 * - seller coverage below `minCoverage` → that seller is UNDETERMINED.
 *
 * Test: p0 = max(median per-seller mismatch rate, epsilon) as the honest-error
 * baseline; a one-sided binomial test of each seller's mismatch count against
 * p0 yields DIFF (pValue < alpha) or SAME.
 */
export function computeCohortVerdicts(
  allObservations: readonly SellerObservation[],
  probes: readonly KbfProbe[],
  options: CohortVerdictOptions = {},
): CohortResult {
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const minConsensusProbes = options.minConsensusProbes ?? DEFAULT_MIN_CONSENSUS_PROBES;
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const minConsensusSellers = options.minConsensusSellers ?? DEFAULT_MIN_CONSENSUS_SELLERS;

  // Warnings surface here only: the inner computeCohortConsensus call receives
  // the already-unique list, so its own dedupe pass can never drop (or warn)
  // again.
  const observations = dedupeObservations(allObservations, options.onWarning);

  const emptyResult = (reason: string, consensusProbeCount: number): CohortResult => {
    const verdicts = observations.map((observation) =>
      undeterminedSeller(observation, reason, [], { total: 0, parsed: 0, coverage: 0 }),
    );
    return {
      probeCount: probes.length,
      consensusProbeCount,
      p0: null,
      perSellerAgreementRate: Object.fromEntries(
        observations.map((o) => [o.sellerPeerId, null]),
      ),
      verdicts,
    };
  };

  // Degenerate cohort: 1-2 sellers cannot outvote each other.
  if (observations.length < 3) {
    return emptyResult(`cohort of ${observations.length} sellers is too small`, 0);
  }

  const consensus = computeCohortConsensus(observations, probes, { minConsensusSellers });
  const consensusProbeCount = consensus.validProbeIndices.length;
  if (consensusProbeCount < minConsensusProbes) {
    return emptyResult(
      `only ${consensusProbeCount} consensus probes (minimum ${minConsensusProbes})`,
      consensusProbeCount,
    );
  }

  interface SellerScore {
    observation: SellerObservation;
    matchVector: MatchVector;
    parsed: number;
    matches: number;
    mismatches: number;
    coverage: number;
    passesCoverage: boolean;
  }

  const scores: SellerScore[] = observations.map((observation) => {
    const matchVector = scoreAgainstConsensus(observation, consensus, probes);
    let parsed = 0;
    let matches = 0;
    let mismatches = 0;
    for (const entry of matchVector) {
      if (entry === null) continue;
      parsed += 1;
      if (entry === 1) matches += 1;
      else mismatches += 1;
    }
    const coverage = consensusProbeCount > 0 ? parsed / consensusProbeCount : 0;
    return {
      observation,
      matchVector,
      parsed,
      matches,
      mismatches,
      coverage,
      passesCoverage: coverage >= minCoverage && parsed > 0,
    };
  });

  // Honest-error baseline: median per-seller mismatch rate, floored at epsilon.
  const mismatchRates = scores
    .filter((s) => s.passesCoverage)
    .map((s) => s.mismatches / s.parsed)
    .sort((a, b) => a - b);
  const p0 = mismatchRates.length > 0 ? Math.max(median(mismatchRates), epsilon) : null;

  const verdicts: CohortSellerVerdict[] = scores.map((score) => {
    const { observation } = score;
    const agreementRate = score.parsed > 0 ? score.matches / score.parsed : null;
    const mismatchRate = score.parsed > 0 ? score.mismatches / score.parsed : null;

    if (!score.passesCoverage) {
      return undeterminedSeller(
        observation,
        `coverage ${score.coverage.toFixed(4)} below minimum ${minCoverage}`,
        score.matchVector,
        {
          total: consensusProbeCount,
          parsed: score.parsed,
          coverage: score.coverage,
          matches: score.matches,
          mismatches: score.mismatches,
          agreementRate,
          mismatchRate,
        },
      );
    }
    if (p0 === null) {
      return undeterminedSeller(observation, 'no honest-error baseline', score.matchVector, {
        total: consensusProbeCount,
        parsed: score.parsed,
        coverage: score.coverage,
        matches: score.matches,
        mismatches: score.mismatches,
        agreementRate,
        mismatchRate,
      });
    }

    const pValue = binomialOneSidedPValue(score.mismatches, score.parsed, p0);
    const verdict: FingerprintVerdict = pValue < alpha ? 'DIFF' : 'SAME';
    const stats: CohortSellerStats = {
      total: consensusProbeCount,
      parsed: score.parsed,
      coverage: score.coverage,
      matches: score.matches,
      mismatches: score.mismatches,
      agreementRate,
      mismatchRate,
      p0,
      pValue,
    };
    return {
      sellerPeerId: observation.sellerPeerId,
      agentId: observation.agentId,
      verdict,
      verdictReason:
        verdict === 'DIFF'
          ? `binomial p-value ${pValue.toExponential(4)} below alpha ${alpha}`
          : null,
      stats,
      matchVector: score.matchVector,
    };
  });

  return {
    probeCount: probes.length,
    consensusProbeCount,
    p0,
    perSellerAgreementRate: Object.fromEntries(
      verdicts.map((v) => [v.sellerPeerId, v.stats.agreementRate]),
    ),
    verdicts,
  };
}

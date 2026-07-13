/**
 * Shared schema types for the AntSeed fingerprint verifier suite.
 * See docs/protocol/spec/07-model-verification.md.
 */

import { canonicalHash, canonicalHashBytes32 } from './canonical-json.js';

export const FINGERPRINTS_PACKAGE_NAME = '@antseed/fingerprints';
export const FINGERPRINTS_PACKAGE_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type FingerprintVerdict = 'SAME' | 'DIFF' | 'UNDETERMINED' | 'UNKNOWN';

/**
 * FROZEN on-chain enum mapping (matches the Solidity contract):
 * UNKNOWN=0, SAME=1, DIFF=2, UNDETERMINED=3.
 */
const VERDICT_CODES: Record<FingerprintVerdict, number> = {
  UNKNOWN: 0,
  SAME: 1,
  DIFF: 2,
  UNDETERMINED: 3,
};

const CODE_VERDICTS: Record<number, FingerprintVerdict> = {
  0: 'UNKNOWN',
  1: 'SAME',
  2: 'DIFF',
  3: 'UNDETERMINED',
};

export function verdictToCode(verdict: FingerprintVerdict): number {
  const code = VERDICT_CODES[verdict];
  if (code === undefined) {
    throw new Error(`verdictToCode: unknown verdict "${verdict}"`);
  }
  return code;
}

export function verdictFromCode(code: number): FingerprintVerdict {
  const verdict = CODE_VERDICTS[code];
  if (verdict === undefined) {
    throw new Error(`verdictFromCode: unknown verdict code ${code}`);
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export type ToleranceMode = 'absolute' | 'relative';

export interface ProbeTolerance {
  mode: ToleranceMode;
  value: number;
}

/**
 * A single KBF numeric cloze probe. `consensus` is the expected answer;
 * in cohort mode it is advisory only (ground truth comes from the cohort).
 * Unknown extension fields (e.g. `contrast`, `consensusRaw`) are preserved.
 */
export interface KbfProbe {
  id: string;
  name: string;
  domain: string;
  /** Cloze template containing `___` (and optionally `{name}`). */
  template: string;
  consensus: number;
  range: [number, number];
  tolerance: ProbeTolerance;
  /** Optional contrast-model metadata, preserved verbatim. */
  contrast?: Record<string, unknown>;
  [extension: string]: unknown;
}

// ---------------------------------------------------------------------------
// Fingerprint reference envelope
// ---------------------------------------------------------------------------

export interface ReferenceGenerator {
  name: string;
  version: string;
  verifierKind: string;
  params: Record<string, unknown>;
  [extension: string]: unknown;
}

export interface ReferenceProvenance {
  license?: string;
  url?: string;
  commit?: string;
  [extension: string]: unknown;
}

export interface ReferenceSelfTest {
  /** Mismatch count of the reference model against its own probe set. */
  hamming: number;
  total: number;
  coverage: number;
  errorRate: number;
  [extension: string]: unknown;
}

/**
 * Common reference envelope shared by all verifier kinds
 * (spec 07 "Reference Schema"). Unknown extension fields are preserved.
 */
export interface FingerprintReference {
  version: number;
  kind: string;
  referenceId: string;
  referenceModel: string;
  serviceAliases: string[];
  createdAt: string;
  source: 'public' | 'generated' | 'imported';
  generator: ReferenceGenerator;
  provenance?: ReferenceProvenance;
  selfTest: ReferenceSelfTest;
  probes: KbfProbe[];
  [extension: string]: unknown;
}

/**
 * Content-addressed reference id: canonical hash over the reference minus
 * `referenceId` itself and any caller-declared local-only fields
 * (e.g. local filesystem paths, which MUST NOT be hashed).
 */
export function computeReferenceId(
  reference: FingerprintReference | Record<string, unknown>,
  localOnlyFields: string[] = [],
): string {
  const copy: Record<string, unknown> = { ...(reference as Record<string, unknown>) };
  delete copy['referenceId'];
  for (const field of localOnlyFields) {
    delete copy[field];
  }
  return canonicalHash(copy);
}

// ---------------------------------------------------------------------------
// Probe sets (verifier-generated, committed on-chain pre-audit)
// ---------------------------------------------------------------------------

export interface ProbeSet {
  probeSetId: string;
  service: string;
  probes: KbfProbe[];
  nonce: string;
  createdAt: string;
}

/**
 * Order-sensitive content id over `{ service, probes }` — the COMPLETE probe
 * definitions, not just ids. Every scoring-relevant field (template, consensus,
 * range, tolerance, extensions) is bound, so two sets that would score answers
 * differently can never share an id.
 */
export function computeProbeSetId(service: string, probes: readonly KbfProbe[]): string {
  return canonicalHash({ service, probes });
}

/**
 * On-chain pre-audit commitment (bytes32): a standard hash commitment
 * `commit = SHA-256(canonicalJson({service, probes, nonce}))` over the FULL
 * ordered probe definitions. Binding the complete content (not merely probe
 * ids) is what stops a verifier from committing, observing responses, and then
 * tightening `tolerance` or altering `consensus`/`range`/`template` while the
 * commitment still verifies. Binding comes from SHA-256 collision resistance;
 * hiding from the 256-bit HKDF-derived nonce. Opened (probe set + nonce
 * revealed) only after responses, so a verifier cannot cherry-pick or reshape
 * probes after seeing answers.
 */
export function computeProbeCommitment(
  probeSet: Pick<ProbeSet, 'service' | 'probes' | 'nonce'>,
): string {
  return canonicalHashBytes32({
    service: probeSet.service,
    probes: probeSet.probes,
    nonce: probeSet.nonce,
  });
}

// ---------------------------------------------------------------------------
// Match vectors and observations
// ---------------------------------------------------------------------------

/** Per-probe outcome: 1 match, 0 mismatch, null unparseable. */
export type MatchEntry = 1 | 0 | null;
export type MatchVector = MatchEntry[];

/** Runtime guard: exactly 1, 0, or null — arbitrary truthy values are NOT matches. */
export function isMatchEntry(value: unknown): value is MatchEntry {
  return value === 1 || value === 0 || value === null;
}

/**
 * Runtime guard for match vectors crossing the public API boundary
 * (e.g. `SellerObservation.matchVector` supplied by a caller rather than
 * derived via `computeMatchVector`).
 */
export function isMatchVector(value: unknown): value is MatchVector {
  return Array.isArray(value) && value.every(isMatchEntry);
}

export interface ResponseAuthHashes {
  requestHash: string;
  responseHash: string;
}

/** One seller's observed answers to a probe set. */
export interface SellerObservation {
  sellerPeerId: string;
  agentId: number;
  /** Parsed numeric answers, position-aligned with the probe set. */
  answers: Array<number | null>;
  /** Optional precomputed match vector (otherwise derived from answers). */
  matchVector?: MatchVector;
  requestIds: string[];
  responseAuthHashes?: ResponseAuthHashes[];
}

// ---------------------------------------------------------------------------
// Audit results (spec 07 "Audit Result Schema")
// ---------------------------------------------------------------------------

export interface AuditVerifierInfo {
  kind: string;
  package: string;
  version: string;
}

export interface AuditStats {
  selfHamming: number;
  selfTotal: number;
  targetHamming: number | null;
  targetTotal: number | null;
  selfCoverage: number;
  targetCoverage: number | null;
  p0Cp99: number | null;
  pValueBinomial: number | null;
}

export interface AuditSampleRef {
  batchId: string;
  requestId: string;
  sampleId: string;
  responseAuthRequestHash?: string;
  responseAuthResponseHash?: string;
}

export interface AuditResult {
  version: 1;
  auditId: string;
  verifier: AuditVerifierInfo;
  sellerPeerId: string;
  advertisedService: string;
  referenceId: string;
  referenceModel: string;
  startedAt: string;
  completedAt: string;
  probeCount: number;
  authenticatedProbeCount: number;
  parsedProbeCount: number;
  matchVectorHash: string;
  stats: AuditStats;
  verdict: FingerprintVerdict;
  verdictReason: string | null;
  samples: AuditSampleRef[];
  /** Optional cross-seller consensus block (cohort mode). */
  cohort?: CohortResult;
}

/**
 * Content-addressed audit id: canonical hash over the audit result excluding
 * `auditId` itself and any local-only fields (e.g. filesystem paths).
 */
export function computeAuditId(
  result: Omit<AuditResult, 'auditId'> & { auditId?: string },
  localOnlyFields: string[] = [],
): string {
  const copy: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  delete copy['auditId'];
  for (const field of localOnlyFields) {
    delete copy[field];
  }
  return canonicalHash(copy);
}

/**
 * The portion of an AuditResult a pure verifier can produce without runtime
 * context (seller selection, timestamps, transport samples).
 */
export interface AuditResultFragment {
  verifier: AuditVerifierInfo;
  referenceId: string;
  referenceModel: string;
  probeCount: number;
  parsedProbeCount: number;
  matchVector: MatchVector;
  matchVectorHash: string;
  stats: AuditStats;
  verdict: FingerprintVerdict;
  verdictReason: string | null;
}

// ---------------------------------------------------------------------------
// Cohort verification result types
// ---------------------------------------------------------------------------

export interface CohortSellerStats {
  /** Consensus-valid probes scored for this seller. */
  total: number;
  /** Parseable (non-null) entries in the seller's consensus match vector. */
  parsed: number;
  coverage: number;
  matches: number;
  mismatches: number;
  agreementRate: number | null;
  mismatchRate: number | null;
  p0: number | null;
  pValue: number | null;
}

export interface CohortSellerVerdict {
  sellerPeerId: string;
  agentId: number;
  verdict: FingerprintVerdict;
  verdictReason: string | null;
  stats: CohortSellerStats;
  /** Match vector over consensus-valid probes only. */
  matchVector: MatchVector;
}

export interface CohortResult {
  /** Total probes in the probe set. */
  probeCount: number;
  /** Probes where a valid cohort consensus formed. */
  consensusProbeCount: number;
  /** Honest-error baseline used for the binomial test (null if none). */
  p0: number | null;
  perSellerAgreementRate: Record<string, number | null>;
  verdicts: CohortSellerVerdict[];
}

/** Per-probe cohort consensus. */
export interface CohortConsensus {
  /** Consensus value per probe; null when no valid consensus formed. */
  values: Array<number | null>;
  /** Size of the winning cluster per probe. */
  supportCounts: number[];
  /** Sellers with a parseable, in-range answer per probe. */
  parseableCounts: number[];
  /** Indices of probes with a non-null consensus value. */
  validProbeIndices: number[];
}

// ---------------------------------------------------------------------------
// Evidence bundle (committed on-chain via evidenceHash)
// ---------------------------------------------------------------------------

export interface EvidenceSeller extends SellerObservation {
  verdict: FingerprintVerdict;
  stats: CohortSellerStats;
}

export interface EvidenceBundle {
  version: 1;
  service: string;
  verifierAddress: string;
  probeSet: ProbeSet;
  sellers: EvidenceSeller[];
  cohort?: CohortResult;
  createdAt: string;
}

/**
 * bytes32 hash the on-chain attestation's evidenceHash commits to.
 */
export function computeEvidenceHash(bundle: EvidenceBundle): string {
  return canonicalHashBytes32(bundle);
}

import type { ExchangeRecord } from '@antseed/node'
import { computeBatchRoot, verifyResponseAuth } from '@antseed/node'
import type {
  CohortVerdictOptions,
  EvidenceBundle,
  EvidenceProbeExchange,
  FingerprintVerdict,
  ProbeSet,
  SellerObservation,
  StealthRequestPlan,
} from '@antseed/fingerprints'
import {
  buildStealthChatRequests,
  computeCohortVerdicts,
  computeEvidenceHash,
  computeKbfVerdict,
  computeMatchVector,
  sha256Hex,
  verdictFromCode,
} from '@antseed/fingerprints'
import { canonicalProbeSetJson } from './pack-writer.js'
import { combineVerdicts } from './audit-runner.js'
import { scatterPlanAnswers } from './probing.js'

/**
 * Audit recomputation (`antseed audit verify` core) — the "re-run it
 * yourself" half of the transparent-audit flow. Everything here is pure: chain
 * data (anchor calldata, revealed probe bytes, attestations) and the
 * published pack come in as inputs, and every claim the verifier made is
 * recomputed from them:
 *
 * 1. the anchored Merkle root binds exactly the anchored exchange records;
 * 2. the revealed probe bytes open the pre-audit commitment (sha256);
 * 3. the pack's probe set IS the revealed one, and the pack's canonical hash
 *    IS the attested evidenceHash;
 * 4. every seller ResponseAuth signature verifies against the pack's exact
 *    request/response bytes, and every verified exchange is anchored;
 * 5. the stealth request plans are re-derived from the revealed probe set,
 *    answers are re-extracted from the response plaintexts, and the cohort
 *    verdicts are re-graded with the same math;
 * 6. recomputed verdicts are compared against the on-chain attestations.
 */

export interface AuditCheck {
  name: string
  ok: boolean
  detail: string
}

export interface OnChainAttestation {
  verdict: number
  probeCommitment: string
  evidenceHash: string
  batchRoot: string
}

export interface SellerRecheck {
  sellerPeerId: string
  agentId: number
  /** Combined verdict recorded in the pack (what was attested on-chain). */
  packVerdict: FingerprintVerdict
  /** Cohort verdict re-graded here from re-extracted answers. */
  recomputedCohortVerdict: FingerprintVerdict | null
  /** Reference verdict recomputed here (reference mode only; else null). */
  recomputedReferenceVerdict: FingerprintVerdict | null
  /**
   * combineVerdicts(recomputedCohort, recomputedReference) — the verdict the
   * pack's own data actually supports. It must EQUAL packVerdict, or the
   * verdict was fabricated (e.g. a DIFF with no reference and a recomputed
   * cohort of SAME).
   */
  recomputedVerdict: FingerprintVerdict | null
  /** Every non-null ResponseAuth in the pack verifies against its bytes. */
  responseAuthsValid: boolean
  /** Every verified exchange appears in the anchored batch. */
  anchored: boolean
  /** Re-extracted answers equal the pack's recorded answers. */
  answersMatch: boolean
  /**
   * Soft signal (not a hard failure): the seller's anchored exchange count is
   * below probeCount × minCoverage, i.e. only a cherry-picked subset of its
   * traffic was anchored — a possible framing/selective-anchoring attempt.
   * (Full fix — a seller-cosigned session receipt enumerating the exchange
   * count, contract-enforced — is a documented fast-follow.)
   */
  suspiciousAnchorSubset: boolean
  /**
   * Soft signal: a SAME verdict corroborated by a single delegate carrier
   * (weak stealth — a lone accomplice could have served the real model only to
   * itself). Only meaningful when the pack records carrierCount.
   */
  singleCarrierSame: boolean
  /** On-chain attestation for this published audit, when supplied. */
  onChainVerdict: FingerprintVerdict | null
  /** 'match' | 'mismatch' | 'absent' | 'superseded' | 'unchecked' */
  attestationStatus: 'match' | 'mismatch' | 'absent' | 'superseded' | 'unchecked'
  ok: boolean
}

export interface AuditVerifyInput {
  probeCommitment: string
  /** ExchangeRecord[] decoded from the anchor tx calldata. */
  records: ExchangeRecord[]
  /** Batch root stored/emitted on-chain for this anchor. */
  onChainBatchRoot: string
  /** Exact probe-set JSON bytes revealed on-chain (utf8-decoded). */
  revealedProbeSetJson: string
  /** Published audit pack; without it only the chain-side checks run. */
  pack?: EvidenceBundle
  /**
   * `computeEvidenceHash(pack)`, when the caller already computed it (the CLI
   * does, to look up matching attestations). Purely an optimization — absent,
   * it is computed here; a caller must never pass anything else.
   */
  packEvidenceHash?: string
  /** agentId → historical on-chain attestation matching this audit. */
  attestations?: ReadonlyMap<number, OnChainAttestation>
}

export interface AuditVerifyReport {
  checks: AuditCheck[]
  sellers: SellerRecheck[]
  ok: boolean
}

function hex(value: string): string {
  return value.toLowerCase()
}

/**
 * ResponseAuth signatures are unprefixed hex in pack payloads but 0x-prefixed
 * `bytes` in anchor calldata — normalize both for comparison.
 */
function sigKey(signature: string): string {
  return hex(signature).replace(/^0x/, '')
}

interface ParsedRequestBody {
  model?: string
  messages?: unknown
}

function parseExchangeBody(exchange: EvidenceProbeExchange): ParsedRequestBody | null {
  try {
    return JSON.parse(Buffer.from(exchange.request.bodyBase64, 'base64').toString('utf8')) as ParsedRequestBody
  } catch {
    return null
  }
}

/**
 * Re-derive the stealth request plans from the revealed probe set. The plans
 * are a pure function of (probeSet, maxProbesPerRequest); the pack publishes
 * the bundling factor (not secret post-reveal), so the plans are reproduced
 * with that exact value and cross-checked against the pack's request bodies.
 * Null when the reproduced messages don't match (a tampered pack).
 */
export function reconstructStealthPlans(
  probeSet: ProbeSet,
  exchanges: readonly EvidenceProbeExchange[],
  maxProbesPerRequest: number,
): StealthRequestPlan[] | null {
  if (exchanges.length === 0) return null
  const bodies = exchanges.map((e) => parseExchangeBody(e))
  if (bodies.some((b) => b === null)) return null
  const wantMessages = bodies.map((b) => JSON.stringify(b!.messages))
  const model = bodies[0]!.model ?? probeSet.service

  const plans = buildStealthChatRequests(model, probeSet, { maxProbesPerRequest })
  if (plans.length !== exchanges.length) return null
  if (!plans.every((plan, i) => JSON.stringify(plan.body.messages) === wantMessages[i])) return null
  return plans
}

/**
 * Re-extract one seller's answers from its response plaintexts using the
 * re-derived plans — the same extraction path the verifier ran.
 */
export function reextractAnswers(
  plans: readonly StealthRequestPlan[],
  exchanges: readonly EvidenceProbeExchange[],
  probeCount: number,
): Array<number | null> {
  const answers: Array<number | null> = new Array<number | null>(probeCount).fill(null)
  plans.forEach((plan, i) => {
    const exchange = exchanges[i]
    if (!exchange?.response || exchange.response.statusCode !== 200) return
    scatterPlanAnswers(new Uint8Array(Buffer.from(exchange.response.bodyBase64, 'base64')), plan, answers)
  })
  return answers
}

function sameAnswers(a: readonly (number | null)[], b: readonly (number | null)[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, i) => Object.is(value, b[i]))
}

/** Verify one pack exchange's ResponseAuth against its exact bytes. */
function exchangeAuthValid(sellerPeerId: string, exchange: EvidenceProbeExchange): boolean {
  const auth = exchange.responseAuth
  if (!auth || !exchange.response) return false
  const verification = verifyResponseAuth(auth, {
    request: {
      requestId: exchange.requestId,
      method: exchange.request.method,
      path: exchange.request.path,
      headers: exchange.request.headers,
      body: new Uint8Array(Buffer.from(exchange.request.bodyBase64, 'base64')),
    },
    response: {
      requestId: exchange.requestId,
      statusCode: exchange.response.statusCode,
      headers: exchange.response.headers,
      body: new Uint8Array(Buffer.from(exchange.response.bodyBase64, 'base64')),
    },
    buyerPeerId: auth.buyerPeerId,
    sellerPeerId,
    advertisedService: auth.advertisedService,
  })
  return verification.valid
}

export function verifyAudit(input: AuditVerifyInput): AuditVerifyReport {
  const checks: AuditCheck[] = []
  const sellers: SellerRecheck[] = []
  const commitment = hex(input.probeCommitment)

  // 1. Anchored batch root binds exactly the anchored records.
  let recomputedRoot: string | null = null
  try {
    recomputedRoot = input.records.length > 0 ? computeBatchRoot(input.records) : null
  } catch {
    recomputedRoot = null
  }
  checks.push({
    name: 'batch root',
    ok: recomputedRoot !== null && hex(recomputedRoot) === hex(input.onChainBatchRoot),
    detail: recomputedRoot === null
      ? `could not recompute a root from ${input.records.length} record(s)`
      : `recomputed ${recomputedRoot} vs on-chain ${input.onChainBatchRoot} (${input.records.length} record(s))`,
  })

  // 2. Revealed bytes open the pre-audit commitment.
  const revealedHash = `0x${sha256Hex(input.revealedProbeSetJson)}`
  checks.push({
    name: 'commitment opening',
    ok: hex(revealedHash) === commitment,
    detail: `sha256(revealed bytes) ${revealedHash} vs commitment ${input.probeCommitment}`,
  })

  // 3. Revealed bytes parse into a well-formed probe set.
  let revealedProbeSet: Pick<ProbeSet, 'service' | 'probes' | 'nonce'> | null = null
  try {
    const parsed = JSON.parse(input.revealedProbeSetJson) as Record<string, unknown>
    if (
      parsed !== null && typeof parsed === 'object' &&
      typeof parsed['service'] === 'string' &&
      Array.isArray(parsed['probes']) &&
      typeof parsed['nonce'] === 'string'
    ) {
      revealedProbeSet = parsed as unknown as Pick<ProbeSet, 'service' | 'probes' | 'nonce'>
    }
  } catch {
    revealedProbeSet = null
  }
  checks.push({
    name: 'revealed probe set shape',
    ok: revealedProbeSet !== null,
    detail: revealedProbeSet
      ? `service "${revealedProbeSet.service}", ${revealedProbeSet.probes.length} probe(s)`
      : 'revealed bytes are not a {service, probes, nonce} JSON object',
  })

  const pack = input.pack
  if (!pack) {
    return { checks, sellers, ok: checks.every((c) => c.ok) }
  }

  // 4. The pack's probe set IS the revealed one (byte-exact canonical JSON).
  checks.push({
    name: 'pack probe set matches reveal',
    ok: canonicalProbeSetJson(pack.probeSet) === input.revealedProbeSetJson,
    detail: 'canonical JSON of pack.probeSet vs revealed bytes',
  })

  const packEvidenceHash = input.packEvidenceHash ?? computeEvidenceHash(pack)

  // Anchored record lookup: agentId:requestHash:responseHash:sig.
  const anchoredKeys = new Set(
    input.records.map((r) =>
      `${BigInt(r.agentId)}:${hex(r.requestHash)}:${hex(r.responseHash)}:${sigKey(r.responseAuthSig)}`),
  )

  // 5. Every anchored record must be backed by a pack exchange (no padding
  //    the batch with fabricated records) — collected while walking sellers.
  const packKeys = new Set<string>()

  // Plans are identical for every seller (same probe set + bundling factor);
  // reconstruct from the first seller that has exchange material, using the
  // pack's published `maxProbesPerRequest` (not a brute-force guess).
  const maxProbesPerRequest = pack.maxProbesPerRequest
  // Reconstruct from the FULLEST seller: a seller carrying only a subset (the
  // selective-anchoring case) has fewer exchanges than plans and would fail the
  // length check; a fully-participating seller has exactly one exchange per plan.
  const planExchanges = pack.sellers
    .map((s) => s.exchanges ?? [])
    .reduce((best, cur) => (cur.length > best.length ? cur : best), [] as EvidenceProbeExchange[])
  const plans = reconstructStealthPlans(pack.probeSet as ProbeSet, planExchanges, maxProbesPerRequest)
  checks.push({
    name: 'stealth plans reconstructed',
    ok: plans !== null || planExchanges.length === 0,
    detail: plans
      ? `${plans.length} request plan(s) re-derived at maxProbesPerRequest=${maxProbesPerRequest}`
      : planExchanges.length === 0
        ? 'pack holds no exchanges to re-derive plans from'
        : `pack request bodies don't reproduce from the revealed probe set at maxProbesPerRequest=${maxProbesPerRequest}`,
  })

  const probeCount = pack.probeSet.probes.length
  // Effective grading options the auditor persisted — re-grade with THESE, not
  // library defaults (which would be faithful only by coincidence).
  const cohortOptions: CohortVerdictOptions = pack.cohortOptions ?? {}
  const minCoverage = pack.cohortOptions?.minCoverage ?? 0.5
  // Reference mode iff the pack carries the reference self-test.
  const referenceSelfTest = pack.reference?.selfTest ?? null

  // Map a request's exact messages → the probe indices that request covers, so
  // a seller's exchanges can be aligned to plans by CONTENT (robust to a seller
  // carrying only a subset of the plans — the selective-anchoring case).
  const probeIndicesByMessages = new Map<string, number[]>()
  if (plans) {
    for (const plan of plans) probeIndicesByMessages.set(JSON.stringify(plan.body.messages), plan.probeIndices)
  }
  const coveredProbeIndices = (exchange: EvidenceProbeExchange): number[] => {
    const body = parseExchangeBody(exchange)
    if (!body) return []
    return probeIndicesByMessages.get(JSON.stringify(body.messages)) ?? []
  }

  const observations: SellerObservation[] = []
  interface PerSeller {
    sellerPeerId: string
    agentId: number
    packVerdict: FingerprintVerdict
    responseAuthsValid: boolean
    anchored: boolean
    answersMatch: boolean
    answers: Array<number | null> | null
    carrierCount: number | undefined
    suspiciousAnchorSubset: boolean
    fullyAuthenticated: boolean | undefined
  }
  const perSeller: PerSeller[] = []

  for (const seller of pack.sellers) {
    const exchanges = seller.exchanges ?? []
    let responseAuthsValid = true
    let anchored = true
    // Probes covered by ANCHORED exchanges (cherry-pick detection): align each
    // exchange to its plan by request content (not index), so a seller carrying
    // only a subset still reports the right coverage.
    const anchoredProbeIndices = new Set<number>()
    for (const exchange of exchanges) {
      if (!exchange.responseAuth) continue
      if (!exchangeAuthValid(seller.sellerPeerId, exchange)) responseAuthsValid = false
      const key = `${BigInt(seller.agentId)}:${hex(exchange.responseAuth.requestHash)}:${hex(exchange.responseAuth.responseHash)}:${sigKey(exchange.responseAuth.signature)}`
      packKeys.add(key)
      if (anchoredKeys.has(key)) {
        for (const idx of coveredProbeIndices(exchange)) anchoredProbeIndices.add(idx)
      } else {
        anchored = false
      }
    }

    // Re-extract this seller's answers from the response plaintexts. A seller
    // whose probe execution failed entirely (no exchanges) legitimately has
    // all-null answers — nothing to re-extract, nothing to mismatch.
    let answersMatch = false
    let answers: Array<number | null> | null = null
    if (exchanges.length === 0) {
      answers = new Array<number | null>(probeCount).fill(null)
      answersMatch = sameAnswers(answers, seller.answers)
    } else if (plans && exchanges.length === plans.length) {
      answers = reextractAnswers(plans, exchanges, probeCount)
      answersMatch = sameAnswers(answers, seller.answers)
    }

    // Q1 (selective-anchoring mitigation): flag a seller that participated but
    // whose anchored probes cover less than minCoverage of the set — a possible
    // cherry-picked subset used to manufacture a verdict. Soft signal, not a
    // hard fail (a fully-absent seller (0 covered) is caught by the verdict
    // recompute below, not flagged here as "cherry-picked").
    const suspiciousAnchorSubset =
      anchoredProbeIndices.size > 0 && anchoredProbeIndices.size < probeCount * minCoverage

    observations.push({
      sellerPeerId: seller.sellerPeerId,
      agentId: seller.agentId,
      answers: answers ?? seller.answers,
      requestIds: seller.requestIds,
    })
    perSeller.push({
      sellerPeerId: seller.sellerPeerId,
      agentId: seller.agentId,
      packVerdict: seller.verdict,
      responseAuthsValid,
      anchored,
      answersMatch,
      answers,
      carrierCount: seller.carrierCount,
      suspiciousAnchorSubset,
      fullyAuthenticated: seller.fullyAuthenticated,
    })
  }

  checks.push({
    name: 'anchored records backed by pack',
    ok: [...anchoredKeys].every((key) => packKeys.has(key)),
    detail: `${anchoredKeys.size} anchored record(s), ${packKeys.size} verified pack exchange(s)`,
  })

  // 6. Re-grade the cohort with the auditor's EXACT persisted options.
  const regraded = computeCohortVerdicts(observations, pack.probeSet.probes, cohortOptions)

  for (const seller of perSeller) {
    const recomputedCohort = regraded.verdicts.find((v) => v.sellerPeerId === seller.sellerPeerId)?.verdict ?? null

    // Recompute the reference verdict from the pack's reference self-test and
    // the RE-EXTRACTED answers (reference mode only), then combine it with the
    // recomputed cohort verdict using the SAME rule the auditor used. The
    // combination must EQUAL the attested verdict — this is what stops a
    // fabricated DIFF (no reference in the pack, recomputed cohort SAME) from
    // passing, and lets a reference SAME exonerate a poisoned-cohort DIFF.
    let recomputedReference: FingerprintVerdict | null = null
    if (referenceSelfTest && seller.answers) {
      const matchVector = computeMatchVector(seller.answers, pack.probeSet.probes)
      recomputedReference = computeKbfVerdict({
        selfHamming: referenceSelfTest.hamming,
        selfTotal: referenceSelfTest.total,
        targetMatchVector: matchVector,
      }).verdict
    }
    const recomputedVerdict = recomputedCohort !== null
      ? combineVerdicts(recomputedCohort, recomputedReference ?? undefined)
      : null

    let attestationStatus: SellerRecheck['attestationStatus'] = 'unchecked'
    let onChainVerdict: FingerprintVerdict | null = null
    if (input.attestations) {
      const attestation = seller.agentId ? input.attestations.get(seller.agentId) : undefined
      if (!attestation) {
        attestationStatus = 'absent'
      } else if (hex(attestation.probeCommitment) !== commitment) {
        attestationStatus = 'superseded'
      } else {
        onChainVerdict = verdictFromCode(attestation.verdict)
        const evidenceMatches = hex(attestation.evidenceHash) === hex(packEvidenceHash)
        const batchMatches = hex(attestation.batchRoot) === hex(input.onChainBatchRoot)
        attestationStatus = onChainVerdict === seller.packVerdict && evidenceMatches && batchMatches
          ? 'match'
          : 'mismatch'
      }
    }

    // The pack's attested verdict must be EXACTLY the combination the pack's
    // own data supports — no verdict is waved through unrecomputed.
    const verdictReproduces = recomputedVerdict !== null && recomputedVerdict === seller.packVerdict

    const singleCarrierSame =
      seller.packVerdict === 'SAME' && seller.carrierCount !== undefined && seller.carrierCount < 2

    // The auditor deliberately never attests a seller whose verdict is UNKNOWN,
    // who has no agentId, or whose probe traffic lacked verified ResponseAuths
    // (see the attestation loop in audit-runner). For those sellers 'absent' is
    // the EXPECTED on-chain state, not evidence of tampering — only sellers the
    // auditor was obliged to attest must resolve to 'match'. An attestation
    // that EXISTS is always held to the match check regardless.
    const attestable =
      seller.packVerdict !== 'UNKNOWN' &&
      seller.agentId > 0 &&
      seller.fullyAuthenticated !== false

    const ok =
      seller.responseAuthsValid &&
      seller.anchored &&
      seller.answersMatch &&
      verdictReproduces &&
      (input.attestations === undefined ||
        attestationStatus === 'match' ||
        (attestationStatus === 'absent' && !attestable))

    sellers.push({
      sellerPeerId: seller.sellerPeerId,
      agentId: seller.agentId,
      packVerdict: seller.packVerdict,
      recomputedCohortVerdict: recomputedCohort,
      recomputedReferenceVerdict: recomputedReference,
      recomputedVerdict,
      responseAuthsValid: seller.responseAuthsValid,
      anchored: seller.anchored,
      answersMatch: seller.answersMatch,
      suspiciousAnchorSubset: seller.suspiciousAnchorSubset,
      singleCarrierSame,
      onChainVerdict,
      attestationStatus,
      ok,
    })
  }

  const ok = checks.every((c) => c.ok) && sellers.every((s) => s.ok)
  return { checks, sellers, ok }
}

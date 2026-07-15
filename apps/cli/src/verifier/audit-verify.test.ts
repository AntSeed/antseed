import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import type { ExchangeRecord, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node'
import { computeBatchRoot, createResponseAuthPayload } from '@antseed/node'
import type { EvidenceBundle, EvidenceProbeExchange } from '@antseed/fingerprints'
import {
  buildStealthChatRequests,
  computeCohortVerdicts,
  computeEvidenceHash,
  computeProbeCommitment,
  generateProbeSet,
  probeBankSource,
  verdictToCode,
} from '@antseed/fingerprints'
import { canonicalProbeSetJson } from './pack-writer.js'
import { reextractAnswers, reconstructStealthPlans, verifyAudit } from './audit-verify.js'
import type { AuditVerifyInput, OnChainAttestation } from './audit-verify.js'

const SERVICE = 'kimi-k2'
const VERIFIER_ADDRESS = '0x' + '11'.repeat(20)
const ALL_SELLERS = [
  { wallet: new Wallet('0x' + '33'.repeat(32)), agentId: 7 },
  { wallet: new Wallet('0x' + '44'.repeat(32)), agentId: 8 },
  { wallet: new Wallet('0x' + '55'.repeat(32)), agentId: 9 },
]
const MAX_PROBES_PER_REQUEST = 3

interface Fixture {
  input: AuditVerifyInput
  pack: EvidenceBundle
  records: ExchangeRecord[]
  attestations: Map<number, OnChainAttestation>
}

interface FixtureOptions {
  maxProbesPerRequest?: number
  cohortOptions?: {
    alpha: number
    minConsensusProbes: number
    minCoverage: number
    epsilon: number
    minConsensusSellers: number
  }
  /**
   * When set, every seller answers each probe with its exact (in-range)
   * consensus value, so the cohort forms real consensus and grades SAME
   * (given a low minConsensusProbes). Forces one probe per request.
   */
  answerWithConsensus?: boolean
  /** Sellers in the cohort (default 2; cohort consensus needs ≥3). */
  sellerCount?: number
}

const DEFAULT_FIXTURE_COHORT_OPTIONS = {
  alpha: 0.05,
  minConsensusProbes: 10,
  minCoverage: 0.5,
  epsilon: 0.02,
  minConsensusSellers: 3,
}

/**
 * Build a complete, honest audit fixture: real stealth plans from a real
 * probe set, real seller-signed ResponseAuths over the exact bytes, anchored
 * records, canonical reveal bytes, and attestations matching the verdicts.
 */
function buildFixture(opts: FixtureOptions = {}): Fixture {
  const maxProbesPerRequest = opts.answerWithConsensus ? 1 : (opts.maxProbesPerRequest ?? MAX_PROBES_PER_REQUEST)
  const cohortOptions = opts.cohortOptions ?? DEFAULT_FIXTURE_COHORT_OPTIONS
  const probeSet = generateProbeSet({
    service: SERVICE,
    count: 4,
    seed: 'ef'.repeat(32),
    source: probeBankSource(),
  })
  const plans = buildStealthChatRequests(SERVICE, probeSet, { maxProbesPerRequest })

  const activeSellers = ALL_SELLERS.slice(0, opts.sellerCount ?? 2)
  const records: ExchangeRecord[] = []
  const sellers: EvidenceBundle['sellers'] = []

  for (const seller of activeSellers) {
    const sellerPeerId = seller.wallet.address.slice(2).toLowerCase()
    const exchanges: EvidenceProbeExchange[] = []
    const requestIds: string[] = []
    const responseAuthHashes: Array<{ requestHash: string; responseHash: string }> = []

    plans.forEach((plan, i) => {
      const requestId = `req-${seller.agentId}-${i}`
      const bodyBytes = new TextEncoder().encode(JSON.stringify(plan.body))
      const request: SerializedHttpRequest = {
        requestId,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: bodyBytes,
      }
      // answerWithConsensus forces one probe per request, so a single plain
      // number reads back deterministically and in-range via the free-text
      // extractor (a leading "(1)" would be mis-parsed as the answer).
      const content = opts.answerWithConsensus
        ? `The answer is ${plan.probes[0]!.consensus}.`
        : 'Honestly I would put every one of these at about 42, give or take.'
      const responseBody = new TextEncoder().encode(JSON.stringify({
        choices: [{ message: { content } }],
      }))
      const response: SerializedHttpResponse = {
        requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: responseBody,
      }
      const auth = createResponseAuthPayload({
        request,
        response,
        buyerPeerId: VERIFIER_ADDRESS,
        sellerPeerId,
        advertisedService: SERVICE,
        provider: 'openai',
        responseStartedAt: 1,
        responseCompletedAt: 2,
      }, seller.wallet)
      requestIds.push(requestId)
      responseAuthHashes.push({ requestHash: auth.requestHash, responseHash: auth.responseHash })
      exchanges.push({
        requestId,
        request: {
          method: request.method,
          path: request.path,
          headers: { ...request.headers },
          bodyBase64: Buffer.from(bodyBytes).toString('base64'),
        },
        response: {
          statusCode: 200,
          headers: { ...response.headers },
          bodyBase64: Buffer.from(responseBody).toString('base64'),
        },
        responseAuth: auth,
      })
      records.push({
        agentId: BigInt(seller.agentId),
        requestHash: auth.requestHash,
        responseHash: auth.responseHash,
        // Pack signatures are unprefixed hex; calldata bytes are 0x-prefixed.
        responseAuthSig: `0x${auth.signature}`,
      })
    })

    // Answers exactly as the runtime extraction would produce them.
    const answers = reextractAnswers(plans, exchanges, probeSet.probes.length)
    sellers.push({
      sellerPeerId,
      agentId: seller.agentId,
      answers,
      requestIds,
      responseAuthHashes,
      verdict: 'UNDETERMINED',
      cohortVerdict: 'UNDETERMINED',
      stats: {} as EvidenceBundle['sellers'][number]['stats'],
      fullyAuthenticated: true,
      exchanges,
    })
  }

  const cohort = computeCohortVerdicts(
    sellers.map((s) => ({
      sellerPeerId: s.sellerPeerId,
      agentId: s.agentId,
      answers: s.answers,
      requestIds: s.requestIds,
    })),
    probeSet.probes,
    cohortOptions,
  )
  for (const seller of sellers) {
    const verdict = cohort.verdicts.find((v) => v.sellerPeerId === seller.sellerPeerId)!
    // No reference in this fixture, so the combined verdict IS the cohort one.
    seller.verdict = verdict.verdict
    seller.cohortVerdict = verdict.verdict
    seller.stats = verdict.stats
  }

  const pack: EvidenceBundle = {
    version: 1,
    service: SERVICE,
    verifierAddress: VERIFIER_ADDRESS,
    probeSet,
    sellers,
    cohort,
    cohortOptions,
    maxProbesPerRequest,
    createdAt: '2026-07-14T00:00:00.000Z',
  }
  const evidenceHash = computeEvidenceHash(pack)
  const batchRoot = computeBatchRoot(records)

  const attestations = new Map<number, OnChainAttestation>()
  const probeCommitment = computeProbeCommitment(probeSet)
  for (const seller of sellers) {
    attestations.set(seller.agentId, {
      verdict: verdictToCode(seller.verdict),
      probeCommitment,
      evidenceHash,
      batchRoot,
    })
  }

  return {
    input: {
      probeCommitment,
      records,
      onChainBatchRoot: batchRoot,
      revealedProbeSetJson: canonicalProbeSetJson(probeSet),
      pack,
      attestations,
    },
    pack,
    records,
    attestations,
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

test('happy path: an honest audit recomputes cleanly from public data', () => {
  const { input } = buildFixture()
  const report = verifyAudit(input)
  assert.ok(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok)))
  assert.equal(report.sellers.length, 2)
  for (const seller of report.sellers) {
    assert.ok(seller.responseAuthsValid)
    assert.ok(seller.anchored)
    assert.ok(seller.answersMatch)
    assert.equal(seller.attestationStatus, 'match')
    assert.ok(seller.ok)
  }
})

test('chain-only mode (no pack): root and commitment opening still verify', () => {
  const { input } = buildFixture()
  const report = verifyAudit({
    probeCommitment: input.probeCommitment,
    records: input.records,
    onChainBatchRoot: input.onChainBatchRoot,
    revealedProbeSetJson: input.revealedProbeSetJson,
  })
  assert.ok(report.ok)
  assert.equal(report.sellers.length, 0)
  assert.deepEqual(report.checks.map((c) => c.ok), [true, true, true])
})

test('a wrong on-chain batch root is detected', () => {
  const { input } = buildFixture()
  const report = verifyAudit({ ...input, onChainBatchRoot: '0x' + 'ff'.repeat(32) })
  assert.ok(!report.ok)
  assert.equal(report.checks.find((c) => c.name === 'batch root')!.ok, false)
})

test('revealed bytes that do not open the commitment are detected', () => {
  const { input, pack } = buildFixture()
  const tamperedSet = clone(pack.probeSet)
  tamperedSet.nonce = 'deadbeef'.repeat(8)
  const report = verifyAudit({ ...input, revealedProbeSetJson: canonicalProbeSetJson(tamperedSet) })
  assert.ok(!report.ok)
  assert.equal(report.checks.find((c) => c.name === 'commitment opening')!.ok, false)
  assert.equal(report.checks.find((c) => c.name === 'pack probe set matches reveal')!.ok, false)
})

test('a tampered response body in the pack breaks the seller signature', () => {
  const { input } = buildFixture()
  const pack = clone(input.pack!)
  pack.sellers[0]!.exchanges![0]!.response!.bodyBase64 = Buffer.from(
    JSON.stringify({ choices: [{ message: { content: 'doctored transcript' } }] }),
  ).toString('base64')
  const report = verifyAudit({ ...input, pack })
  assert.ok(!report.ok)
  const seller = report.sellers.find((s) => s.agentId === 7)!
  assert.equal(seller.responseAuthsValid, false)
  assert.equal(seller.ok, false)
})

test('a verified exchange missing from the anchor is detected', () => {
  const { input } = buildFixture()
  const dropped = input.records.slice(1) // drop agent 7's first exchange
  const report = verifyAudit({
    ...input,
    records: dropped,
    onChainBatchRoot: computeBatchRoot(dropped),
  })
  assert.ok(!report.ok)
  const seller = report.sellers.find((s) => s.agentId === 7)!
  assert.equal(seller.anchored, false)
})

test('a fabricated record padded into the anchor is detected', () => {
  const { input } = buildFixture()
  const padded = [...input.records, {
    agentId: 999n,
    requestHash: '0x' + '12'.repeat(32),
    responseHash: '0x' + '34'.repeat(32),
    responseAuthSig: '0x' + '56'.repeat(65),
  }]
  const report = verifyAudit({
    ...input,
    records: padded,
    onChainBatchRoot: computeBatchRoot(padded),
  })
  assert.ok(!report.ok)
  assert.equal(report.checks.find((c) => c.name === 'anchored records backed by pack')!.ok, false)
})

test('doctored answers in the pack are caught by re-extraction', () => {
  const { input } = buildFixture()
  const pack = clone(input.pack!)
  const original = pack.sellers[0]!.answers[0]
  pack.sellers[0]!.answers[0] = original === null ? 123456 : null
  const report = verifyAudit({ ...input, pack })
  assert.ok(!report.ok)
  assert.equal(report.sellers.find((s) => s.agentId === 7)!.answersMatch, false)
})

test('an on-chain attestation that contradicts the pack verdict is a mismatch', () => {
  const { input, attestations, pack } = buildFixture()
  const flipped = new Map(attestations)
  const packVerdict = pack.sellers[0]!.verdict
  flipped.set(7, {
    ...attestations.get(7)!,
    verdict: verdictToCode(packVerdict === 'DIFF' ? 'SAME' : 'DIFF'),
  })
  const report = verifyAudit({ ...input, attestations: flipped })
  assert.ok(!report.ok)
  assert.equal(report.sellers.find((s) => s.agentId === 7)!.attestationStatus, 'mismatch')
})

test('an attestation for a different commitment reports superseded, not mismatch', () => {
  const { input, attestations } = buildFixture()
  const superseded = new Map(attestations)
  superseded.set(7, { ...attestations.get(7)!, probeCommitment: '0x' + 'aa'.repeat(32) })
  const report = verifyAudit({ ...input, attestations: superseded })
  const seller = report.sellers.find((s) => s.agentId === 7)!
  assert.equal(seller.attestationStatus, 'superseded')
  assert.equal(seller.ok, false, 'verification must fail closed when this audit is not the on-chain attestation')
  assert.equal(report.ok, false)
})

test('a missing on-chain attestation fails verification', () => {
  const { input, attestations } = buildFixture()
  const missing = new Map(attestations)
  missing.delete(7)
  const report = verifyAudit({ ...input, attestations: missing })
  const seller = report.sellers.find((s) => s.agentId === 7)!
  assert.equal(seller.attestationStatus, 'absent')
  assert.equal(seller.ok, false)
  assert.equal(report.ok, false)
})

test('an attestation referencing another batch root fails verification', () => {
  const { input, attestations } = buildFixture()
  const wrongBatch = new Map(attestations)
  wrongBatch.set(7, { ...attestations.get(7)!, batchRoot: '0x' + 'bb'.repeat(32) })
  const report = verifyAudit({ ...input, attestations: wrongBatch })
  assert.equal(report.sellers.find((s) => s.agentId === 7)!.attestationStatus, 'mismatch')
  assert.equal(report.ok, false)
})

test('reconstructStealthPlans reproduces the exact plans from the pack maxProbesPerRequest', () => {
  const { pack } = buildFixture()
  const plans = reconstructStealthPlans(pack.probeSet, pack.sellers[0]!.exchanges!, pack.maxProbesPerRequest)
  assert.ok(plans !== null)
  const reference = buildStealthChatRequests(SERVICE, pack.probeSet, { maxProbesPerRequest: MAX_PROBES_PER_REQUEST })
  assert.deepEqual(
    plans.map((p) => p.probeIndices),
    reference.map((p) => p.probeIndices),
  )
  // A wrong bundling factor must NOT reproduce the pack's request bodies.
  assert.equal(reconstructStealthPlans(pack.probeSet, pack.sellers[0]!.exchanges!, MAX_PROBES_PER_REQUEST + 1), null)
})

// --- H1 (blocker): a fabricated DIFF must not verify -------------------------

/**
 * Rebuild the on-chain-visible facts (evidenceHash + attestation) after
 * mutating a pack, so the tamper is SELF-CONSISTENT on-chain — everything
 * checks out except that the pack's data doesn't recompute to the claimed
 * verdict. This is the realistic malicious-verifier scenario.
 */
function attestFabricated(input: AuditVerifyInput, pack: EvidenceBundle, agentId: number): AuditVerifyInput {
  const evidenceHash = computeEvidenceHash(pack)
  const attestations = new Map(input.attestations)
  const seller = pack.sellers.find((s) => s.agentId === agentId)!
  attestations.set(agentId, {
    verdict: verdictToCode(seller.verdict),
    probeCommitment: input.probeCommitment,
    evidenceHash,
    batchRoot: input.onChainBatchRoot,
  })
  return { ...input, pack, attestations }
}

test('H1: a fabricated DIFF (recomputed cohort SAME, no reference in pack) is REJECTED', () => {
  // Every seller answers each probe with its in-range consensus, so with a low
  // minConsensusProbes the honest cohort grades SAME. A malicious verifier then
  // relabels one seller DIFF and self-consistently attests it on-chain.
  const same = { ...DEFAULT_FIXTURE_COHORT_OPTIONS, minConsensusProbes: 1, minConsensusSellers: 2 }
  const fixture = buildFixture({ cohortOptions: same, answerWithConsensus: true, sellerCount: 3 })
  // Sanity: the honest fixture really does grade SAME.
  const honest = verifyAudit(fixture.input)
  assert.ok(honest.ok)
  assert.equal(honest.sellers.find((s) => s.agentId === 7)!.recomputedVerdict, 'SAME')

  const tampered = clone(fixture.pack)
  tampered.sellers.find((s) => s.agentId === 7)!.verdict = 'DIFF'
  const report = verifyAudit(attestFabricated(fixture.input, tampered, 7))

  const seller = report.sellers.find((s) => s.agentId === 7)!
  assert.equal(seller.attestationStatus, 'match', 'the on-chain attestation self-consistently claims DIFF')
  assert.equal(seller.responseAuthsValid, true)
  assert.equal(seller.anchored, true)
  assert.equal(seller.answersMatch, true)
  // The pack's own data supports SAME, not the fabricated DIFF.
  assert.equal(seller.recomputedVerdict, 'SAME')
  assert.equal(seller.packVerdict, 'DIFF')
  assert.equal(seller.ok, false, 'a DIFF the data does not reproduce must fail')
  assert.ok(!report.ok, 'the whole audit must be reported as a mismatch')
})

test('H1: a bare DIFF with no reference and an UNDETERMINED cohort is also rejected', () => {
  const fixture = buildFixture() // default minConsensusProbes:10 > 4 probes → UNDETERMINED
  const tampered = clone(fixture.pack)
  tampered.sellers.find((s) => s.agentId === 7)!.verdict = 'DIFF'
  const report = verifyAudit(attestFabricated(fixture.input, tampered, 7))
  const seller = report.sellers.find((s) => s.agentId === 7)!
  assert.equal(seller.recomputedVerdict, 'UNDETERMINED')
  assert.equal(seller.ok, false)
})

// --- Q1: selective-anchoring soft signal ------------------------------------

test('Q1: a seller whose anchored probes cover < minCoverage is flagged (soft signal)', () => {
  // One probe per request so a truncated pack covers few probes.
  const fixture = buildFixture({ maxProbesPerRequest: 1 })
  const pack = clone(fixture.pack)
  const seller = pack.sellers.find((s) => s.agentId === 7)!
  // Keep only the first exchange (covers 1 of 4 probes < 4×0.5). Drop the
  // seller's other answers so the (still all-anchored) pack is self-consistent.
  const keptRequestId = seller.exchanges![0]!.requestId
  seller.exchanges = seller.exchanges!.slice(0, 1)
  seller.requestIds = [keptRequestId]
  seller.responseAuthHashes = [seller.responseAuthHashes![0]!]
  seller.answers = seller.answers.map(() => null)
  // Re-derive the single covered probe's answer from the kept exchange.
  // (Left null here; the point is coverage, not answer content.)

  // Rebuild records = only the kept exchanges across BOTH sellers (a real
  // cherry-pick anchors only what the pack contains).
  const keptKeys = new Set<string>()
  const records: ExchangeRecord[] = []
  for (const s of pack.sellers) {
    for (const ex of s.exchanges ?? []) {
      if (!ex.responseAuth) continue
      keptKeys.add(ex.requestId)
      records.push({
        agentId: BigInt(s.agentId),
        requestHash: ex.responseAuth.requestHash,
        responseHash: ex.responseAuth.responseHash,
        responseAuthSig: `0x${ex.responseAuth.signature}`,
      })
    }
  }
  const input: AuditVerifyInput = {
    ...fixture.input,
    pack,
    records,
    onChainBatchRoot: computeBatchRoot(records),
  }
  const report = verifyAudit(input)
  const recheck = report.sellers.find((s) => s.agentId === 7)!
  assert.equal(recheck.suspiciousAnchorSubset, true, 'a sub-minCoverage anchored subset must be flagged')
  assert.equal(recheck.anchored, true, 'every pack exchange is still anchored — this is a SOFT signal, not a hard fail')
})

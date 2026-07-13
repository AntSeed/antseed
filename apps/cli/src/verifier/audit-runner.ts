import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AntseedNode, PeerInfo, VerifierRegistryClient } from '@antseed/node'
import { serviceHash, VERIFIER_VERDICT_UNKNOWN } from '@antseed/node'
import type { Identity } from '@antseed/node'
import type {
  FingerprintReference,
  FingerprintVerdict,
  ProbeSet,
  ProbeSource,
  SellerObservation,
} from '@antseed/fingerprints'
import {
  generateProbeSet,
  compositionalProbeSource,
  probeBankSource,
  staticProbeSource,
  computeProbeCommitment,
  computeCohortVerdicts,
  computeMatchVector,
  computeKbfVerdict,
  computeEvidenceHash,
  verdictToCode,
} from '@antseed/fingerprints'
import { probeSeller } from './probing.js'
import type { SellerProbeRun } from './probing.js'
import { loadUsedProbeIds, recordUsedProbeIds } from './probe-log.js'
import { safeServiceSlug } from './slug.js'

export type ProbeSourceKind = 'compositional' | 'bank'

/**
 * Executes the probe plan against one seller and returns the observation.
 * The default executor probes directly from this node's buyer identity; the
 * delegated executor routes probes through organic delegate buyers and
 * reports which delegates (by peerId) carried verified jobs.
 */
export type ProbeExecutor = (
  peer: PeerInfo,
  service: string,
  probeSet: ProbeSet,
  maxProbesPerRequest: number,
) => Promise<{ run: SellerProbeRun; jobsByDelegate?: Map<string, number> }>

export interface AuditRunnerOptions {
  probesPerAudit: number
  /**
   * On-chain minimum probe count (AntseedVerifierRegistry.minProbeCount).
   * An audit whose effective probe count would fall below it is skipped
   * BEFORE committing or probing — the contract would reject every
   * attestation with ProbeCountTooLow after all probes were already paid for.
   */
  minProbeCount: number
  cohortMinSize: number
  cohortMaxSize: number
  stalenessWindowSecs: number
  /** Max probes woven into a single stealth chat request (stealth vs. cost dial). */
  maxProbesPerRequest: number
  evidenceDir: string
  /**
   * Origin of probes when no reference matches the service. `compositional`
   * (default) draws from a large rotating space; `bank` uses the built-in
   * fixture. When a reference IS present, its certified probes are used
   * regardless (reference mode).
   */
  probeSource: ProbeSourceKind
  /** Directory holding the per-service probe rotation log. */
  probeLogDir: string
  /**
   * How many recently-used probe ids to remember per service and exclude from
   * future rounds. 0 disables rotation. Ignored for reference mode (certified
   * probes are meant to be reused).
   */
  probeRotationHistory: number
  /**
   * Original advertised spelling sent as the wire model id. Sellers match the
   * body's model field case-sensitively, so probing `Qwen/Qwen3-32B` as
   * `qwen/qwen3-32b` 404s forever. Defaults to `service` (the normalized key,
   * used for grouping/config/hash purposes only).
   */
  advertisedService?: string
  /** Per-peer advertised spelling override (peerId → exact spelling). */
  advertisedByPeer?: ReadonlyMap<string, string>
  /**
   * Overrides how probes reach the seller. Absent: direct probing from this
   * node's own (verifier-linked, thus classifiable) buyer identity.
   */
  probeExecutor?: ProbeExecutor
  log: (message: string) => void
  warn: (message: string) => void
}

export interface SellerAuditOutcome {
  peerId: string
  agentId: number | undefined
  verdict: FingerprintVerdict
  cohortVerdict: FingerprintVerdict
  referenceVerdict?: FingerprintVerdict
  fullyAuthenticated: boolean
  attested: boolean
  /**
   * True when the on-chain attestation was actually CREDITED (moved
   * lastCreditedAt / epochCredits). The contract records attestations as
   * uncredited under its cooldown or per-epoch cap, so tx success alone must
   * not count against the audit budget.
   */
  credited: boolean
  attestationTx?: string
}

export interface CohortAuditResult {
  service: string
  probeCommitment: string
  evidenceHash: string
  evidencePath: string
  cohortSize: number
  outcomes: SellerAuditOutcome[]
  /** Verified probe jobs per delegate peerId (empty in direct mode). */
  delegateJobs: Map<string, number>
}

/**
 * Select audit targets for one service, stalest first. Sellers must advertise
 * an on-chain agent id (attestations are keyed by agentId) and support
 * response-auth so probe evidence is attributable.
 */
export async function selectCohort(
  peers: PeerInfo[],
  service: string,
  registryClient: VerifierRegistryClient,
  options: Pick<AuditRunnerOptions, 'cohortMaxSize' | 'stalenessWindowSecs' | 'warn'>,
): Promise<PeerInfo[]> {
  const eligible = peers.filter((peer) => {
    if (!peer.onChainAgentId) return false
    return (peer.capabilities ?? []).includes('verification.response-auth.v1')
  })

  const withStaleness = await Promise.all(eligible.map(async (peer) => {
    let lastCredited = 0
    try {
      lastCredited = await registryClient.lastCreditedAt(peer.onChainAgentId!, service)
    } catch (err) {
      options.warn(`staleness read failed for agent ${peer.onChainAgentId}: ${(err as Error).message}`)
    }
    return { peer, lastCredited }
  }))

  const nowSecs = Math.floor(Date.now() / 1000)
  // Stale sellers earn credits; fresh ones are still useful as cohort
  // consensus members, so they rank after the stale ones instead of being
  // dropped outright.
  withStaleness.sort((a, b) => a.lastCredited - b.lastCredited)
  const stale = withStaleness.filter((e) => nowSecs - e.lastCredited >= options.stalenessWindowSecs)
  const fresh = withStaleness.filter((e) => nowSecs - e.lastCredited < options.stalenessWindowSecs)
  return [...stale, ...fresh].slice(0, options.cohortMaxSize).map((e) => e.peer)
}

function combineVerdicts(
  cohortVerdict: FingerprintVerdict,
  referenceVerdict: FingerprintVerdict | undefined,
): FingerprintVerdict {
  if (!referenceVerdict || referenceVerdict === 'UNKNOWN') return cohortVerdict
  // A reference DIFF is independent adverse evidence — it wins over a passing
  // cohort (the whole cohort could be serving the same substitute).
  if (referenceVerdict === 'DIFF') return 'DIFF'
  if (cohortVerdict === 'UNDETERMINED') return referenceVerdict
  return cohortVerdict
}

/** All-null placeholder run for a seller whose probe execution itself failed. */
function failedRun(peer: PeerInfo, probeCount: number, error: string): SellerProbeRun {
  return {
    peerId: peer.peerId,
    agentId: peer.onChainAgentId,
    answers: new Array<number | null>(probeCount).fill(null),
    requestIds: [],
    responseAuths: [],
    exchanges: [],
    fullyAuthenticated: false,
    errors: [error],
  }
}

/**
 * Run one cohort audit round for a service:
 * commit probe set on-chain → probe every cohort member with identical
 * batches → cohort-consensus verdicts (+ optional KBF reference verdicts) →
 * write the evidence bundle → attest each seller on-chain.
 *
 * Returns null when the audit is skipped before any money moves (probe pool
 * too small for the on-chain minProbeCount).
 */
export async function runCohortAudit(
  node: AntseedNode,
  identity: Identity,
  registryClient: VerifierRegistryClient,
  service: string,
  cohort: PeerInfo[],
  reference: FingerprintReference | undefined,
  options: AuditRunnerOptions,
): Promise<CohortAuditResult | null> {
  const { log, warn } = options

  // Fail fast on hostile service names (e.g. "..") BEFORE any on-chain
  // commit or probe spend — the slug builds evidence/rotation-log paths.
  const serviceSlug = safeServiceSlug(service)

  // Choose the probe origin. A reference that matches the service is scored
  // against its certified answers (reference mode); otherwise draw from a
  // large rotating source so a seller cannot memorize a finite bank.
  const referenceMode = Boolean(reference?.selfTest)
  const source: ProbeSource = reference?.selfTest
    ? staticProbeSource(reference.referenceId, reference.probes, { consensusCertified: true })
    : options.probeSource === 'bank'
      ? probeBankSource()
      : compositionalProbeSource()

  // Rotation: exclude probes recently revealed against this service. Only for
  // large, non-certified sources — certified reference probes are meant to be
  // reused, and their pools are too small to rotate.
  const rotationEnabled = !source.consensusCertified && options.probeRotationHistory > 0
  const exclude = rotationEnabled
    ? await loadUsedProbeIds(options.probeLogDir, service)
    : new Set<string>()

  // Never ask for more probes than the live pool can supply. When rotation
  // has exhausted the pool, expire the OLDEST exclusions (an explicit new
  // rotation cycle) instead of forcing a positive count against an empty
  // pool — generateProbeSet would throw and permanently kill this service's
  // audits. loadUsedProbeIds preserves file order, so Set iteration order is
  // oldest-first.
  const targetCount = Math.min(options.probesPerAudit, source.size)
  if (source.size - exclude.size < targetCount) {
    const toExpire = targetCount - (source.size - exclude.size)
    let expired = 0
    for (const id of exclude) {
      if (expired >= toExpire) break
      exclude.delete(id)
      expired += 1
    }
    warn(
      `${service}: probe pool for source ${source.id} exhausted by rotation; ` +
        `expired ${expired} oldest exclusion(s) to start a new rotation cycle`,
    )
  }
  const count = Math.min(options.probesPerAudit, source.size - exclude.size)
  if (count < options.probesPerAudit) {
    warn(
      `${service}: probe pool for source ${source.id} down to ${source.size - exclude.size}; ` +
        `auditing with ${count} probes this round`,
    )
  }

  // The contract rejects attestations below minProbeCount — skip BEFORE
  // committing or sending a single paid probe. (Also skips a fully empty
  // pool: a positive count is never forced against one.)
  if (count < Math.max(1, options.minProbeCount)) {
    warn(
      `${service}: effective probe count ${count} < on-chain minProbeCount ${options.minProbeCount}; ` +
        'skipping audit (no commit, no probes)',
    )
    return null
  }

  // Fresh private probe set per round. The seed is random — determinism is
  // only needed for later re-verification, which the persisted probe set in
  // the evidence bundle provides.
  const probeSet = generateProbeSet({
    service,
    count,
    seed: randomBytes(32).toString('hex'),
    source,
    ...(exclude.size > 0 ? { exclude } : {}),
  })
  const probeCommitment = computeProbeCommitment(probeSet)

  // Commit BEFORE any probe leaves this machine. The contract rejects
  // attestations whose commitment is not strictly older than the submission,
  // which is what makes fabricated-after-the-fact results detectable.
  log(`Committing probe set ${probeCommitment.slice(0, 10)}… on-chain`)
  await registryClient.commitProbeSet(identity.wallet, probeCommitment)

  const execute: ProbeExecutor = options.probeExecutor
    ?? (async (target, svc, probes, maxPerRequest) => ({
      run: await probeSeller(node, target, svc, probes, maxPerRequest),
    }))

  const runs: SellerProbeRun[] = []
  const delegateJobs = new Map<string, number>()
  for (const peer of cohort) {
    // Wire model id: the exact spelling this peer advertises (sellers match
    // it case-sensitively); normalized `service` is only a grouping key.
    const wireService = options.advertisedByPeer?.get(peer.peerId)
      ?? options.advertisedService
      ?? service
    log(`Probing ${peer.peerId.slice(0, 10)}… (agent ${peer.onChainAgentId}) with ${probeSet.probes.length} probes`)
    // Per-seller error boundary: one seller's probe path blowing up (e.g.
    // the last delegate disconnecting mid-audit) must not discard the whole
    // committed, partially-paid cohort audit.
    let run: SellerProbeRun
    try {
      const outcome = await execute(peer, wireService, probeSet, options.maxProbesPerRequest)
      run = outcome.run
      for (const [delegatePeerId, jobs] of outcome.jobsByDelegate ?? []) {
        delegateJobs.set(delegatePeerId, (delegateJobs.get(delegatePeerId) ?? 0) + jobs)
      }
    } catch (err) {
      warn(`  ${peer.peerId.slice(0, 10)}…: probe execution failed: ${(err as Error).message}`)
      run = failedRun(peer, probeSet.probes.length, `probe execution failed: ${(err as Error).message}`)
    }
    for (const error of run.errors) warn(`  ${peer.peerId.slice(0, 10)}…: ${error}`)
    runs.push(run)
  }

  // Record probe reveals only AFTER probes were actually sent. Recording
  // before the on-chain commit burned never-revealed probes into the
  // rotation log whenever the commit (or anything before dispatch) aborted.
  if (rotationEnabled) {
    await recordUsedProbeIds(
      options.probeLogDir,
      service,
      probeSet.probes.map((p) => p.id),
      options.probeRotationHistory,
      new Date().toISOString(),
    ).catch((err) => warn(`probe rotation log write failed for ${service}: ${(err as Error).message}`))
  }

  const observations: SellerObservation[] = runs.map((run) => ({
    sellerPeerId: run.peerId,
    agentId: run.agentId ?? 0,
    answers: run.answers,
    requestIds: run.requestIds,
    responseAuthHashes: run.responseAuths
      .filter((auth): auth is NonNullable<typeof auth> => auth !== null)
      .map((auth) => ({ requestHash: auth.requestHash, responseHash: auth.responseHash })),
  }))

  const cohortResult = computeCohortVerdicts(observations, probeSet.probes, {})

  const outcomes: SellerAuditOutcome[] = []
  for (const run of runs) {
    const sellerVerdict = cohortResult.verdicts.find((v) => v.sellerPeerId === run.peerId)
    const cohortVerdict = sellerVerdict?.verdict ?? 'UNDETERMINED'

    let referenceVerdict: FingerprintVerdict | undefined
    if (referenceMode && reference?.selfTest) {
      // Reference mode only: the probe set IS the reference's certified probes,
      // so scoring answers against their consensus is meaningful. Compositional
      // and bank probes carry advisory consensus and MUST NOT reach this path
      // (they would mismatch every seller and forge a bogus DIFF).
      const matchVector = computeMatchVector(run.answers, probeSet.probes)
      referenceVerdict = computeKbfVerdict({
        selfHamming: reference.selfTest.hamming,
        selfTotal: reference.selfTest.total,
        targetMatchVector: matchVector,
      }).verdict
    }

    outcomes.push({
      peerId: run.peerId,
      agentId: run.agentId,
      verdict: combineVerdicts(cohortVerdict, referenceVerdict),
      cohortVerdict,
      ...(referenceVerdict !== undefined ? { referenceVerdict } : {}),
      fullyAuthenticated: run.fullyAuthenticated,
      attested: false,
      credited: false,
    })
  }

  // Evidence bundle: enough material for a third party to re-verify every
  // seller signature from the bundle alone — full ResponseAuth payloads plus
  // the exact request/response bytes their hashes commit to.
  const evidenceBundle = {
    version: 1 as const,
    service,
    verifierAddress: identity.wallet.address,
    probeSet,
    sellers: runs.map((run, i) => {
      const sellerVerdict = cohortResult.verdicts.find((v) => v.sellerPeerId === run.peerId)!
      return {
        ...observations[i]!,
        verdict: outcomes[i]!.verdict,
        stats: sellerVerdict.stats,
        fullyAuthenticated: run.fullyAuthenticated,
        exchanges: run.exchanges,
      }
    }),
    cohort: cohortResult,
    createdAt: new Date().toISOString(),
  }
  const evidenceHash = computeEvidenceHash(evidenceBundle)

  const evidenceServiceDir = join(options.evidenceDir, serviceSlug)
  await mkdir(evidenceServiceDir, { recursive: true })
  const evidencePath = join(evidenceServiceDir, `${Date.now()}-${evidenceHash.slice(2, 14)}.json`)
  await writeFile(evidencePath, JSON.stringify(evidenceBundle, null, 2))
  log(`Evidence bundle ${evidenceHash.slice(0, 10)}… written to ${evidencePath}`)

  for (const outcome of outcomes) {
    const code = verdictToCode(outcome.verdict)
    if (code === VERIFIER_VERDICT_UNKNOWN || !outcome.agentId) continue
    if (!outcome.fullyAuthenticated) {
      // Unauthenticated probes are seller non-cooperation, not model
      // evidence — do not attest a verdict that can't be backed by signed
      // responses.
      warn(`Skipping attestation for agent ${outcome.agentId}: missing verified ResponseAuth on probe traffic`)
      continue
    }
    // lastCreditedAt is the on-chain credited marker: comparing it around the
    // submission distinguishes CREDITED attestations from ones the contract
    // recorded but refused to credit (cooldown, per-epoch cap).
    let creditedBefore = 0
    let creditedBeforeKnown = true
    try {
      creditedBefore = await registryClient.lastCreditedAt(outcome.agentId, service)
    } catch {
      creditedBeforeKnown = false
    }
    try {
      const tx = await registryClient.submitAttestation(identity.wallet, {
        agentId: outcome.agentId,
        serviceHash: serviceHash(service),
        verdict: code,
        evidenceHash,
        probeCommitment,
        probeCount: probeSet.probes.length,
        cohortSize: cohort.length,
      })
      outcome.attested = true
      outcome.attestationTx = tx
      try {
        const creditedAfter = await registryClient.lastCreditedAt(outcome.agentId, service)
        outcome.credited = creditedBeforeKnown ? creditedAfter > creditedBefore : creditedAfter > 0
      } catch {
        // Read failure after a successful submission: assume credited — the
        // conservative direction for budget accounting (never over-spend).
        outcome.credited = true
      }
      log(`Attested agent ${outcome.agentId} ${service}: ${outcome.verdict}${outcome.credited ? '' : ' (uncredited)'} (tx ${tx.slice(0, 10)}…)`)
    } catch (err) {
      warn(`Attestation failed for agent ${outcome.agentId}: ${(err as Error).message}`)
    }
  }

  return {
    service,
    probeCommitment,
    evidenceHash,
    evidencePath,
    cohortSize: cohort.length,
    outcomes,
    delegateJobs,
  }
}

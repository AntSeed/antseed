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

export type ProbeSourceKind = 'compositional' | 'bank'

/**
 * Executes the probe plan against one seller and returns the observation.
 * The default executor probes directly from this node's buyer identity; the
 * delegated executor routes probes through organic delegate buyers and
 * reports which payout addresses carried verified jobs.
 */
export type ProbeExecutor = (
  peer: PeerInfo,
  service: string,
  probeSet: ProbeSet,
  maxProbesPerRequest: number,
) => Promise<{ run: SellerProbeRun; jobsByPayout?: Map<string, number> }>

export interface AuditRunnerOptions {
  probesPerAudit: number
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
  attestationTx?: string
}

export interface CohortAuditResult {
  service: string
  probeCommitment: string
  evidenceHash: string
  evidencePath: string
  cohortSize: number
  outcomes: SellerAuditOutcome[]
  /** Verified probe jobs per delegate payout address (empty in direct mode). */
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

/**
 * Run one cohort audit round for a service:
 * commit probe set on-chain → probe every cohort member with identical
 * batches → cohort-consensus verdicts (+ optional KBF reference verdicts) →
 * write the evidence bundle → attest each seller on-chain.
 */
export async function runCohortAudit(
  node: AntseedNode,
  identity: Identity,
  registryClient: VerifierRegistryClient,
  service: string,
  cohort: PeerInfo[],
  reference: FingerprintReference | undefined,
  options: AuditRunnerOptions,
): Promise<CohortAuditResult> {
  const { log, warn } = options

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

  // Never ask for more probes than the live pool can supply after exclusions;
  // shrink the count rather than throwing on a well-rotated small pool.
  const available = source.size - exclude.size
  const count = Math.max(1, Math.min(options.probesPerAudit, available))
  if (count < options.probesPerAudit) {
    warn(
      `${service}: probe pool for source ${source.id} down to ${available} after rotation; ` +
        `auditing with ${count} probes this round`,
    )
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

  if (rotationEnabled) {
    await recordUsedProbeIds(
      options.probeLogDir,
      service,
      probeSet.probes.map((p) => p.id),
      options.probeRotationHistory,
      new Date().toISOString(),
    ).catch((err) => warn(`probe rotation log write failed for ${service}: ${(err as Error).message}`))
  }

  // Commit BEFORE any probe leaves this machine. The contract rejects
  // attestations whose commitment is not strictly older than the submission,
  // which is what makes fabricated-after-the-fact results detectable.
  log(`Committing probe set ${probeCommitment.slice(0, 10)}… on-chain`)
  await registryClient.commitProbeSet(identity.wallet, probeCommitment)

  const execute: ProbeExecutor = options.probeExecutor
    ?? (async (target, svc, probes, maxPerRequest) => ({
      run: await probeSeller(node, target, svc, probes, maxPerRequest),
    }))

  const runs = []
  const delegateJobs = new Map<string, number>()
  for (const peer of cohort) {
    log(`Probing ${peer.peerId.slice(0, 10)}… (agent ${peer.onChainAgentId}) with ${probeSet.probes.length} probes`)
    const { run, jobsByPayout } = await execute(peer, service, probeSet, options.maxProbesPerRequest)
    for (const error of run.errors) warn(`  ${peer.peerId.slice(0, 10)}…: ${error}`)
    for (const [payout, jobs] of jobsByPayout ?? []) {
      delegateJobs.set(payout, (delegateJobs.get(payout) ?? 0) + jobs)
    }
    runs.push(run)
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
    })
  }

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
        responseAuthSignatures: run.responseAuths.map((auth) => auth?.signature ?? null),
      }
    }),
    cohort: cohortResult,
    createdAt: new Date().toISOString(),
  }
  const evidenceHash = computeEvidenceHash(evidenceBundle)

  const evidenceServiceDir = join(options.evidenceDir, service.replace(/[^a-z0-9._-]/gi, '_'))
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
      log(`Attested agent ${outcome.agentId} ${service}: ${outcome.verdict} (tx ${tx.slice(0, 10)}…)`)
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

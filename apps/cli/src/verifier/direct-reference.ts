import {
  KBF_MAX_PROBE_COUNT,
  computeBinomialPower,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type {
  PeerInfo,
  StoredCertifiedKbfProbe,
  StoredDirectAuditProbe,
  VerificationStorage,
} from '@antseed/node'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  certifyNewProbes,
  eligibleCatalogProbes,
  freshSelfTestProbes,
  importAdaptiveReferences,
  materializeAuditReference,
  nextAdaptiveProbeCount,
  selectCatalogProbes,
  type FreshSelfTestResult,
} from './probe-catalog.js'
import {
  resolveReferencePolicy,
  resolveReferenceSource,
} from './reference-config.js'
import {
  findReferenceForService,
  loadReferences,
} from './references.js'
import { selectAndReserveReferenceSubset } from './reference-subset.js'

export interface PrepareDirectReferenceInput {
  storage: VerificationStorage
  runId: string
  target: PeerInfo
  service: string
  advertisedService?: string
  verifierConfig: VerifierCLIConfig | undefined
  referencesDir: string
  minimumProbeCount: number
  minimumStatisticalPower?: number
  warn?: (message: string) => void
  log?: (message: string) => void
  now?: number
}

export async function prepareDirectAuditReference(
  input: PrepareDirectReferenceInput,
): Promise<KbfReferenceV1> {
  if (!input.target.onChainAgentId) throw new Error('target has no on-chain agent id')
  const policy = resolveReferencePolicy(input.verifierConfig?.referencePolicy)
  const minimumProbeCount = roundProbeCount(Math.max(input.minimumProbeCount, policy.minimumAuditProbeCount))
  const minimumPower = input.minimumStatisticalPower ?? policy.minimumStatisticalPower
  const maximumProbeCount = Math.min(KBF_MAX_PROBE_COUNT, policy.maximumAuditProbeCount)
  if (minimumProbeCount > maximumProbeCount) {
    throw new Error(`minimum probe count ${minimumProbeCount} exceeds maximum ${maximumProbeCount}`)
  }
  const references = await loadReferences(
    input.referencesDir,
    input.warn ?? (() => undefined),
    { trustedImportedReferenceIds: input.verifierConfig?.trustedImportedReferenceIds },
  )
  const advertisedService = input.advertisedService ?? input.service
  const source = resolveReferenceSource(input.verifierConfig, input.service, advertisedService)
  if (!source) {
    const reference = findReferenceForService(references, input.service)
    if (!reference) {
      throw new Error(
        `no trusted reference for ${input.service}; configure verifier.referenceEndpoint or build/import a reference`,
      )
    }
    const createdAt = Date.parse(reference.createdAt)
    if (!Number.isFinite(createdAt) || (input.now ?? Date.now()) - createdAt > policy.maxReferenceAgeDays * 86_400_000) {
      throw new Error(`trusted reference ${reference.referenceId} for ${input.service} is stale`)
    }
    for (let count = minimumProbeCount; count <= Math.min(maximumProbeCount, reference.probes.length); count += policy.auditProbeStep) {
      const rounded = roundProbeCount(count)
      const subset = selectAndReserveReferenceSubset({
        storage: input.storage,
        auditId: input.runId,
        agentId: String(input.target.onChainAgentId),
        service: input.service,
        reference,
        probeCount: rounded,
      })
      if (subset.statisticalPower >= minimumPower) return subset
    }
    throw new Error(`trusted reference ${reference.referenceId} remains underpowered at available probe limit`)
  }

  const imported = importAdaptiveReferences({
    storage: input.storage,
    service: input.service,
    source,
    references,
    now: input.now,
  })
  if (imported.probes > 0) input.log?.(`imported ${imported.probes} certified probes for ${input.service}`)

  let requestCount = 0
  let eligible = eligibleCatalogProbes({
    storage: input.storage,
    agentId: String(input.target.onChainAgentId),
    service: input.service,
    source,
    auditId: input.runId,
    now: input.now,
  })
  if (eligible.length < minimumProbeCount) {
    const generated = await certifyNewProbes({
      storage: input.storage,
      service: input.service,
      source,
      requiredCount: minimumProbeCount - eligible.length,
      minimumCertifiedCount: minimumProbeCount,
      referencesDir: input.referencesDir,
      maxRequests: source.policy.maxRequestsPerRound,
      log: input.log,
      now: input.now,
    })
    requestCount += generated.requestCount
    eligible = eligibleCatalogProbes({
      storage: input.storage,
      agentId: String(input.target.onChainAgentId),
      service: input.service,
      source,
      auditId: input.runId,
      now: input.now,
    })
  }

  let selected = selectCatalogProbes(input.runId, eligible, minimumProbeCount)
  reserveCatalogProbes(input.storage, input.runId, selected)
  const outcomes = new Map<string, FreshSelfTestResult['outcomes'][number]>()
  const testFresh = async (probes: readonly StoredCertifiedKbfProbe[]): Promise<void> => {
    const unseen = probes.filter((probe) => !outcomes.has(probe.probeId))
    if (unseen.length === 0) return
    const tested = await freshSelfTestProbes({
      source,
      probes: unseen,
      maxRequests: source.policy.maxRequestsPerRound - requestCount,
      log: input.log,
    })
    requestCount += tested.requestCount
    for (const outcome of tested.outcomes) outcomes.set(outcome.probeId, outcome)
  }
  await testFresh(selected)

  for (;;) {
    const hamming = selected.filter((probe) => outcomes.get(probe.probeId)?.match !== 1).length
    const minimumMismatchDelta = selected.length < 100 && source.upstream.trust === 'smoke'
      ? 0.25
      : source.policy.minimumMismatchDelta
    const power = computeBinomialPower({
      selfHamming: hamming,
      selfTotal: selected.length,
      minimumMismatchDelta,
      alpha: source.policy.familyWideAlpha,
      cpConfidence: source.policy.referenceConfidence,
    }).power
    if (power >= minimumPower) break
    if (selected.length >= maximumProbeCount) {
      throw new Error(`reference remains underpowered at ${maximumProbeCount} probes`)
    }
    const nextCount = roundProbeCount(nextAdaptiveProbeCount(
      selected.length,
      source.policy.auditProbeStep,
      maximumProbeCount,
    ))
    eligible = eligibleCatalogProbes({
      storage: input.storage,
      agentId: String(input.target.onChainAgentId),
      service: input.service,
      source,
      auditId: input.runId,
      now: input.now,
    })
    if (eligible.length < nextCount) {
      const generated = await certifyNewProbes({
        storage: input.storage,
        service: input.service,
        source,
        requiredCount: nextCount - eligible.length,
        minimumCertifiedCount: nextCount,
        referencesDir: input.referencesDir,
        maxRequests: source.policy.maxRequestsPerRound - requestCount,
        log: input.log,
        now: input.now,
      })
      requestCount += generated.requestCount
      eligible = eligibleCatalogProbes({
        storage: input.storage,
        agentId: String(input.target.onChainAgentId),
        service: input.service,
        source,
        auditId: input.runId,
        now: input.now,
      })
    }
    const next = selectCatalogProbes(input.runId, eligible, nextCount)
    const selectedIds = new Set(selected.map((probe) => probe.probeId))
    const additions = next.filter((probe) => !selectedIds.has(probe.probeId))
    selected = next
    reserveCatalogProbes(input.storage, input.runId, selected)
    await testFresh(additions)
    if (requestCount > source.policy.maxRequestsPerRound) throw new Error('reference request budget exhausted')
  }

  const materialized = await materializeAuditReference({
    auditId: input.runId,
    service: input.service,
    source,
    probes: selected,
    selfTestOutcomes: selected.map((probe) => {
      const outcome = outcomes.get(probe.probeId)
      if (!outcome) throw new Error(`missing fresh self-test result for ${probe.probeId}`)
      return outcome
    }),
    referencesDir: input.referencesDir,
    minimumMismatchDelta: selected.length < 100 && source.upstream.trust === 'smoke'
      ? 0.25
      : source.policy.minimumMismatchDelta,
    alpha: source.policy.familyWideAlpha,
    cpConfidence: source.policy.referenceConfidence,
    minimumPower,
    now: input.now,
  })
  return materialized.reference
}

function reserveCatalogProbes(
  storage: VerificationStorage,
  auditId: string,
  probes: readonly StoredCertifiedKbfProbe[],
): void {
  storage.saveDirectAuditProbes(probes.map((probe, ordinal): StoredDirectAuditProbe => ({
    auditId,
    ordinal,
    probeId: probe.probeId,
    status: 'selected',
    requestId: null,
    requestHash: null,
    responseHash: null,
    responseAuth: null,
    payment: null,
    timing: null,
    matched: null,
    exposureCountedAt: null,
    failureReason: null,
  })))
}

function roundProbeCount(value: number): number {
  return Math.max(10, Math.min(KBF_MAX_PROBE_COUNT, Math.ceil(value / 10) * 10))
}

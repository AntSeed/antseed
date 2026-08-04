import {
  KBF_MAX_PROBE_COUNT,
  computeBinomialPower,
  queryProfileHash,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { StoredCertifiedKbfProbe, VerificationStorage } from '@antseed/node'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  certificationProfileHash,
  certifyNewProbes,
  freshSelfTestProbes,
  materializeAuditReference,
  selectCatalogProbes,
} from './probe-catalog.js'
import { resolveReferenceSource } from './reference-config.js'

export interface PreparedBenchmarkReference {
  reference: KbfReferenceV1
  outPath: string
  certificationHash: string
  queryProfileHash: string
  trust: 'smoke' | 'trusted'
  contrastModels: string[]
}

export interface BenchmarkReferenceDependencies {
  certify?: typeof certifyNewProbes
  selfTest?: typeof freshSelfTestProbes
  materialize?: typeof materializeAuditReference
}

export interface BenchmarkReferenceSizing {
  mode: 'fixed' | 'auto'
  minimumProbeCount: number
  maximumProbeCount: number
  probeStep: number
  minimumStatisticalPower: number
  minimumMismatchDelta: number
  alpha: number
  cpConfidence: number
}

export async function prepareBenchmarkReference(input: {
  storage: VerificationStorage
  runId: string
  service: string
  verifierConfig: VerifierCLIConfig | undefined
  referencesDir: string
  sizing: BenchmarkReferenceSizing
  now?: number
  fetchFn?: typeof fetch
  log?: (message: string) => void
}, dependencies: BenchmarkReferenceDependencies = {}): Promise<PreparedBenchmarkReference> {
  validateSizing(input.sizing)

  const resolvedSource = resolveReferenceSource(input.verifierConfig, input.service, input.service)
  if (!resolvedSource) throw new Error(`no reference source configured for ${input.service}`)
  const source = {
    ...resolvedSource,
    policy: {
      ...resolvedSource.policy,
      maxConcurrentReferenceRequests: Math.min(4, resolvedSource.policy.maxConcurrentReferenceRequests),
      maxConcurrentRequestsPerModel: Math.min(2, resolvedSource.policy.maxConcurrentRequestsPerModel),
    },
  }

  const now = input.now ?? Date.now()
  const profileHash = certificationProfileHash(source)
  let eligible = input.storage.listCertifiedKbfProbes(input.service, profileHash, now)
  let requestCount = 0
  let selected: StoredCertifiedKbfProbe[] = []
  const outcomes = new Map<string, { probeId: string; answer: number | null; match: 0 | 1 | null }>()
  let selectedPower = 0

  for (let targetCount = input.sizing.minimumProbeCount;
    targetCount <= input.sizing.maximumProbeCount;
    targetCount += input.sizing.probeStep) {
    while (eligible.length < targetCount) {
      const eligibleBefore = eligible.length
      const missing = targetCount - eligible.length
      const certificationCount = source.upstream.trust === 'smoke' ? missing : Math.max(100, missing)
      const certified = await (dependencies.certify ?? certifyNewProbes)({
        storage: input.storage,
        service: input.service,
        source,
        requiredCount: certificationCount,
        generationProbeCount: source.upstream.trust === 'smoke'
          ? Math.max(50, certificationCount)
          : certificationCount,
        persistAllGenerated: source.upstream.trust === 'smoke',
        minimumCertifiedCount: source.upstream.trust === 'smoke' ? 10 : certificationCount,
        referencesDir: input.referencesDir,
        maxRequests: source.policy.maxRequestsPerRound - requestCount,
        ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
        ...(input.log ? { log: input.log } : {}),
        now,
      })
      requestCount += certified.requestCount
      eligible = input.storage.listCertifiedKbfProbes(input.service, profileHash, now)
      if (eligible.length <= eligibleBefore) {
        throw new Error(`reference certification made no progress toward ${targetCount} probes`)
      }
    }

    const selectedIds = new Set(selected.map((probe) => probe.probeId))
    const additions = selectCatalogProbes(
      input.runId,
      eligible.filter((probe) => !selectedIds.has(probe.probeId)),
      targetCount - selected.length,
    )
    selected = [...selected, ...additions]
    const tested = await (dependencies.selfTest ?? freshSelfTestProbes)({
      source,
      probes: additions,
      maxRequests: source.policy.maxRequestsPerRound - requestCount,
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
      ...(input.log ? { log: input.log } : {}),
    })
    requestCount += tested.requestCount
    for (const outcome of tested.outcomes) outcomes.set(outcome.probeId, outcome)
    if (tested.outcomes.some((outcome) => outcome.match === null)) {
      throw new Error('shared reference self-test has incomplete coverage')
    }

    const hamming = selected.filter((probe) => outcomes.get(probe.probeId)?.match !== 1).length
    const power = computeBinomialPower({
      selfHamming: hamming,
      selfTotal: selected.length,
      minimumMismatchDelta: input.sizing.minimumMismatchDelta,
      alpha: input.sizing.alpha,
      cpConfidence: input.sizing.cpConfidence,
    })
    selectedPower = power.power
    input.log?.(
      `shared reference sizing ${selected.length} probes: hamming=${hamming}, `
      + `p0=${power.p0.toFixed(6)}, power=${power.power.toFixed(4)}, alpha=${input.sizing.alpha}`,
    )
    if (power.power >= input.sizing.minimumStatisticalPower) break
    if (input.sizing.mode === 'fixed') break
  }

  if (selectedPower < input.sizing.minimumStatisticalPower) {
    throw new Error(
      `shared reference remains underpowered at ${selected.length} probes `
      + `(${selectedPower.toFixed(4)} < ${input.sizing.minimumStatisticalPower})`,
    )
  }

  const materialized = await (dependencies.materialize ?? materializeAuditReference)({
    auditId: input.runId,
    service: input.service,
    source,
    probes: selected,
    selfTestOutcomes: selected.map((probe) => {
      const outcome = outcomes.get(probe.probeId)
      if (!outcome) throw new Error(`missing shared reference self-test outcome for ${probe.probeId}`)
      return outcome
    }),
    referencesDir: input.referencesDir,
    minimumMismatchDelta: input.sizing.minimumMismatchDelta,
    alpha: input.sizing.alpha,
    cpConfidence: input.sizing.cpConfidence,
    minimumPower: input.sizing.minimumStatisticalPower,
    now,
  })

  return {
    reference: materialized.reference,
    outPath: materialized.outPath,
    certificationHash: profileHash,
    queryProfileHash: queryProfileHash(materialized.reference.queryProfile),
    trust: source.upstream.trust ?? 'trusted',
    contrastModels: [...source.contrastModels],
  }
}

function validateSizing(sizing: BenchmarkReferenceSizing): void {
  for (const [name, value] of [
    ['minimumProbeCount', sizing.minimumProbeCount],
    ['maximumProbeCount', sizing.maximumProbeCount],
    ['probeStep', sizing.probeStep],
  ] as const) {
    if (!Number.isInteger(value) || value < 10 || value > KBF_MAX_PROBE_COUNT || value % 10 !== 0) {
      throw new Error(`${name} must be a multiple of 10 from 10 through ${KBF_MAX_PROBE_COUNT}`)
    }
  }
  if (sizing.minimumProbeCount > sizing.maximumProbeCount) {
    throw new Error('minimumProbeCount must not exceed maximumProbeCount')
  }
  if (sizing.mode === 'fixed' && sizing.minimumProbeCount !== sizing.maximumProbeCount) {
    throw new Error('fixed benchmark sizing requires equal minimum and maximum probe counts')
  }
  if (!(sizing.minimumStatisticalPower > 0 && sizing.minimumStatisticalPower <= 1)) {
    throw new Error('minimumStatisticalPower must be in (0, 1]')
  }
  if (!(sizing.minimumMismatchDelta > 0 && sizing.minimumMismatchDelta <= 1)) {
    throw new Error('minimumMismatchDelta must be in (0, 1]')
  }
  if (!(sizing.alpha > 0 && sizing.alpha < 1)) throw new Error('alpha must be in (0, 1)')
  if (!(sizing.cpConfidence > 0 && sizing.cpConfidence < 1)) {
    throw new Error('cpConfidence must be in (0, 1)')
  }
}

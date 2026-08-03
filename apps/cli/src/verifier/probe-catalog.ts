import {
  canonicalHash,
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  sha256Hex,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceV1,
  type ReferenceQueryProfileV1,
} from '@antseed/fingerprints'
import type { StoredCertifiedKbfProbe, VerificationStorage } from '@antseed/node'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ADAPTIVE_KBF_GENERATOR_NAME,
  ADAPTIVE_KBF_GENERATOR_VERSION,
} from './adaptive-probes.js'
import {
  DEFAULT_KBF_MAX_TOKENS_PER_REQUEST,
  buildKbfReference,
  endpointConfigHash,
  executeKbfSelfTest,
  kbfFactualIdentity,
} from './reference-builder.js'
import type { ResolvedReferenceSource } from './reference-config.js'
import { safeServiceSlug } from './slug.js'

export interface CertificationResult {
  probes: StoredCertifiedKbfProbe[]
  generated: number
  inserted: number
  known: number
  rejected: number
  unhealthy: number
  requestCount: number
  retryCount: number
  failureCount: number
}

export interface FreshSelfTestResult {
  outcomes: Array<{ probeId: string; answer: number | null; match: 0 | 1 | null }>
  requestCount: number
  retryCount: number
  failureCount: number
}

export function maximumAvailabilityDeficit(minimumProbeCount: number, eligibleCounts: readonly number[]): number {
  return Math.max(0, ...eligibleCounts.map((count) => minimumProbeCount - count))
}

export function nextAdaptiveProbeCount(current: number, step: number, maximum: number): number {
  return Math.min(maximum, current + step)
}

export function certificationProfileHash(source: ResolvedReferenceSource): string {
  const queryProfile = createReferenceQueryProfile({
    upstreamModel: source.model,
    maxTokensPerRequest: DEFAULT_KBF_MAX_TOKENS_PER_REQUEST,
    requestTimeoutMs: source.policy.requestTimeoutMs,
  })
  return canonicalHash({
    endpoint: {
      baseUrl: source.upstream.baseUrl.trim().replace(/\/+$/, ''),
      sourceId: source.upstream.sourceId ?? 'legacy-upstream',
      trust: source.upstream.trust ?? 'trusted',
      antseedPeerId: source.upstream.antseedPeerId ?? null,
    },
    model: source.model,
    contrastModels: source.contrastModels,
    generator: { name: ADAPTIVE_KBF_GENERATOR_NAME, version: ADAPTIVE_KBF_GENERATOR_VERSION },
    queryProfile,
  })
}

export function catalogProbeIds(storage: VerificationStorage, service: string, source: ResolvedReferenceSource, now = Date.now()): Set<string> {
  return new Set(storage.listCertifiedKbfProbes(service, certificationProfileHash(source), now).map((row) => row.probeId))
}

export function eligibleCatalogProbes(input: {
  storage: VerificationStorage
  agentId: string
  service: string
  source: ResolvedReferenceSource
  auditId?: string
  now?: number
}): StoredCertifiedKbfProbe[] {
  const exposed = input.storage.getProbeExposureCounts(input.agentId, input.service)
  const reserved = new Set(input.storage.listActiveReservedProbeIds(
    input.agentId,
    input.service,
    input.auditId ?? '',
  ))
  return input.storage.listCertifiedKbfProbes(
    input.service,
    certificationProfileHash(input.source),
    input.now ?? Date.now(),
  ).filter((probe) => !exposed.has(probe.probeId) && !reserved.has(probe.probeId))
}

export function selectCatalogProbes(
  auditId: string,
  probes: readonly StoredCertifiedKbfProbe[],
  count: number,
): StoredCertifiedKbfProbe[] {
  if (!Number.isInteger(count) || count < 10 || count > 500 || count % 10 !== 0) {
    throw new Error('audit probe count must be a multiple of 10 from 10 through 500')
  }
  if (probes.length < count) throw new Error(`only ${probes.length} eligible certified probes are available`)
  return [...probes]
    .sort((left, right) => sha256Hex(`${auditId}:${left.probeId}`).localeCompare(sha256Hex(`${auditId}:${right.probeId}`)))
    .slice(0, count)
}

export async function certifyNewProbes(input: {
  storage: VerificationStorage
  service: string
  source: ResolvedReferenceSource
  requiredCount: number
  minimumCertifiedCount?: number
  referencesDir: string
  excludedProbeIds?: ReadonlySet<string>
  maxRequests?: number
  fetchFn?: typeof fetch
  log?: (message: string) => void
  now?: number
}): Promise<CertificationResult> {
  if (input.requiredCount <= 0) {
    return { probes: [], generated: 0, inserted: 0, known: 0, rejected: 0, unhealthy: 0, requestCount: 0, retryCount: 0, failureCount: 0 }
  }
  const now = input.now ?? Date.now()
  const profileHash = certificationProfileHash(input.source)
  const existing = input.storage.listCertifiedKbfProbes(input.service, profileHash, now)
  const excludedIds = new Set([...existing.map((probe) => probe.probeId), ...(input.excludedProbeIds ?? [])])
  const excludedFacts = new Set(existing.map((probe) => kbfFactualIdentity(probe.probe as unknown as KbfProbe)))
  const requested = Math.max(10, Math.ceil(input.requiredCount / 10) * 10)
  const minimumCertifiedCount = input.minimumCertifiedCount ?? requested
  if (minimumCertifiedCount < 100 && input.source.upstream.trust !== 'smoke') {
    throw new Error('sub-100 probe certification is allowed only for smoke reference endpoints')
  }
  const maxRequests = input.maxRequests ?? input.source.policy.maxRequestsPerRound
  if (maxRequests < 1) throw new Error('round reference request budget exhausted')
  const minimumMismatchDelta = minimumCertifiedCount < 100 && input.source.upstream.trust === 'smoke'
    ? 0.25
    : 0.1
  const reference = await buildKbfReference(input.source.upstream, {
    model: input.source.model,
    service: input.service,
    aliases: [input.service.trim().toLowerCase()],
    contrastModels: input.source.contrastModels,
    candidateCount: requested,
    minProbes: requested,
    minimumPower: input.source.policy.minimumStatisticalPower,
    minimumAcceptedProbes: minimumCertifiedCount,
    minimumMismatchDelta,
    maxRequestsPerBuild: maxRequests,
    maxTokensPerRequest: DEFAULT_KBF_MAX_TOKENS_PER_REQUEST,
    requestTimeoutMs: input.source.policy.requestTimeoutMs,
    batchRetryCount: input.source.policy.batchRetryCount,
    generationDomainConcurrency: input.source.policy.generationDomainConcurrency,
    maxConcurrentReferenceRequests: input.source.policy.maxConcurrentReferenceRequests,
    maxConcurrentRequestsPerModel: input.source.policy.maxConcurrentRequestsPerModel,
    excludedProbeIds: [...excludedIds],
    excludedFactualIdentities: [...excludedFacts],
    checkpointPath: join(input.referencesDir, '.checkpoints', `catalog-${profileHash.replace(/^sha256:/, '').slice(0, 20)}.json`),
    generationCheckpointFallbackPaths: excludedIds.size === 0 && excludedFacts.size === 0
      ? [...new Set([
          legacyReferenceCheckpointPath(input.referencesDir, input.service, input.source, requested),
          legacyReferenceCheckpointPath(input.referencesDir, input.service, input.source, 100),
        ])]
      : [],
    fetchFn: input.fetchFn,
    log: input.log,
  })
  const params = reference.generator.params as Record<string, unknown>
  const rows = reference.probes.slice(0, input.requiredCount).map((probe): StoredCertifiedKbfProbe => ({
    service: input.service.trim().toLowerCase(),
    certificationHash: profileHash,
    probeId: probe.id,
    probe: probe as unknown as Record<string, unknown>,
    certification: {
      endpointConfigHash: params.endpointConfigHash,
      contrastModels: input.source.contrastModels,
      enrollmentAnswers: probe.enrollmentAnswers ?? [],
      contrast: probe.contrast ?? null,
      factualIdentity: kbfFactualIdentity(probe),
      generator: reference.generator,
    },
    queryProfile: reference.queryProfile as unknown as Record<string, unknown>,
    sourceId: input.source.upstream.sourceId ?? 'legacy-upstream',
    trust: input.source.upstream.trust ?? 'trusted',
    certifiedAt: now,
    expiresAt: now + input.source.policy.maxReferenceAgeDays * 86_400_000,
    healthy: true,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  }))
  const persisted = input.storage.upsertCertifiedKbfProbes(rows)
  return {
    probes: rows,
    generated: reference.probes.length,
    inserted: persisted.inserted,
    known: persisted.known,
    rejected: Math.max(0, requested - rows.length),
    unhealthy: 0,
    requestCount: Number(params.requestCount ?? 0),
    retryCount: Number(params.retryCount ?? 0),
    failureCount: Number(params.failureCount ?? 0),
  }
}

export function legacyReferenceCheckpointPath(
  referencesDir: string,
  service: string,
  source: ResolvedReferenceSource,
  requestedProbeCount: number,
): string {
  const identity = canonicalHash({
    baseUrl: source.upstream.baseUrl.trim().replace(/\/+$/, ''),
    sourceId: source.upstream.sourceId ?? 'legacy-upstream',
    trust: source.upstream.trust ?? 'trusted',
    antseedPeerId: source.upstream.antseedPeerId ?? null,
    model: source.model,
    service,
    contrastModels: source.contrastModels,
    candidateCount: requestedProbeCount,
    minProbes: requestedProbeCount,
    generator: { name: ADAPTIVE_KBF_GENERATOR_NAME, version: ADAPTIVE_KBF_GENERATOR_VERSION },
  }).replace(/^sha256:/, '').slice(0, 20)
  return join(referencesDir, '.checkpoints', `${safeServiceSlug(service)}-${identity}.json`)
}

export function importAdaptiveReferences(input: {
  storage: VerificationStorage
  service: string
  source: ResolvedReferenceSource
  references: readonly KbfReferenceV1[]
  now?: number
}): { references: number; probes: number } {
  const now = input.now ?? Date.now()
  const profileHash = certificationProfileHash(input.source)
  let importedReferences = 0
  let importedProbes = 0
  for (const reference of input.references) {
    if (input.storage.hasImportedCertifiedKbfReference(reference.referenceId)) continue
    if (reference.generator.name !== ADAPTIVE_KBF_GENERATOR_NAME
      || reference.generator.version !== ADAPTIVE_KBF_GENERATOR_VERSION) continue
    if ((reference.generator.params as Record<string, unknown>).auditId !== undefined) continue
    if (Date.parse(reference.createdAt) + input.source.policy.maxReferenceAgeDays * 86_400_000 <= now) continue
    const expectedEndpointHash = endpointConfigHash({
      upstream: input.source.upstream,
      model: input.source.model,
      contrastModels: input.source.contrastModels,
      queryProfile: reference.queryProfile,
    })
    if ((reference.generator.params as Record<string, unknown>).endpointConfigHash !== expectedEndpointHash) continue
    const certifiedAt = Date.parse(reference.createdAt)
    const rows = reference.probes.map((probe): StoredCertifiedKbfProbe => ({
      service: input.service.trim().toLowerCase(),
      certificationHash: profileHash,
      probeId: probe.id,
      probe: probe as unknown as Record<string, unknown>,
      certification: {
        endpointConfigHash: expectedEndpointHash,
        contrastModels: input.source.contrastModels,
        enrollmentAnswers: probe.enrollmentAnswers ?? [],
        contrast: probe.contrast ?? null,
        factualIdentity: kbfFactualIdentity(probe),
        importedFromReferenceId: reference.referenceId,
        generator: reference.generator,
      },
      queryProfile: reference.queryProfile as unknown as Record<string, unknown>,
      sourceId: input.source.upstream.sourceId ?? 'legacy-upstream',
      trust: input.source.upstream.trust ?? 'trusted',
      certifiedAt,
      expiresAt: certifiedAt + input.source.policy.maxReferenceAgeDays * 86_400_000,
      healthy: true,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    }))
    const result = input.storage.upsertCertifiedKbfProbes(rows)
    input.storage.recordCertifiedKbfReferenceImport(reference.referenceId, profileHash, result.inserted, now)
    importedReferences += 1
    importedProbes += result.inserted
  }
  return { references: importedReferences, probes: importedProbes }
}

export async function freshSelfTestProbes(input: {
  source: ResolvedReferenceSource
  probes: readonly StoredCertifiedKbfProbe[]
  maxRequests: number
  fetchFn?: typeof fetch
  log?: (message: string) => void
}): Promise<FreshSelfTestResult> {
  if (input.probes.length === 0) return { outcomes: [], requestCount: 0, retryCount: 0, failureCount: 0 }
  const queryProfile = input.probes[0]!.queryProfile as unknown as ReferenceQueryProfileV1
  const padded = [...input.probes]
  for (let index = 0; padded.length % 10 !== 0; index += 1) padded.push(input.probes[index % input.probes.length]!)
  const execution = await executeKbfSelfTest(
    input.source.upstream,
    input.source.model,
    padded.map((row) => row.probe as unknown as KbfProbe),
    {
      queryProfile,
      maxRequests: input.maxRequests,
      batchRetryCount: input.source.policy.batchRetryCount,
      maxConcurrentReferenceRequests: input.source.policy.maxConcurrentReferenceRequests,
      maxConcurrentRequestsPerModel: input.source.policy.maxConcurrentRequestsPerModel,
      fetchFn: input.fetchFn,
      log: input.log,
    },
  )
  return {
    outcomes: input.probes.map((probe, index) => ({
      probeId: probe.probeId,
      answer: execution.answers[index] ?? null,
      match: execution.matches[index] ?? null,
    })),
    requestCount: execution.requestCount,
    retryCount: execution.retryCount,
    failureCount: execution.failureCount,
  }
}

export async function materializeAuditReference(input: {
  auditId: string
  service: string
  source: ResolvedReferenceSource
  probes: readonly StoredCertifiedKbfProbe[]
  selfTestOutcomes: readonly { probeId: string; answer: number | null; match: 0 | 1 | null }[]
  referencesDir: string
  now?: number
}): Promise<{ reference: KbfReferenceV1; outPath: string }> {
  const probes = input.probes.map((row) => row.probe as unknown as KbfProbe)
  const outcomesById = new Map(input.selfTestOutcomes.map((outcome) => [outcome.probeId, outcome]))
  const outcomes = probes.map((probe) => outcomesById.get(probe.id) ?? { probeId: probe.id, answer: null, match: null })
  const total = probes.length
  const matched = outcomes.filter((outcome) => outcome.match === 1).length
  const parsed = outcomes.filter((outcome) => outcome.match !== null).length
  const hamming = total - matched
  const minimumMismatchDelta = total < 100 && input.source.upstream.trust === 'smoke' ? 0.25 : 0.1
  const power = computeBinomialPower({ selfHamming: hamming, selfTotal: total, minimumMismatchDelta })
  if (power.power < input.source.policy.minimumStatisticalPower) {
    throw new Error(`audit ${input.auditId} reference power ${power.power.toFixed(4)} is below ${input.source.policy.minimumStatisticalPower}`)
  }
  const queryProfile = input.probes[0]!.queryProfile as unknown as ReferenceQueryProfileV1
  const configHash = endpointConfigHash({
    upstream: input.source.upstream,
    model: input.source.model,
    contrastModels: input.source.contrastModels,
    queryProfile,
  })
  const reference: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: input.service.trim().toLowerCase(),
    serviceAliases: [...new Set([input.service, input.source.model].map((value) => value.trim().toLowerCase()))],
    createdAt: new Date(input.now ?? Date.now()).toISOString(),
    source: 'generated',
    generator: {
      name: ADAPTIVE_KBF_GENERATOR_NAME,
      version: ADAPTIVE_KBF_GENERATOR_VERSION,
      verifierKind: 'kbf',
      params: {
        auditId: input.auditId,
        sourceId: input.source.upstream.sourceId ?? 'legacy-upstream',
        trust: input.source.upstream.trust ?? 'trusted',
        endpointConfigHash: configHash,
        certificationProfileHash: certificationProfileHash(input.source),
        antseedPeerId: input.source.upstream.antseedPeerId ?? null,
        upstreamModel: input.source.model,
        contrastModels: input.source.contrastModels,
        queryProfile,
      },
    },
    provenance: {
      sourceId: input.source.upstream.sourceId ?? 'legacy-upstream',
      trust: input.source.upstream.trust ?? 'trusted',
      endpointConfigHash: configHash,
      referenceProvider: input.source.upstream.antseedPeerId
        ? `antseed-peer:${input.source.upstream.antseedPeerId}`
        : 'direct-api',
    },
    queryProfile,
    selfTest: {
      hamming,
      total,
      coverage: total === 0 ? 0 : parsed / total,
      errorRate: total === 0 ? 1 : hamming / total,
      outcomes,
      freshAt: new Date(input.now ?? Date.now()).toISOString(),
    },
    probes,
    selectedProbeCount: total,
    minimumMismatchDelta,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: hamming,
      selfTotal: total,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: input.source.contrastModels.map((model) => ({
      model,
      distinguishingProbeIds: probes.filter((probe) => {
        const distinguishing = (probe.contrast as { distinguishingModels?: string[] } | undefined)?.distinguishingModels
        return distinguishing?.includes(model) ?? false
      }).map((probe) => probe.id),
    })),
  }
  reference.referenceId = computeReferenceId(reference)
  const validated = validateKbfReferenceV1(reference)
  await mkdir(input.referencesDir, { recursive: true })
  const outPath = join(
    input.referencesDir,
    `${input.service.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}-${input.auditId.replace(/^0x/, '').slice(0, 12)}-${validated.referenceId.replace(/^sha256:/, '').slice(0, 16)}.json`,
  )
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tempPath, 'wx')
  try {
    await handle.writeFile(JSON.stringify(validated, null, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tempPath, outPath)
  return { reference: validated, outPath }
}

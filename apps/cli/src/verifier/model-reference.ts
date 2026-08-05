import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  KBF_ENROLLMENT_TEMPERATURES,
  KBF_PROBES_PER_REQUEST,
  buildKbfChatRequestBody,
  canonicalHashBytes32,
  computeBinomialPower,
  computeMatchVector,
  computeReferenceId,
  createReferenceQueryProfile,
  matchesTolerance,
  parseKbfAnswers,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig, VerifierReferenceEndpointConfig } from '../config/types.js'
import {
  REFERENCE_MINIMUM_MISMATCH_DELTA,
  REFERENCE_POWER_ALPHA,
  REFERENCE_POWER_CONFIDENCE,
  isReferenceProbeCountAllowed,
  resolveReferenceSizingPolicy,
} from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'
import {
  CANONICAL_KBF_DOMAINS,
  canonicalKbfTolerance,
  createCanonicalKbfProbe,
} from './canonical-kbf-domains.js'

const CANDIDATE_COUNT = 300
const CANDIDATE_BATCH_SIZE = 20
const DEFAULT_MAX_REQUESTS_PER_BUILD = 2_000
const DEFAULT_BATCH_RETRY_COUNT = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 500
const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 3
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4
const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_MODEL = 3
const MAX_TOKENS = 1600
const REFERENCE_SIZING_ALGORITHM_VERSION = 2
const REFERENCE_REASONING_STRATEGY = 'reasoning-effort-none' as const
const REFERENCE_REQUEST_OVERRIDES = { reasoning_effort: 'none' }

interface CollectedReferenceProbes {
  probes: KbfProbe[]
  candidateCount: number
  distinguishingProbeIdsByModel: Map<string, string[]>
  generatedProbeIds: Set<string>
  reserveProbes: KbfProbe[]
  generationRound: number
}

interface ReferenceBuildCheckpointV1 {
  version: 1
  kind: 'antseed-reference-build-checkpoint'
  compatibilityHash: string
  requestsUsed: number
  responses: Record<string, string>
}

type ReferenceQuery = ((model: string, body: Record<string, unknown>) => Promise<string>) & {
  invalidate?: (model: string, body: Record<string, unknown>) => Promise<void>
}

export async function loadModelReference(input: {
  model: string
  referencesDir: string
  config?: VerifierCLIConfig
}): Promise<{ reference: KbfReferenceV1; path: string }> {
  const path = referencePath(input.referencesDir, input.model)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no reference exists for ${input.model}; run antseed verifier reference build ${input.model}`)
    }
    throw error
  }
  try {
    const sizing = resolveReferenceSizingPolicy(input.config)
    const reference = validateKbfReferenceV1(JSON.parse(raw), {
      trustImported: true,
      minimumStatisticalPower: Number.EPSILON,
    })
    if (!reference.serviceAliases.some((alias) => normalized(alias) === normalized(input.model))) {
      throw new Error(`reference does not include service alias ${input.model}`)
    }
    if (!isReferenceProbeCountAllowed(reference.probes.length, sizing)) {
      throw new Error(
        `reference probe count ${reference.probes.length} is outside the configured adaptive sizing sequence`,
      )
    }
    if (Math.abs(reference.minimumMismatchDelta - REFERENCE_MINIMUM_MISMATCH_DELTA) > 1e-12) {
      throw new Error(`reference minimumMismatchDelta must be ${REFERENCE_MINIMUM_MISMATCH_DELTA}`)
    }
    if (Math.abs(reference.statisticalPowerEvidence.alpha - REFERENCE_POWER_ALPHA) > 1e-12) {
      throw new Error(`reference statistical power alpha must be ${REFERENCE_POWER_ALPHA}`)
    }
    if (Math.abs(
      reference.statisticalPowerEvidence.clopperPearsonConfidence - REFERENCE_POWER_CONFIDENCE,
    ) > 1e-12) {
      throw new Error(
        `reference Clopper-Pearson confidence must be ${REFERENCE_POWER_CONFIDENCE}`,
      )
    }
    if (reference.statisticalPower < sizing.minimumStatisticalPower) {
      throw new Error(
        `reference statistical power ${reference.statisticalPower.toFixed(3)} is below `
        + sizing.minimumStatisticalPower.toFixed(3),
      )
    }
    return { reference, path }
  } catch (error) {
    throw new Error(`invalid reference for ${input.model}: ${asError(error).message}; run antseed verifier reference build ${input.model}`)
  }
}

export async function buildModelReference(input: {
  model: string
  referencesDir: string
  config: VerifierCLIConfig | undefined
  fetchFn?: typeof fetch
  log?: (message: string) => void
}): Promise<{ reference: KbfReferenceV1; path: string }> {
  const endpoint = input.config?.referenceEndpoint
  const modelConfig = endpoint && findModelConfig(endpoint, input.model)
  if (!endpoint || !modelConfig) {
    throw new Error(`verifier.referenceEndpoint.models has no mapping for ${input.model}`)
  }
  const apiKey = (endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined) ?? endpoint.apiKey
  const timeoutMs = input.config?.probeRequestTimeoutMs ?? 120_000
  const sizing = resolveReferenceSizingPolicy(input.config)
  const checkpointPath = join(input.referencesDir, '.checkpoints', `${safeServiceSlug(input.model)}.json`)
  const compatibilityHash = canonicalHashBytes32({
    version: 1,
    model: normalized(input.model),
    endpoint: {
      baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
      sourceId: endpoint.sourceId,
      trust: endpoint.trust,
      antseedPeerId: endpoint.antseedPeerId ?? null,
    },
    modelConfig,
    sizing,
    minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
    sizingAlgorithmVersion: REFERENCE_SIZING_ALGORITHM_VERSION,
    candidateCountPerRound: CANDIDATE_COUNT,
    candidateBatchSize: CANDIDATE_BATCH_SIZE,
    candidatePromptVersion: 3,
    timeoutMs,
    reasoningStrategy: REFERENCE_REASONING_STRATEGY,
    requestOverrides: REFERENCE_REQUEST_OVERRIDES,
  })
  const checkpoint = await ReferenceBuildCheckpoint.open(checkpointPath, compatibilityHash)
  const limiter = new AdaptiveRequestLimiter(
    input.config?.referenceMaxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    input.config?.referenceMaxConcurrentRequestsPerModel ?? DEFAULT_MAX_CONCURRENT_REQUESTS_PER_MODEL,
  )
  const query = createReferenceQuery({
    endpoint,
    apiKey,
    timeoutMs,
    fetchFn: input.fetchFn ?? fetch,
    checkpoint,
    limiter,
    maxRequests: input.config?.referenceMaxRequestsPerBuild ?? DEFAULT_MAX_REQUESTS_PER_BUILD,
    retryCount: input.config?.referenceBatchRetryCount ?? DEFAULT_BATCH_RETRY_COUNT,
    retryBaseDelayMs: input.config?.referenceRetryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    log: input.log,
  })
  let collected: CollectedReferenceProbes | undefined
  const selfAnswers: Array<number | null> = []
  let selected: {
    probes: KbfProbe[]
    matches: Array<0 | 1 | null>
    answers: Array<number | null>
    power: ReturnType<typeof computeBinomialPower>
  } | null = null
  try {
    for (let targetCount = sizing.minimumProbeCount;
      targetCount <= sizing.maximumProbeCount;
      targetCount += sizing.probeStep) {
      collected = await collectReferenceProbes({
        model: modelConfig.upstreamModel,
        contrastModels: modelConfig.contrastModels,
        targetCount,
        candidateCountPerRound: CANDIDATE_COUNT,
        maxNoProgressRounds: input.config?.referenceMaxNoProgressRounds ?? DEFAULT_MAX_NO_PROGRESS_ROUNDS,
        query,
        log: input.log,
        initial: collected,
      })
      const additions = collected.probes.slice(selfAnswers.length, targetCount)
      if (additions.length > 0) {
        input.log?.(`self-testing ${selfAnswers.length + 1}-${targetCount} of ${targetCount} probes`)
        selfAnswers.push(...await queryProbeAnswers(
          modelConfig.upstreamModel,
          additions,
          0,
          'self-test',
          query,
        ))
      }
      const probes = collected.probes.slice(0, targetCount)
      const answers = selfAnswers.slice(0, targetCount)
      const matches = computeMatchVector(answers, probes)
      const parsed = matches.filter((match) => match !== null).length
      const hamming = matches.filter((match) => match !== 1).length
      const coverage = parsed / targetCount
      const errorRate = hamming / targetCount
      const power = computeBinomialPower({
        selfHamming: hamming,
        selfTotal: targetCount,
        minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
        alpha: REFERENCE_POWER_ALPHA,
        cpConfidence: REFERENCE_POWER_CONFIDENCE,
      })
      input.log?.(
        `reference size ${targetCount}: power ${power.power.toFixed(3)}, `
        + `self-test ${hamming}/${targetCount}, coverage ${coverage.toFixed(3)}`,
      )
      if (coverage >= 0.8 && errorRate <= 0.35 && power.power >= sizing.minimumStatisticalPower) {
        selected = { probes, matches, answers, power }
        break
      }
    }
  } catch (error) {
    if (asError(error).message.includes('reference generation made no progress')) await checkpoint.remove()
    throw error
  }
  if (!collected || !selected) {
    throw new Error(
      `reference remains underpowered at ${sizing.maximumProbeCount} probes; `
      + `required power ${sizing.minimumStatisticalPower.toFixed(3)}`,
    )
  }
  const { probes, matches, answers, power } = selected
  const parsed = matches.filter((match) => match !== null).length
  const hamming = matches.filter((match) => match !== 1).length
  const selfTest = {
    hamming,
    total: probes.length,
    coverage: parsed / probes.length,
    errorRate: hamming / probes.length,
    outcomes: probes.map((probe, index) => ({ probeId: probe.id, answer: answers[index] ?? null, match: matches[index]! })),
  }
  if (selfTest.coverage < 0.8) {
    await checkpoint.remove()
    throw new Error(`self-test coverage ${selfTest.coverage.toFixed(3)} is below 0.8`)
  }
  if (selfTest.errorRate > 0.35) {
    await checkpoint.remove()
    throw new Error(`self-test error rate ${selfTest.errorRate.toFixed(3)} exceeds 0.35`)
  }
  const queryProfile = createReferenceQueryProfile({
    upstreamModel: modelConfig.upstreamModel,
    maxTokensPerRequest: MAX_TOKENS,
    requestTimeoutMs: timeoutMs,
  })
  queryProfile.reasoningStrategy = REFERENCE_REASONING_STRATEGY
  queryProfile.requestOverrides = REFERENCE_REQUEST_OVERRIDES
  const reference: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: input.model,
    serviceAliases: [normalized(input.model)],
    createdAt: new Date().toISOString(),
    source: 'generated',
    generator: {
      name: 'antseed-simple-reference-builder',
      version: '2',
      verifierKind: 'kbf',
      params: {
        sourceId: endpoint.sourceId,
        upstreamModel: modelConfig.upstreamModel,
        candidateCount: collected.candidateCount,
        sizing,
        sizingAlgorithmVersion: REFERENCE_SIZING_ALGORITHM_VERSION,
      },
    },
    provenance: { sourceId: endpoint.sourceId, trust: endpoint.trust },
    queryProfile,
    selfTest,
    probes,
    selectedProbeCount: probes.length,
    minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: REFERENCE_POWER_ALPHA,
      clopperPearsonConfidence: REFERENCE_POWER_CONFIDENCE,
      selfHamming: hamming,
      selfTotal: probes.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: modelConfig.contrastModels.map((model) => ({
      model,
      distinguishingProbeIds: (collected.distinguishingProbeIdsByModel.get(model) ?? [])
        .filter((probeId) => probes.some((probe) => probe.id === probeId)),
    })),
  }
  reference.referenceId = computeReferenceId(reference)
  const validated = validateKbfReferenceV1(reference, {
    minimumStatisticalPower: sizing.minimumStatisticalPower,
  })
  const path = referencePath(input.referencesDir, input.model)
  await writeReference(path, validated)
  await checkpoint.remove()
  return { reference: validated, path }
}

export async function collectReferenceProbes(input: {
  model: string
  contrastModels: readonly string[]
  targetCount: number
  query: ReferenceQuery
  candidateCountPerRound?: number
  maxNoProgressRounds?: number
  log?: (message: string) => void
  initial?: CollectedReferenceProbes
}): Promise<CollectedReferenceProbes> {
  assertPositiveInteger(input.targetCount, 'targetCount')
  const candidateCountPerRound = input.candidateCountPerRound ?? Math.max(CANDIDATE_COUNT, input.targetCount * 3)
  const maxNoProgressRounds = input.maxNoProgressRounds ?? DEFAULT_MAX_NO_PROGRESS_ROUNDS
  assertPositiveInteger(candidateCountPerRound, 'candidateCountPerRound')
  assertPositiveInteger(maxNoProgressRounds, 'maxNoProgressRounds')

  const state = input.initial ?? {
    probes: [],
    candidateCount: 0,
    distinguishingProbeIdsByModel: new Map(input.contrastModels.map((model) => [model, [] as string[]])),
    generatedProbeIds: new Set<string>(),
    reserveProbes: [],
    generationRound: 0,
  }
  const promote = (probe: KbfProbe): void => {
    state.probes.push(probe)
    const distinguishingModels = (probe.contrast as { distinguishingModels?: string[] } | undefined)
      ?.distinguishingModels ?? []
    for (const model of distinguishingModels) state.distinguishingProbeIdsByModel.get(model)?.push(probe.id)
  }
  while (state.probes.length < input.targetCount && state.reserveProbes.length > 0) promote(state.reserveProbes.shift()!)
  let noProgressRounds = 0

  while (state.probes.length < input.targetCount) {
    state.generationRound += 1
    input.log?.(`generation round ${state.generationRound}: collecting ${state.probes.length}/${input.targetCount} probes`)
    const generated = await generateCandidates(input.model, candidateCountPerRound, state.generationRound, input.query)
    const candidates = generated.filter((probe) => {
      if (state.generatedProbeIds.has(probe.id)) return false
      state.generatedProbeIds.add(probe.id)
      return true
    })
    state.candidateCount = state.generatedProbeIds.size
    input.log?.(`generation round ${state.generationRound}: testing ${candidates.length} new candidates for stability`)
    const stable = await certifyStableProbes(input.model, candidates, input.query)
    const contrastOutcomes = await queryContrastOutcomes(stable, input.contrastModels, input.query, input.log)
    const accepted = stable.filter((probe) => input.contrastModels.length === 0
      || (contrastOutcomes.get(probe.id)?.length ?? 0) > 0)
    const prepared = accepted.map((probe) => {
      const distinguishingModels = contrastOutcomes.get(probe.id) ?? []
      return {
        ...probe,
        ...(distinguishingModels.length > 0 ? { contrast: { distinguishingModels } } : {}),
      }
    })
    const selected = prepared.slice(0, input.targetCount - state.probes.length)
    for (const probe of selected) promote(probe)
    state.reserveProbes.push(...prepared.slice(selected.length))
    input.log?.(
      `generation round ${state.generationRound}: ${stable.length} stable, ${accepted.length} distinguish at least one contrast, `
      + `${state.probes.length}/${input.targetCount} selected`,
    )
    if (selected.length === 0) {
      noProgressRounds += 1
      if (noProgressRounds >= maxNoProgressRounds) {
        throw new Error(
          `reference generation made no progress for ${noProgressRounds} rounds; `
          + `collected ${state.probes.length}/${input.targetCount} probes from ${state.generatedProbeIds.size} unique candidates`,
        )
      }
    } else {
      noProgressRounds = 0
    }
  }

  return state
}

async function certifyStableProbes(
  model: string,
  candidates: readonly KbfProbe[],
  query: ReferenceQuery,
): Promise<KbfProbe[]> {
  if (candidates.length === 0) return []
  const passes = await Promise.all(KBF_ENROLLMENT_TEMPERATURES.map((temperature, passIndex) => {
    return queryProbeAnswers(model, candidates, temperature, `stability-${passIndex}`, query)
  }))
  return candidates.flatMap((probe, index) => {
    const values = passes.map((pass) => pass[index] ?? null).filter((value): value is number => value !== null)
    if (values.length !== passes.length) return []
    const consensus = median(values)
    if (consensus < probe.range[0] || consensus > probe.range[1]) return []
    const certified = { ...probe, consensus, tolerance: canonicalKbfTolerance(probe.domain) }
    return values.every((value) => matchesTolerance(value, certified)) ? [certified] : []
  })
}

async function queryContrastOutcomes(
  probes: readonly KbfProbe[],
  contrastModels: readonly string[],
  query: ReferenceQuery,
  log?: (message: string) => void,
): Promise<Map<string, string[]>> {
  const outcomes = new Map(probes.map((probe) => [probe.id, [] as string[]]))
  const answersByModel = await Promise.all(contrastModels.map(async (contrastModel) => {
    log?.(`checking contrast model ${contrastModel}`)
    return queryProbeAnswers(contrastModel, probes, 0, `contrast-${contrastModel}`, query, {
      allowIncomplete: true,
      log,
    })
  }))
  for (const [modelIndex, contrastModel] of contrastModels.entries()) {
    const answers = answersByModel[modelIndex]!
    for (const [index, probe] of probes.entries()) {
      const answer = answers[index] ?? null
      if (answer !== null && !matchesTolerance(answer, probe)) outcomes.get(probe.id)!.push(contrastModel)
    }
  }
  return outcomes
}

function findModelConfig(endpoint: VerifierReferenceEndpointConfig, model: string) {
  return Object.entries(endpoint.models).find(([service]) => normalized(service) === normalized(model))?.[1]
}

async function generateCandidates(
  model: string,
  count: number,
  round: number,
  query: ReferenceQuery,
): Promise<KbfProbe[]> {
  const baseCount = Math.floor(count / CANONICAL_KBF_DOMAINS.length)
  const remainder = count % CANONICAL_KBF_DOMAINS.length
  const generatedByDomain = await Promise.all(CANONICAL_KBF_DOMAINS.map(async (definition, domainIndex) => {
    const countPerDomain = baseCount + (domainIndex < remainder ? 1 : 0)
    if (countPerDomain === 0) return []
    const probes: KbfProbe[] = []
    const seen = new Set<string>()
    for (let offset = 0; offset < countPerDomain; offset += CANDIDATE_BATCH_SIZE) {
      const batchSize = Math.min(CANDIDATE_BATCH_SIZE, countPerDomain - offset)
      const theme = definition.themes[(round + domainIndex - 1) % definition.themes.length]!
      const batch = offset / CANDIDATE_BATCH_SIZE + 1
      const prompt = canonicalCandidatePrompt(definition, batchSize, round, batch, theme)
      const body = {
        model,
        temperature: 0.7,
        max_tokens: 6000,
        messages: [
          { role: 'system', content: 'Create stable numeric factual-recall probes. Output only the requested list.' },
          { role: 'user', content: prompt },
        ],
      }
      const content = await query(model, body)
      for (const fact of parseCanonicalFacts(content, definition.range)) {
        const probe = createCanonicalKbfProbe({
          domainKey: definition.key,
          name: fact.name,
          consensus: fact.value,
          generationRound: round,
          generationTheme: theme,
        })
        if (!seen.has(probe.id)) {
          seen.add(probe.id)
          probes.push(probe)
        }
      }
    }
    return probes
  }))
  const probes: KbfProbe[] = []
  for (let index = 0; probes.length < count; index += 1) {
    let added = false
    for (const domainProbes of generatedByDomain) {
      const probe = domainProbes[index]
      if (!probe) continue
      probes.push(probe)
      added = true
      if (probes.length >= count) break
    }
    if (!added) break
  }
  return probes
}

function canonicalCandidatePrompt(
  definition: (typeof CANONICAL_KBF_DOMAINS)[number],
  count: number,
  round: number,
  batch: number,
  theme: string,
): string {
  return [
    `Generate exactly ${count} facts in canonical KBF domain ${definition.key} for generation round ${round}, batch ${batch}.`,
    `List ${definition.generationSubject}.`,
    `Focus on: ${theme}.`,
    difficultyInstruction(round),
    'Use only facts with one stable, defensible, finite numeric answer.',
    'Put units and scale in the fact name so the answer is only the number.',
    'Format every line exactly as: fact_name | numeric_value',
    'Output only the list. Do not choose a range or tolerance.',
  ].join('\n')
}

function difficultyInstruction(round: number): string {
  if (round <= 1) return 'Choose specialist-level facts and avoid textbook examples.'
  if (round === 2) return 'Choose very obscure facts unlikely to appear in general references.'
  return 'Choose frontier-obscure facts from specialist reference material.'
}

function parseCanonicalFacts(text: string, range: readonly [number, number]): Array<{ name: string; value: number }> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Array<{ name?: unknown; consensus?: unknown; value?: unknown }>
      return parsed.flatMap((entry) => {
        const value = typeof entry.consensus === 'number' ? entry.consensus : entry.value
        return typeof entry.name === 'string'
          && entry.name.trim().length > 0
          && entry.name.length <= 240
          && typeof value === 'number'
          && Number.isFinite(value)
          && value >= range[0]
          && value <= range[1]
          ? [{ name: entry.name.trim(), value }]
          : []
      })
    } catch {
      return []
    }
  }
  const facts: Array<{ name: string; value: number }> = []
  for (const rawLine of text.replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n')) {
    const line = rawLine.trim().replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, '')
    const separator = line.lastIndexOf('|')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().replaceAll('**', '')
    const numeric = line.slice(separator + 1).trim().replace(/[,_\s]/g, '').replace(/[−–]/g, '-')
    if (!name || name.length > 240 || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(numeric)) continue
    const value = Number(numeric)
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) continue
    facts.push({ name, value })
  }
  return facts
}

function createReferenceQuery(input: {
  endpoint: VerifierReferenceEndpointConfig
  apiKey: string | undefined
  timeoutMs: number
  fetchFn: typeof fetch
  checkpoint: ReferenceBuildCheckpoint
  limiter: AdaptiveRequestLimiter
  maxRequests: number
  retryCount: number
  retryBaseDelayMs: number
  log?: (message: string) => void
}): ReferenceQuery {
  assertPositiveInteger(input.maxRequests, 'referenceMaxRequestsPerBuild')
  assertNonNegativeInteger(input.retryCount, 'referenceBatchRetryCount')
  assertPositiveInteger(input.retryBaseDelayMs, 'referenceRetryBaseDelayMs')
  const query: ReferenceQuery = async (model, body) => {
    const { __antseedReferenceCacheDomain, ...requestBody } = body
    const cacheKey = canonicalHashBytes32({ model, cacheDomain: __antseedReferenceCacheDomain ?? null, body: requestBody })
    const cached = input.checkpoint.get(cacheKey)
    if (cached !== undefined) return cached
    let attempt = 0
    for (;;) {
      attempt += 1
      await input.checkpoint.reserveRequest(input.maxRequests)
      try {
        const content = await input.limiter.run(model, () => postChatCompletion(
          input.endpoint,
          input.apiKey,
          model,
          requestBody,
          input.timeoutMs,
          input.fetchFn,
        ))
        await input.checkpoint.set(cacheKey, content)
        input.limiter.recordSuccess()
        return content
      } catch (error) {
        const retryable = isRetryableReferenceError(error)
        if (!retryable || attempt >= input.retryCount + 1) throw error
        input.limiter.recordThrottle(error)
        const delayMs = retryDelayMs(error, input.retryBaseDelayMs, attempt)
        input.log?.(`reference request retry ${attempt}/${input.retryCount + 1} for ${model} in ${delayMs}ms: ${asError(error).message}`)
        await sleep(delayMs)
      }
    }
  }
  query.invalidate = async (model, body) => {
    const { __antseedReferenceCacheDomain, ...requestBody } = body
    const cacheKey = canonicalHashBytes32({ model, cacheDomain: __antseedReferenceCacheDomain ?? null, body: requestBody })
    await input.checkpoint.delete(cacheKey)
  }
  return query
}

class ReferenceBuildCheckpoint {
  private saveChain = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly value: ReferenceBuildCheckpointV1,
  ) {}

  static async open(path: string, compatibilityHash: string): Promise<ReferenceBuildCheckpoint> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ReferenceBuildCheckpointV1>
      if (parsed.version === 1
        && parsed.kind === 'antseed-reference-build-checkpoint'
        && parsed.compatibilityHash === compatibilityHash
        && Number.isInteger(parsed.requestsUsed)
        && parsed.requestsUsed! >= 0
        && parsed.responses
        && typeof parsed.responses === 'object') {
        return new ReferenceBuildCheckpoint(path, parsed as ReferenceBuildCheckpointV1)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const checkpoint = new ReferenceBuildCheckpoint(path, {
      version: 1,
      kind: 'antseed-reference-build-checkpoint',
      compatibilityHash,
      requestsUsed: 0,
      responses: {},
    })
    await checkpoint.save()
    return checkpoint
  }

  get(key: string): string | undefined {
    return this.value.responses[key]
  }

  async reserveRequest(maxRequests: number): Promise<void> {
    let budgetError: Error | null = null
    this.saveChain = this.saveChain.then(async () => {
      if (this.value.requestsUsed >= maxRequests) {
        budgetError = new Error(`reference build request budget exhausted (${maxRequests})`)
        return
      }
      this.value.requestsUsed += 1
      await writeJsonAtomic(this.path, this.value)
    })
    await this.saveChain
    if (budgetError) throw budgetError
  }

  async set(key: string, content: string): Promise<void> {
    this.value.responses[key] = content
    await this.save()
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.value.responses)) return
    delete this.value.responses[key]
    await this.save()
  }

  async remove(): Promise<void> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  private async save(): Promise<void> {
    this.saveChain = this.saveChain.then(() => writeJsonAtomic(this.path, this.value))
    await this.saveChain
  }
}

class AdaptiveRequestLimiter {
  private active = 0
  private limit: number
  private successesSinceThrottle = 0
  private readonly activeByModel = new Map<string, number>()
  private readonly waiters: Array<{ model: string; resolve: () => void }> = []

  constructor(
    private readonly maximum: number,
    private readonly maximumPerModel: number,
  ) {
    assertPositiveInteger(maximum, 'referenceMaxConcurrentRequests')
    assertPositiveInteger(maximumPerModel, 'referenceMaxConcurrentRequestsPerModel')
    this.limit = maximum
  }

  async run<T>(model: string, execute: () => Promise<T>): Promise<T> {
    await this.acquire(model)
    try {
      return await execute()
    } finally {
      this.active -= 1
      this.activeByModel.set(model, (this.activeByModel.get(model) ?? 1) - 1)
      this.drain()
    }
  }

  recordThrottle(error: unknown): void {
    if (!isThrottleError(error)) return
    this.limit = Math.max(1, Math.floor(this.limit / 2))
    this.successesSinceThrottle = 0
  }

  recordSuccess(): void {
    this.successesSinceThrottle += 1
    if (this.limit < this.maximum && this.successesSinceThrottle >= this.limit * 10) {
      this.limit += 1
      this.successesSinceThrottle = 0
      this.drain()
    }
  }

  private async acquire(model: string): Promise<void> {
    if (this.canRun(model)) {
      this.reserve(model)
      return
    }
    await new Promise<void>((resolve) => this.waiters.push({ model, resolve }))
  }

  private drain(): void {
    while (this.active < this.limit) {
      const index = this.waiters.findIndex(({ model }) => this.canRun(model))
      if (index < 0) return
      const waiter = this.waiters.splice(index, 1)[0]!
      this.reserve(waiter.model)
      waiter.resolve()
    }
  }

  private canRun(model: string): boolean {
    return this.active < this.limit && (this.activeByModel.get(model) ?? 0) < this.maximumPerModel
  }

  private reserve(model: string): void {
    this.active += 1
    this.activeByModel.set(model, (this.activeByModel.get(model) ?? 0) + 1)
  }
}

async function queryProbeAnswers(
  model: string,
  probes: readonly KbfProbe[],
  temperature: number,
  cacheDomain: string,
  query: (model: string, body: Record<string, unknown>) => Promise<string>,
  options: { allowIncomplete?: boolean; log?: (message: string) => void } = {},
): Promise<Array<number | null>> {
  const answers: Array<number | null> = []
  for (let offset = 0; offset < probes.length; offset += KBF_PROBES_PER_REQUEST) {
    const batch = probes.slice(offset, offset + KBF_PROBES_PER_REQUEST)
    const body = {
      ...buildKbfChatRequestBody(model, batch, { maxTokens: MAX_TOKENS }),
      temperature,
      top_p: 1,
      __antseedReferenceCacheDomain: cacheDomain,
    }
    try {
      const content = await query(model, body)
      answers.push(...parseKbfAnswers(content, batch.length))
    } catch (error) {
      if (!options.allowIncomplete || !isRecoverableContrastError(error)) throw error
      options.log?.(`contrast batch incomplete for ${model}: ${asError(error).message}`)
      answers.push(...new Array<number | null>(batch.length).fill(null))
    }
  }
  return answers
}

async function postChatCompletion(
  endpoint: VerifierReferenceEndpointConfig,
  apiKey: string | undefined,
  model: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(endpoint.antseedPeerId ? { 'x-antseed-pin-peer': endpoint.antseedPeerId } : {}),
      },
      body: JSON.stringify({ ...body, ...REFERENCE_REQUEST_OVERRIDES, model }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new ReferenceEndpointError(
        response.status,
        parseRetryAfterMs(response.headers.get('retry-after')),
        (await response.text()).slice(0, 200),
      )
    }
    const parsed = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') throw new EmptyReferenceResponseError()
    return content
  } finally {
    clearTimeout(timeout)
  }
}

class ReferenceEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    detail: string,
  ) {
    super(`reference endpoint ${status}: ${detail}`)
  }
}

class EmptyReferenceResponseError extends Error {
  constructor(detail = '') {
    super(`reference endpoint returned no text content${detail ? `: ${detail}` : ''}`)
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function isRetryableReferenceError(error: unknown): boolean {
  if (error instanceof ReferenceEndpointError) return error.status === 429 || error.status >= 500
  if (error instanceof EmptyReferenceResponseError) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
}

function isRecoverableContrastError(error: unknown): boolean {
  return isRetryableReferenceError(error)
}

function isThrottleError(error: unknown): boolean {
  return error instanceof ReferenceEndpointError && error.status === 429
}

function retryDelayMs(error: unknown, baseDelayMs: number, attempt: number): number {
  if (error instanceof ReferenceEndpointError && error.retryAfterMs !== null) return error.retryAfterMs
  return Math.min(30_000, baseDelayMs * 2 ** Math.max(0, attempt - 1))
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function referencePath(referencesDir: string, model: string): string {
  return join(referencesDir, `${safeServiceSlug(model)}.json`)
}

async function writeReference(path: string, reference: KbfReferenceV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(JSON.stringify(reference, null, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

function normalized(value: string): string {
  return value.trim().toLowerCase()
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

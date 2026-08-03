import type { KbfProbe, KbfReferenceV1, ProbeSource, ReferenceQueryProfileV1 } from '@antseed/fingerprints'
import {
  buildKbfChatRequestBody,
  canonicalHash,
  computeBinomialPower,
  computeMatchVector,
  computeReferenceId,
  createReferenceQueryProfile,
  KBF_ENROLLMENT_TEMPERATURES,
  KBF_EXECUTION_TEMPERATURE,
  KBF_PROBES_PER_REQUEST,
  KBF_SUPPORTED_PROBE_COUNTS,
  matchesTolerance,
  parseKbfAnswers,
  validateKbfReferenceV1,
} from '@antseed/fingerprints'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ADAPTIVE_KBF_GENERATOR_NAME,
  ADAPTIVE_KBF_GENERATOR_VERSION,
  generateAdaptiveProbes,
  type AdaptiveGenerationCheckpoint,
  type AdaptiveGenerationStats,
} from './adaptive-probes.js'
import { safeServiceSlug } from './slug.js'

/**
 * Build a certified KBF reference by enrolling a model through a trusted
 * OpenAI-compatible upstream API (the canonical provider, OpenRouter, a local
 * deployment of the open weights, …).
 *
 * Enrollment follows the published KBF protocol (arXiv:2605.29524). The
 * implementation was cross-checked against the upstream scripts at
 * https://github.com/Ooo0ption/KBF/tree/main/scripts, pinned during development
 * to b789b4b7abe119e28ec6260142564b2189ff5449. This implementation note is not
 * persisted in generated reference provenance.
 *
 * 1. Draw candidate probes from the large compositional space.
 * 2. Query the upstream once per temperature in `temperatures`
 *    (reference-consistency filtering): keep only probes the reference model
 *    answers stably — every sample parseable, in-range, and within the
 *    probe's own tolerance of the median. The median becomes the certified
 *    `consensus`.
 * 3. Run one independent hold-out pass and score it against the certified
 *    consensus — that is the reference `selfTest` (hamming/total), which
 *    later bounds the honest mismatch rate p₀ via Clopper–Pearson in
 *    `computeKbfVerdict`.
 *
 * References go stale as backends update (~7–9 weeks per the paper);
 * `createdAt` lets the daemon warn when a reference should be rebuilt.
 */

export interface UpstreamApiConfig {
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string
  apiKey?: string
  /** Optional AntSeed buyer-proxy peer pin. */
  antseedPeerId?: string
  /** Stable endpoint identity recorded in reference provenance. */
  sourceId?: string
  /** Operator trust classification. */
  trust?: 'smoke' | 'trusted'
}

/**
 * Resolve the verifier upstream config into a usable API config, reading the
 * key from `apiKeyEnv` when set. Returns null when no upstream is configured.
 */
export function resolveUpstream(
  upstream: {
    baseUrl: string
    apiKey?: string
    apiKeyEnv?: string
    antseedPeerId?: string
    sourceId?: string
    trust?: 'smoke' | 'trusted'
  } | undefined,
): UpstreamApiConfig | null {
  if (!upstream?.baseUrl) return null
  const apiKey = (upstream.apiKeyEnv ? process.env[upstream.apiKeyEnv] : undefined) ?? upstream.apiKey
  return {
    baseUrl: upstream.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(upstream.antseedPeerId ? { antseedPeerId: upstream.antseedPeerId } : {}),
    ...(upstream.sourceId ? { sourceId: upstream.sourceId } : {}),
    ...(upstream.trust ? { trust: upstream.trust } : {}),
  }
}

export function endpointConfigHash(input: {
  upstream: UpstreamApiConfig
  model: string
  contrastModels: readonly string[]
  queryProfile: ReferenceQueryProfileV1
}): string {
  return canonicalHash({
    baseUrl: normalizeBaseUrl(input.upstream.baseUrl),
    sourceId: input.upstream.sourceId ?? 'legacy-upstream',
    trust: input.upstream.trust ?? 'trusted',
    antseedPeerId: input.upstream.antseedPeerId ?? null,
    model: input.model,
    contrastModels: [...input.contrastModels],
    generator: { name: ADAPTIVE_KBF_GENERATOR_NAME, version: ADAPTIVE_KBF_GENERATOR_VERSION },
    queryProfile: input.queryProfile,
  })
}

/**
 * Resolve the upstream model id to enroll for a discovered service.
 *
 * Upstreams (Together, OpenRouter, …) match model ids CASE-SENSITIVELY, so
 * the fallback is the ADVERTISED spelling — never the normalized (lowercased)
 * grouping key, which would 404 for services like `Qwen/Qwen3-32B`.
 *
 * `modelMap` keys are matched case-insensitively: users naturally copy either
 * the normalized service id or the advertised spelling as the key, and both
 * must work.
 */
export function resolveUpstreamModel(
  modelMap: Record<string, string> | undefined,
  service: string,
  advertised: string,
): string {
  if (modelMap) {
    const direct = modelMap[service] ?? modelMap[advertised]
    if (direct !== undefined) return direct
    for (const [key, value] of Object.entries(modelMap)) {
      if (key.trim().toLowerCase() === service) return value
    }
  }
  return advertised
}

export interface BuildReferenceOptions {
  /** Upstream model id to enroll (what the trusted API calls it). */
  model: string
  /** Network service id this reference certifies. Defaults to `model`. */
  service?: string
  /** Additional service aliases. */
  aliases?: string[]
  /** Candidate probes drawn from the compositional space. Default 500. */
  candidateCount?: number
  /** Probes per upstream request. Must be 10. */
  batchSize?: number
  /** Consistency-filter passes. Must be [0, 0.7, 0.7]. */
  temperatures?: number[]
  /** Hold-out self-test temperature. Must be 0. */
  selfTestTemperature?: number
  /** Contrast models queried at temperature 0. */
  contrastModels?: string[]
  /** Minimum target/reference mismatch delta to detect. Default 0.10. */
  minimumMismatchDelta?: number
  /** Required statistical power. Default 0.90. */
  minimumPower?: number
  /** Smoke-only acceptance power; does not change upstream query inputs. */
  minimumAcceptedPower?: number
  /** Frozen max_tokens request limit. Default 160. */
  maxTokensPerRequest?: number
  /** Frozen upstream request timeout. Default 120000 ms. */
  requestTimeoutMs?: number
  /** Candidate probe origin. Default: the compositional source. */
  probeSource?: ProbeSource
  /** Probe ids that must not be certified again. */
  excludedProbeIds?: readonly string[]
  /** Normalized factual identities that must not be certified again. */
  excludedFactualIdentities?: readonly string[]
  /** Minimum stable probes for a usable reference. Default MIN_REFERENCE_PROBES. */
  minProbes?: number
  /** Smoke-only acceptance count; does not change candidate generation. */
  minimumAcceptedProbes?: number
  /** Minimum hold-out coverage (parsed/total). Default MIN_SELF_TEST_COVERAGE. */
  minSelfTestCoverage?: number
  /** Maximum hold-out error rate (hamming/total). Default MAX_SELF_TEST_ERROR_RATE. */
  maxSelfTestErrorRate?: number
  /** Maximum upstream requests for one build. Default 2000. */
  maxRequestsPerBuild?: number
  /** Retry count after the initial request attempt. Default 3. */
  batchRetryCount?: number
  /** Adaptive generation rounds per domain. Default 6. */
  maxGenerationRounds?: number
  /** Adaptive generation domains processed concurrently. Default 3. */
  generationDomainConcurrency?: number
  /** Maximum concurrent upstream reference requests. Default 4. */
  maxConcurrentReferenceRequests?: number
  /** Maximum concurrent upstream requests for one model. Default 2. */
  maxConcurrentRequestsPerModel?: number
  /** Optional deterministic generation seed recorded for provenance. */
  generationSeed?: string
  /** Durable build checkpoint path. Used by CLI/daemon enrollment. */
  checkpointPath?: string
  /** Completed generation checkpoints from an older compatible workflow. */
  generationCheckpointFallbackPaths?: string[]
  /** Discard an existing checkpoint before starting this build. */
  resetCheckpoint?: boolean
  /** Validate every configured model before expensive generation. Default: adaptive builds only. */
  preflightModels?: boolean
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch
  log?: (message: string) => void
}

const DEFAULT_CANDIDATE_COUNT = 500
export const DEFAULT_KBF_MAX_TOKENS_PER_REQUEST = 1600

/** Minimum stable probes for a usable reference; below this, enrollment fails. */
const MIN_REFERENCE_PROBES = 100

/**
 * Hold-out quality gate. A reference whose independent hold-out pass barely
 * parses (low coverage) or barely matches its own certified consensus (high
 * error rate) would still be persisted and drive verdicts — including
 * single-seller mode, where it is the only ground truth. `computeKbfVerdict`
 * derives the honest-mismatch bound p₀ from the self-test, so a degenerate
 * self-test (coverage 0, error rate 1) makes every verdict vacuous. Reject at
 * enrollment instead.
 */
const MIN_SELF_TEST_COVERAGE = 0.8
const MAX_SELF_TEST_ERROR_RATE = 0.35

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
  error?: { message?: string }
}

export type ReasoningStrategy = 'reasoning-effort-none' | 'disable-thinking' | 'bare'

interface RequestRuntime {
  requestCount: number
  retryCount: number
  failureCount: number
  maxRequests: number
  retries: number
  timeoutMs: number
  strategyByModel: Map<string, ReasoningStrategy>
  rejectedStrategiesByModel: Map<string, Set<ReasoningStrategy>>
  strategyLocksByModel: Map<string, AsyncMutex>
  strategySelectionFailureCounts: Map<string, number>
  strategySelectionErrors: Map<string, Error>
  scheduler: ReferenceRequestScheduler
  maxConcurrentRequestsPerModel: number
  fetchFn: typeof fetch
  sleep: (milliseconds: number) => Promise<void>
  log: (message: string) => void
}

class AsyncSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private limit: number, private readonly maximum = limit) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      return new Promise<() => void>((resolve) => {
        this.waiters.push(() => {
          this.active += 1
          resolve(this.createRelease())
        })
      })
    }
    this.active += 1
    return this.createRelease()
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.drain()
    }
  }

  reduce(): void {
    this.limit = Math.max(1, Math.floor(this.limit / 2))
  }

  increase(): void {
    if (this.limit >= this.maximum) return
    this.limit += 1
    this.drain()
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.active < this.limit) this.waiters.shift()!()
  }
}

class AsyncMutex {
  private readonly semaphore = new AsyncSemaphore(1)

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.semaphore.acquire()
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

class ReferenceRequestScheduler {
  private active = 0
  private currentLimit: number
  private readonly activeByModel = new Map<string, number>()
  private readonly waiters: Array<{ model: string; resolve: (release: () => void) => void }> = []
  private successfulSinceThrottle = 0

  constructor(
    private readonly maxConcurrentRequests: number,
    private readonly maxConcurrentRequestsPerModel: number,
  ) {
    this.currentLimit = maxConcurrentRequests
  }

  async run<T>(model: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(model)
    try {
      const result = await operation()
      this.successfulSinceThrottle += 1
      if (this.successfulSinceThrottle >= 20) {
        this.currentLimit = Math.min(this.maxConcurrentRequests, this.currentLimit + 1)
        this.successfulSinceThrottle = 0
        this.drain()
      }
      return result
    } catch (error) {
      if (isThrottleOrAvailabilityError(error)) {
        this.currentLimit = Math.max(1, Math.floor(this.currentLimit / 2))
        this.successfulSinceThrottle = 0
      }
      throw error
    } finally {
      release()
    }
  }

  private acquire(model: string): Promise<() => void> {
    if (this.canRun(model)) return Promise.resolve(this.activate(model))
    return new Promise((resolve) => this.waiters.push({ model, resolve }))
  }

  private canRun(model: string): boolean {
    return this.active < this.currentLimit
      && (this.activeByModel.get(model) ?? 0) < this.maxConcurrentRequestsPerModel
  }

  private activate(model: string): () => void {
    this.active += 1
    this.activeByModel.set(model, (this.activeByModel.get(model) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      const remaining = (this.activeByModel.get(model) ?? 1) - 1
      if (remaining === 0) this.activeByModel.delete(model)
      else this.activeByModel.set(model, remaining)
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.currentLimit) {
      const index = this.waiters.findIndex(({ model }) => this.canRun(model))
      if (index < 0) return
      const { model, resolve } = this.waiters.splice(index, 1)[0]!
      resolve(this.activate(model))
    }
  }
}

class SerializedCheckpointWriter {
  private dirty = false
  private draining: Promise<void> | null = null

  constructor(private readonly write: () => Promise<void>) {}

  async flush(): Promise<void> {
    this.dirty = true
    this.ensureDrain()
    while (this.draining) {
      await this.draining
    }
  }

  private ensureDrain(): void {
    if (this.draining) return
    this.draining = this.drain().finally(() => {
      this.draining = null
      if (this.dirty) this.ensureDrain()
    })
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false
      await this.write()
    }
  }
}

class UpstreamHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message)
    this.name = 'UpstreamHttpError'
  }
}

async function runConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  let firstError: unknown
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const index = nextIndex
      if (index >= items.length) return
      nextIndex += 1
      try {
        await operation(items[index]!, index)
      } catch (error) {
        firstError = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()))
  if (firstError !== undefined) throw firstError
}

interface ReferenceBuildCheckpointV1 {
  version: 1
  configHash: string
  createdAt: string
  updatedAt: string
  generationSeed: string
  preflightModels: string[]
  candidates: KbfProbe[]
  generationStats?: AdaptiveGenerationStats
  initialAnswers?: Array<number | null>
  contrastAnswers: Record<string, Array<number | null>>
  contrastCompletedBatches?: Record<string, number[]>
  enrollmentPasses: Array<{ probeIds: string[]; answers: Array<number | null> }>
  selfTest?: { probeIds: string[]; answers: Array<number | null> }
  requestCount: number
  retryCount: number
  failureCount: number
  reasoningStrategies: Record<string, ReasoningStrategy>
  rejectedReasoningStrategies: Record<string, ReasoningStrategy[]>
}

class IncompleteAlignedAnswerBatchError extends Error {
  constructor(readonly answers: Array<number | null>) {
    super(`incomplete aligned answer batch (${answers.filter((answer) => answer !== null).length}/${answers.length})`)
  }
}

/**
 * POST a chat-completions request to an OpenAI-compatible upstream and return
 * the first choice's text content. Shared by reference enrollment (queryBatch)
 * and probe authoring (probe-author.ts). `errorContext` prefixes error
 * messages so callers keep their distinct diagnostics.
 */
export async function postChatCompletion(
  upstream: UpstreamApiConfig,
  body: unknown,
  fetchFn: typeof fetch,
  errorContext = 'upstream',
  options: { timeoutMs?: number; antseedPeerId?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const timeoutController = options.signal ? null : new AbortController()
  const timeout = timeoutController && setTimeout(() => timeoutController.abort(), options.timeoutMs ?? 120_000)
  try {
    const response = await fetchFn(`${normalizeBaseUrl(upstream.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
        ...((options.antseedPeerId ?? upstream.antseedPeerId)
          ? { 'x-antseed-pin-peer': options.antseedPeerId ?? upstream.antseedPeerId! }
          : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal ?? timeoutController?.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new UpstreamHttpError(
        `${errorContext} ${response.status}: ${text.slice(0, 200)}`,
        response.status,
        parseRetryAfter(response.headers?.get?.('retry-after') ?? null),
      )
    }
    const parsed = (await response.json()) as ChatCompletionResponse
    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error(
        `${errorContext} returned no text content${parsed.error?.message ? `: ${parsed.error.message}` : ''}`,
      )
    }
    return content
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

function isThrottleOrAvailabilityError(error: unknown): boolean {
  if (error instanceof UpstreamHttpError) return error.status === 429 || error.status === 503
  return error instanceof Error && error.name === 'AbortError'
}

async function queryBatch(
  upstream: UpstreamApiConfig,
  model: string,
  batch: readonly KbfProbe[],
  temperature: number,
  maxTokensPerRequest: number,
  runtime: RequestRuntime,
): Promise<number[]> {
  const baseBody = {
    ...buildKbfChatRequestBody(model, batch, { maxTokens: maxTokensPerRequest }),
    temperature,
    top_p: 1,
  }
  return retryRequest(runtime, async () => {
    const { content, strategy } = await queryText(upstream, model, baseBody, runtime)
    const parsed = parseKbfAnswers(content, batch.length)
    if (parsed.length !== batch.length || parsed.some((answer) => answer === null || !Number.isFinite(answer))) {
      rejectReasoningStrategy(runtime, model, strategy)
      throw new IncompleteAlignedAnswerBatchError(parsed)
    }
    return parsed as number[]
  })
}

interface SamplePassProgress {
  label?: string
  answers?: readonly (number | null)[]
  allowIncomplete?: boolean
  completedBatches?: readonly number[]
  onBatch?: (answers: Array<number | null>, batchIndex: number) => Promise<void>
}

/** One full pass over all candidates at a fixed temperature. */
async function samplePass(
  upstream: UpstreamApiConfig,
  model: string,
  candidates: readonly KbfProbe[],
  temperature: number,
  batchSize: number,
  maxTokensPerRequest: number,
  runtime: RequestRuntime,
  progress: SamplePassProgress & { allowIncomplete: true },
): Promise<Array<number | null>>
async function samplePass(
  upstream: UpstreamApiConfig,
  model: string,
  candidates: readonly KbfProbe[],
  temperature: number,
  batchSize: number,
  maxTokensPerRequest: number,
  runtime: RequestRuntime,
  progress?: SamplePassProgress & { allowIncomplete?: false },
): Promise<number[]>
async function samplePass(
  upstream: UpstreamApiConfig,
  model: string,
  candidates: readonly KbfProbe[],
  temperature: number,
  batchSize: number,
  maxTokensPerRequest: number,
  runtime: RequestRuntime,
  progress: SamplePassProgress = {},
): Promise<Array<number | null>> {
  const answers: Array<number | null> = progress.answers?.length === candidates.length
    ? [...progress.answers]
    : new Array(candidates.length).fill(null)
  const totalBatches = Math.ceil(candidates.length / batchSize)
  const pendingStarts: number[] = []
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize)
    const batchIndex = Math.floor(start / batchSize) + 1
    const saved = answers.slice(start, start + batch.length)
    const completedWithNulls = progress.allowIncomplete && progress.completedBatches?.includes(batchIndex)
    if (completedWithNulls
      || (saved.length === batch.length && saved.every((answer) => answer !== null && Number.isFinite(answer)))) {
      runtime.log(`${progress.label ?? model}: batch ${batchIndex}/${totalBatches} resumed`)
      continue
    }
    pendingStarts.push(start)
  }
  await runConcurrently(pendingStarts, runtime.maxConcurrentRequestsPerModel, async (start) => {
    const batch = candidates.slice(start, start + batchSize)
    const batchIndex = Math.floor(start / batchSize) + 1
    let parsed: Array<number | null>
    try {
      parsed = await queryBatch(upstream, model, batch, temperature, maxTokensPerRequest, runtime)
    } catch (error) {
      if (!progress.allowIncomplete || !(error instanceof IncompleteAlignedAnswerBatchError)) throw error
      parsed = error.answers
      runtime.log(`${progress.label ?? model}: batch ${batchIndex}/${totalBatches} accepted with ${parsed.filter((answer) => answer !== null).length}/${batch.length} parsed contrast answers`)
    }
    for (let i = 0; i < batch.length; i++) answers[start + i] = parsed[i]!
    await progress.onBatch?.([...answers], batchIndex)
    runtime.log(`${progress.label ?? model}: batch ${batchIndex}/${totalBatches} complete`)
  })
  if (!progress.allowIncomplete && answers.some((answer) => answer === null || !Number.isFinite(answer))) {
    throw new Error(`${progress.label ?? model}: checkpoint contains incomplete answers`)
  }
  return answers
}

async function queryText(
  upstream: UpstreamApiConfig,
  model: string,
  baseBody: Record<string, unknown>,
  runtime: RequestRuntime,
): Promise<{ content: string; strategy: ReasoningStrategy }> {
  const cached = runtime.strategyByModel.get(model)
  if (cached) {
    return { content: await requestWithStrategy(upstream, model, baseBody, cached, runtime), strategy: cached }
  }
  const observedFailureCount = runtime.strategySelectionFailureCounts.get(model) ?? 0
  const strategyLock = runtime.strategyLocksByModel.get(model) ?? new AsyncMutex()
  runtime.strategyLocksByModel.set(model, strategyLock)
  return strategyLock.run(async () => {
    const selected = runtime.strategyByModel.get(model)
    if (selected) {
      return { content: await requestWithStrategy(upstream, model, baseBody, selected, runtime), strategy: selected }
    }
    if ((runtime.strategySelectionFailureCounts.get(model) ?? 0) > observedFailureCount) {
      throw runtime.strategySelectionErrors.get(model) ?? new Error(`reasoning strategy selection failed for ${model}`)
    }
    const rejected = runtime.rejectedStrategiesByModel.get(model) ?? new Set<ReasoningStrategy>()
    const allStrategies: ReasoningStrategy[] = ['reasoning-effort-none', 'disable-thinking', 'bare']
    const strategies = allStrategies.filter((strategy) => !rejected.has(strategy))
    if (strategies.length === 0) throw new Error(`no compatible reasoning strategy remains for ${model}`)
    let lastError: Error | null = null
    for (const strategy of strategies) {
      try {
        const content = await requestWithStrategy(upstream, model, baseBody, strategy, runtime)
        runtime.strategyByModel.set(model, strategy)
        return { content, strategy }
      } catch (error) {
        lastError = error as Error
      }
    }
    const failure = lastError ?? new Error(`no request strategy succeeded for ${model}`)
    runtime.strategySelectionFailureCounts.set(model, observedFailureCount + 1)
    runtime.strategySelectionErrors.set(model, failure)
    throw failure
  })
}

function rejectReasoningStrategy(runtime: RequestRuntime, model: string, strategy: ReasoningStrategy): void {
  const rejected = runtime.rejectedStrategiesByModel.get(model) ?? new Set<ReasoningStrategy>()
  rejected.add(strategy)
  runtime.rejectedStrategiesByModel.set(model, rejected)
  if (runtime.strategyByModel.get(model) === strategy) runtime.strategyByModel.delete(model)
}

async function requestWithStrategy(
  upstream: UpstreamApiConfig,
  model: string,
  baseBody: Record<string, unknown>,
  strategy: ReasoningStrategy,
  runtime: RequestRuntime,
): Promise<string> {
  return runtime.scheduler.run(model, async () => {
    if (runtime.requestCount >= runtime.maxRequests) throw new Error(`reference request budget ${runtime.maxRequests} exhausted`)
    runtime.requestCount += 1
    const requestNumber = runtime.requestCount
    const startedAt = Date.now()
    runtime.log(`request ${requestNumber}/${runtime.maxRequests} start model=${model} strategy=${strategy}`)
    try {
      const content = await postChatCompletion(
        upstream,
        applyReasoningStrategy(baseBody, strategy),
        runtime.fetchFn,
        `upstream ${model}`,
        { timeoutMs: runtime.timeoutMs },
      )
      runtime.log(`request ${requestNumber}/${runtime.maxRequests} complete model=${model} in ${Date.now() - startedAt}ms`)
      return content
    } catch (error) {
      runtime.failureCount += 1
      const failure = error as Error
      runtime.log(`request ${requestNumber}/${runtime.maxRequests} failed model=${model} after ${Date.now() - startedAt}ms: ${failure.message}`)
      throw failure
    }
  })
}

async function retryRequest<T>(runtime: RequestRuntime, operation: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= runtime.retries; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error as Error
      if (attempt >= runtime.retries) break
      runtime.retryCount += 1
      const retryAfterMs = lastError instanceof UpstreamHttpError ? lastError.retryAfterMs : null
      const delay = Math.max(
        retryAfterMs ?? 0,
        Math.min(5000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 100),
      )
      runtime.log(`retry ${attempt + 1}/${runtime.retries} in ${delay}ms: ${lastError.message}`)
      await runtime.sleep(delay)
    }
  }
  throw lastError ?? new Error('request failed')
}

function applyReasoningStrategy(body: Record<string, unknown>, strategy: ReasoningStrategy): Record<string, unknown> {
  if (strategy === 'reasoning-effort-none') return { ...body, reasoning_effort: 'none' }
  if (strategy === 'disable-thinking') return { ...body, enable_thinking: false }
  return { ...body }
}

function reasoningOverrides(strategy: ReasoningStrategy): Record<string, unknown> {
  if (strategy === 'reasoning-effort-none') return { reasoning_effort: 'none' }
  if (strategy === 'disable-thinking') return { enable_thinking: false }
  return {}
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function referenceCheckpointConfigHash(input: {
  upstream: UpstreamApiConfig
  model: string
  service: string
  aliases: readonly string[]
  contrastModels: readonly string[]
  candidateCount: number
  minProbes: number
  batchSize: number
  temperatures: readonly number[]
  selfTestTemperature: number
  minimumMismatchDelta: number
  minimumPower: number
  maxTokensPerRequest: number
  requestTimeoutMs: number
  maxGenerationRounds: number
  generationSeed?: string
  excludedProbeIds?: readonly string[]
  excludedFactualIdentities?: readonly string[]
}): string {
  return canonicalHash({
    version: 1,
    generator: { name: ADAPTIVE_KBF_GENERATOR_NAME, version: ADAPTIVE_KBF_GENERATOR_VERSION },
    endpoint: {
      baseUrl: normalizeBaseUrl(input.upstream.baseUrl),
      sourceId: input.upstream.sourceId ?? 'legacy-upstream',
      trust: input.upstream.trust ?? 'trusted',
      antseedPeerId: input.upstream.antseedPeerId ?? null,
    },
    model: input.model,
    service: input.service,
    aliases: [...input.aliases],
    contrastModels: [...input.contrastModels],
    candidateCount: input.candidateCount,
    minProbes: input.minProbes,
    batchSize: input.batchSize,
    temperatures: [...input.temperatures],
    selfTestTemperature: input.selfTestTemperature,
    minimumMismatchDelta: input.minimumMismatchDelta,
    minimumPower: input.minimumPower,
    maxTokensPerRequest: input.maxTokensPerRequest,
    requestTimeoutMs: input.requestTimeoutMs,
    maxGenerationRounds: input.maxGenerationRounds,
    generationSeed: input.generationSeed ?? null,
    excludedProbeIdsHash: canonicalHash([...(input.excludedProbeIds ?? [])].sort()),
    excludedFactualIdentitiesHash: canonicalHash([...(input.excludedFactualIdentities ?? [])].sort()),
  })
}

async function loadReferenceCheckpoint(
  path: string | undefined,
  configHash: string,
  reset: boolean,
  log: (message: string) => void,
): Promise<ReferenceBuildCheckpointV1 | null> {
  if (!path) return null
  if (reset) {
    await rm(path, { force: true })
    log(`checkpoint reset: ${path}`)
    return null
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ReferenceBuildCheckpointV1
    if (parsed.version !== 1 || parsed.configHash !== configHash || !Array.isArray(parsed.candidates)) {
      log(`checkpoint ignored because its build configuration does not match: ${path}`)
      return null
    }
    log(`checkpoint resumed: ${parsed.candidates.length} candidates, ${parsed.requestCount} requests already completed`)
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    const corruptPath = `${path}.corrupt-${Date.now()}`
    await rename(path, corruptPath).catch(() => undefined)
    log(`checkpoint was unreadable and moved to ${corruptPath}`)
    return null
  }
}

function hasEnrollmentProgress(checkpoint: ReferenceBuildCheckpointV1): boolean {
  return (checkpoint.initialAnswers?.some((answer) => answer !== null) ?? false)
    || Object.values(checkpoint.contrastAnswers).some((answers) => answers.some((answer) => answer !== null))
    || checkpoint.enrollmentPasses.some((pass) => pass.answers.some((answer) => answer !== null))
    || (checkpoint.selfTest?.answers.some((answer) => answer !== null) ?? false)
}

async function migrateGenerationCheckpoint(
  paths: readonly string[],
  current: ReferenceBuildCheckpointV1 | null,
  configHash: string,
  expectedCandidateCount: number,
  log: (message: string) => void,
): Promise<ReferenceBuildCheckpointV1 | null> {
  if (current && hasEnrollmentProgress(current)) return current
  let best = current
  let bestPath: string | null = null
  for (const path of paths) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as ReferenceBuildCheckpointV1
      if (parsed.version !== 1
        || !Array.isArray(parsed.candidates)
        || parsed.candidates.length > expectedCandidateCount
        || parsed.generationStats?.generatedCandidates !== parsed.candidates.length
        || typeof parsed.generationSeed !== 'string') continue
      if ((best?.candidates.length ?? 0) >= parsed.candidates.length) continue
      best = {
        version: 1,
        configHash,
        createdAt: parsed.createdAt,
        updatedAt: new Date().toISOString(),
        generationSeed: parsed.generationSeed,
        preflightModels: [...new Set(parsed.preflightModels)],
        candidates: parsed.candidates,
        generationStats: {
          ...parsed.generationStats,
          requestedCandidates: expectedCandidateCount,
          generatedCandidates: parsed.candidates.length,
        },
        contrastAnswers: {},
        contrastCompletedBatches: {},
        enrollmentPasses: [],
        requestCount: parsed.requestCount,
        retryCount: parsed.retryCount,
        failureCount: parsed.failureCount,
        reasoningStrategies: {},
        rejectedReasoningStrategies: {},
      }
      bestPath = path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`generation checkpoint fallback ignored because it is unreadable: ${path}`)
      }
    }
  }
  if (bestPath) {
    log(`generation checkpoint migrated: ${expectedCandidateCount} candidates from ${bestPath}`)
  }
  return best
}

async function persistReferenceCheckpoint(path: string | undefined, checkpoint: ReferenceBuildCheckpointV1): Promise<void> {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tempPath, 'wx')
  try {
    await handle.writeFile(JSON.stringify(checkpoint, null, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tempPath, path)
}

function checkpointStrategies(runtime: RequestRuntime): Pick<
  ReferenceBuildCheckpointV1,
  'requestCount' | 'retryCount' | 'failureCount' | 'reasoningStrategies' | 'rejectedReasoningStrategies'
> {
  return {
    requestCount: runtime.requestCount,
    retryCount: runtime.retryCount,
    failureCount: runtime.failureCount,
    reasoningStrategies: Object.fromEntries(runtime.strategyByModel),
    rejectedReasoningStrategies: Object.fromEntries(
      [...runtime.rejectedStrategiesByModel].map(([model, strategies]) => [model, [...strategies]]),
    ),
  }
}

function preflightProbes(): KbfProbe[] {
  return Array.from({ length: KBF_PROBES_PER_REQUEST }, (_unused, index) => ({
    id: `preflight-${index}`,
    name: `integer immediately after ${index}`,
    domain: 'preflight',
    template: `The integer immediately after ${index} is ___.`,
    consensus: index + 1,
    range: [0, 100],
    tolerance: { mode: 'absolute', value: 0 },
  }))
}

async function preflightReferenceModel(
  upstream: UpstreamApiConfig,
  model: string,
  maxTokensPerRequest: number,
  runtime: RequestRuntime,
): Promise<void> {
  runtime.log(`preflight start model=${model}`)
  await queryBatch(
    upstream,
    model,
    preflightProbes(),
    KBF_EXECUTION_TEMPERATURE,
    maxTokensPerRequest,
    runtime,
  )
  runtime.log(`preflight complete model=${model}`)
}

export async function buildKbfReference(
  upstream: UpstreamApiConfig,
  options: BuildReferenceOptions,
): Promise<KbfReferenceV1> {
  const {
    model,
    service = options.model,
    aliases = [],
    candidateCount = DEFAULT_CANDIDATE_COUNT,
    batchSize = KBF_PROBES_PER_REQUEST,
    temperatures = [...KBF_ENROLLMENT_TEMPERATURES],
    selfTestTemperature = KBF_EXECUTION_TEMPERATURE,
    contrastModels = [],
    minimumMismatchDelta = 0.1,
    minimumPower = 0.9,
    minimumAcceptedPower = minimumPower,
    maxTokensPerRequest = DEFAULT_KBF_MAX_TOKENS_PER_REQUEST,
    requestTimeoutMs = 120_000,
    probeSource,
    excludedProbeIds = [],
    excludedFactualIdentities = [],
    minProbes = MIN_REFERENCE_PROBES,
    minimumAcceptedProbes = minProbes,
    minSelfTestCoverage = MIN_SELF_TEST_COVERAGE,
    maxSelfTestErrorRate = MAX_SELF_TEST_ERROR_RATE,
    maxRequestsPerBuild = 2000,
    batchRetryCount = 3,
    maxGenerationRounds = 6,
    generationDomainConcurrency = 3,
    maxConcurrentReferenceRequests = 4,
    maxConcurrentRequestsPerModel = 2,
    generationSeed: requestedGenerationSeed,
    checkpointPath,
    generationCheckpointFallbackPaths = [],
    resetCheckpoint = false,
    preflightModels = probeSource === undefined,
    fetchFn = fetch,
    log = () => {},
  } = options
  if (batchSize !== KBF_PROBES_PER_REQUEST) {
    throw new Error(`buildKbfReference: batchSize must be ${KBF_PROBES_PER_REQUEST}`)
  }
  if (JSON.stringify(temperatures) !== JSON.stringify(KBF_ENROLLMENT_TEMPERATURES)) {
    throw new Error('buildKbfReference: temperatures must be [0, 0.7, 0.7]')
  }
  if (selfTestTemperature !== KBF_EXECUTION_TEMPERATURE) {
    throw new Error('buildKbfReference: self-test temperature must be 0')
  }
  if (!(minimumPower >= 0.9 && minimumPower <= 1)) {
    throw new Error('buildKbfReference: minimumPower must be in [0.9, 1]')
  }
  if (!(minimumAcceptedPower > 0 && minimumAcceptedPower <= minimumPower)) {
    throw new Error('buildKbfReference: minimumAcceptedPower must be in (0, minimumPower]')
  }
  if (!Number.isInteger(minimumAcceptedProbes)
    || minimumAcceptedProbes < KBF_PROBES_PER_REQUEST
    || minimumAcceptedProbes > minProbes
    || minimumAcceptedProbes % KBF_PROBES_PER_REQUEST !== 0) {
    throw new Error(`buildKbfReference: minimumAcceptedProbes must be a multiple of ${KBF_PROBES_PER_REQUEST} from ${KBF_PROBES_PER_REQUEST} through minProbes`)
  }
  for (const [name, value] of [
    ['generationDomainConcurrency', generationDomainConcurrency],
    ['maxConcurrentReferenceRequests', maxConcurrentReferenceRequests],
    ['maxConcurrentRequestsPerModel', maxConcurrentRequestsPerModel],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`buildKbfReference: ${name} must be an integer >= 1`)
  }
  if (maxConcurrentRequestsPerModel > maxConcurrentReferenceRequests) {
    throw new Error('buildKbfReference: maxConcurrentRequestsPerModel must not exceed maxConcurrentReferenceRequests')
  }

  const normalizedContrasts = [...new Set(contrastModels.map((value) => value.trim()).filter(Boolean))]
  const adaptiveCandidateCount = Math.max(candidateCount, Math.min(1500, minProbes * 6))
  const effectiveCheckpointPath = checkpointPath
  const checkpointConfigHash = referenceCheckpointConfigHash({
    upstream,
    model,
    service,
    aliases,
    contrastModels: normalizedContrasts,
    candidateCount: probeSource ? candidateCount : adaptiveCandidateCount,
    minProbes,
    batchSize,
    temperatures,
    selfTestTemperature,
    minimumMismatchDelta,
    minimumPower,
    maxTokensPerRequest,
    requestTimeoutMs,
    maxGenerationRounds,
    generationSeed: requestedGenerationSeed,
    excludedProbeIds,
    excludedFactualIdentities,
  })
  const exactCheckpoint = await loadReferenceCheckpoint(
    effectiveCheckpointPath,
    checkpointConfigHash,
    resetCheckpoint,
    log,
  )
  const resumedCheckpoint = resetCheckpoint
    ? exactCheckpoint
    : await migrateGenerationCheckpoint(
        generationCheckpointFallbackPaths,
        exactCheckpoint,
        checkpointConfigHash,
        adaptiveCandidateCount,
        log,
      )
  const generationSeed = resumedCheckpoint?.generationSeed
    ?? requestedGenerationSeed
    ?? randomBytes(32).toString('hex')
  const runtime: RequestRuntime = {
    requestCount: resumedCheckpoint?.requestCount ?? 0,
    retryCount: resumedCheckpoint?.retryCount ?? 0,
    failureCount: resumedCheckpoint?.failureCount ?? 0,
    maxRequests: maxRequestsPerBuild,
    retries: batchRetryCount,
    timeoutMs: requestTimeoutMs,
    strategyByModel: new Map(Object.entries(resumedCheckpoint?.reasoningStrategies ?? {}) as Array<[string, ReasoningStrategy]>),
    rejectedStrategiesByModel: new Map(
      Object.entries(resumedCheckpoint?.rejectedReasoningStrategies ?? {})
        .map(([entryModel, strategies]) => [entryModel, new Set(strategies)]),
    ),
    strategyLocksByModel: new Map(),
    strategySelectionFailureCounts: new Map(),
    strategySelectionErrors: new Map(),
    scheduler: new ReferenceRequestScheduler(maxConcurrentReferenceRequests, maxConcurrentRequestsPerModel),
    maxConcurrentRequestsPerModel,
    fetchFn,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log,
  }
  const checkpoint: ReferenceBuildCheckpointV1 = resumedCheckpoint ?? {
    version: 1,
    configHash: checkpointConfigHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    generationSeed,
    preflightModels: [],
    candidates: [],
    contrastAnswers: {},
    contrastCompletedBatches: {},
    enrollmentPasses: [],
    requestCount: 0,
    retryCount: 0,
    failureCount: 0,
    reasoningStrategies: {},
    rejectedReasoningStrategies: {},
  }
  const checkpointWriter = new SerializedCheckpointWriter(async () => {
    checkpoint.updatedAt = new Date().toISOString()
    Object.assign(checkpoint, checkpointStrategies(runtime))
    await persistReferenceCheckpoint(effectiveCheckpointPath, checkpoint)
  })
  const saveCheckpoint = (): Promise<void> => checkpointWriter.flush()
  try {
    if (preflightModels) {
      const pendingPreflights = [...new Set([model, ...normalizedContrasts])].filter((preflightModel) => {
        if (checkpoint.preflightModels.includes(preflightModel)) {
          log(`preflight resumed model=${preflightModel}`)
          return false
        }
        return true
      })
      await runConcurrently(pendingPreflights, maxConcurrentReferenceRequests, async (preflightModel) => {
        await preflightReferenceModel(upstream, preflightModel, maxTokensPerRequest, runtime)
        checkpoint.preflightModels = [...new Set([...checkpoint.preflightModels, preflightModel])].sort()
        await saveCheckpoint()
      })
    }

    let generationStats: AdaptiveGenerationStats | undefined
    let candidates: KbfProbe[]
    let sourceId: string
    if (probeSource) {
      candidates = probeSource.generate({
        count: Math.min(candidateCount, probeSource.size),
        seed: generationSeed,
      })
      sourceId = probeSource.id
    } else {
      const resume: AdaptiveGenerationCheckpoint | undefined = checkpoint.generationStats
        ? { probes: checkpoint.candidates, stats: checkpoint.generationStats }
        : undefined
      const generated = await generateAdaptiveProbes({
        model,
        count: adaptiveCandidateCount,
        maxRounds: maxGenerationRounds,
        domainConcurrency: generationDomainConcurrency,
        resume,
        query: (prompt, maxTokens) => retryRequest(runtime, async () => {
          const result = await queryText(upstream, model, {
            model,
            temperature: 0,
            top_p: 1,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: 'You generate precise factual data for a private model fingerprint. Follow the requested line format exactly.' },
              { role: 'user', content: prompt },
            ],
          }, runtime)
          return result.content
        }),
        log,
        onProgress: async (progress) => {
          checkpoint.candidates = progress.probes
          checkpoint.generationStats = progress.stats
          await saveCheckpoint()
        },
      })
      candidates = generated.probes
      generationStats = generated.stats
      checkpoint.candidates = candidates
      checkpoint.generationStats = generationStats
      await saveCheckpoint()
      sourceId = `${ADAPTIVE_KBF_GENERATOR_NAME}/${ADAPTIVE_KBF_GENERATOR_VERSION}`
    }
    const excludedIds = new Set(excludedProbeIds)
    const excludedFacts = new Set(excludedFactualIdentities)
    candidates = candidates.filter((probe) => !excludedIds.has(probe.id) && !excludedFacts.has(kbfFactualIdentity(probe)))
    checkpoint.candidates = candidates
    if (candidates.length < minProbes) {
      throw new Error(`buildKbfReference: generated only ${candidates.length} candidates (< ${minProbes})`)
    }
    log(`Enrolling ${model}: ${candidates.length} candidate probes`)

    let initialAnswers: number[] = []
    const contrastAnswers = new Map<string, Array<number | null>>()
    const enrollmentModels = [model, ...normalizedContrasts]
    await runConcurrently(enrollmentModels, maxConcurrentReferenceRequests, async (enrollmentModel, index) => {
      const isReference = index === 0
      if (isReference) {
        initialAnswers = await samplePass(
          upstream,
          enrollmentModel,
          candidates,
          temperatures[0]!,
          batchSize,
          maxTokensPerRequest,
          runtime,
          {
            label: `initial ${model}`,
            answers: checkpoint.initialAnswers,
            onBatch: async (batchAnswers) => {
              checkpoint.initialAnswers = batchAnswers
              await saveCheckpoint()
            },
          },
        )
        return
      }
      checkpoint.contrastCompletedBatches ??= {}
      const completedBatches = checkpoint.contrastCompletedBatches[enrollmentModel] ?? []
      contrastAnswers.set(enrollmentModel, await samplePass(
        upstream,
        enrollmentModel,
        candidates,
        KBF_EXECUTION_TEMPERATURE,
        batchSize,
        maxTokensPerRequest,
        runtime,
        {
          label: isReference ? `initial ${model}` : `contrast ${enrollmentModel}`,
          answers: checkpoint.contrastAnswers[enrollmentModel],
          allowIncomplete: true,
          completedBatches,
          onBatch: async (batchAnswers, batchIndex) => {
            checkpoint.contrastAnswers[enrollmentModel] = batchAnswers
            const completed = new Set(checkpoint.contrastCompletedBatches![enrollmentModel] ?? [])
            completed.add(batchIndex)
            checkpoint.contrastCompletedBatches![enrollmentModel] = [...completed].sort((left, right) => left - right)
            await saveCheckpoint()
          },
        },
      ))
    })

    const screened: KbfProbe[] = []
    const screenedInitialAnswers: number[] = []
    for (let index = 0; index < candidates.length; index += 1) {
      const probe = candidates[index]!
      const referenceAnswer = initialAnswers[index]!
      if (referenceAnswer < probe.range[0] || referenceAnswer > probe.range[1]) continue
      const referenceProbe = { ...probe, consensus: referenceAnswer }
      const outcomes = normalizedContrasts.map((contrastModel) => {
        const answer = contrastAnswers.get(contrastModel)![index] ?? null
        const match = answer === null || !Number.isFinite(answer)
          ? null
          : matchesTolerance(answer, referenceProbe) ? 1 : 0
        return { model: contrastModel, answer, match }
      })
      if (normalizedContrasts.length > 0 && !outcomes.some((outcome) => outcome.match === 0)) continue
      screened.push({
        ...probe,
        contrast: {
          referenceAnswer,
          outcomes,
          distinguishingModels: outcomes.filter((outcome) => outcome.match === 0).map((outcome) => outcome.model),
        },
      })
      screenedInitialAnswers.push(referenceAnswer)
    }
    log(`${screened.length}/${candidates.length} probes passed contrast screening`)
    if (screened.length < minimumAcceptedProbes) {
      throw new Error(`buildKbfReference: only ${screened.length} contrast-distinguishing probes (< ${minimumAcceptedProbes})`)
    }

    const screenedProbeIds = screened.map((probe) => probe.id)
    const remainingPasses: number[][] = new Array(temperatures.length - 1)
    await runConcurrently(temperatures.slice(1), temperatures.length - 1, async (temperature, passOffset) => {
      const savedPass = checkpoint.enrollmentPasses[passOffset]
      const savedAnswers = savedPass && JSON.stringify(savedPass.probeIds) === JSON.stringify(screenedProbeIds)
        ? savedPass.answers
        : undefined
      remainingPasses[passOffset] = await samplePass(
        upstream,
        model,
        screened,
        temperature,
        batchSize,
        maxTokensPerRequest,
        runtime,
        {
          label: `enrollment ${passOffset + 2}/${temperatures.length} ${model}`,
          answers: savedAnswers,
          onBatch: async (answers) => {
            checkpoint.enrollmentPasses[passOffset] = { probeIds: screenedProbeIds, answers }
            await saveCheckpoint()
          },
        },
      )
    })

    const stable: KbfProbe[] = []
    for (let index = 0; index < screened.length; index += 1) {
      const probe = screened[index]!
      const values = [screenedInitialAnswers[index]!, ...remainingPasses.map((pass) => pass[index]!)]
      if (values.some((value) => value < probe.range[0] || value > probe.range[1])) continue
      const consensus = median(values)
      const certified: KbfProbe = { ...probe, consensus, advisoryConsensus: false, enrollmentAnswers: values }
      if (!values.every((value) => matchesTolerance(value, certified))) continue
      stable.push(certified)
    }
    log(`${stable.length}/${screened.length} probes stable across temperatures`)
    if (stable.length < minimumAcceptedProbes) {
      throw new Error(
        `buildKbfReference: only ${stable.length} stable probes (< ${minimumAcceptedProbes}); ` +
          'the upstream endpoint may be unreliable for this model',
      )
    }

    // Independent hold-out pass scored against the certified consensus: the
    // reference's own honest error rate (selfTest) that p₀ is derived from.
    const stableProbeIds = stable.map((probe) => probe.id)
    const savedSelfAnswers = checkpoint.selfTest
      && JSON.stringify(checkpoint.selfTest.probeIds) === JSON.stringify(stableProbeIds)
      ? checkpoint.selfTest.answers
      : undefined
    const selfAnswers = await samplePass(
      upstream,
      model,
      stable,
      selfTestTemperature,
      batchSize,
      maxTokensPerRequest,
      runtime,
      {
        label: `self-test ${model}`,
        answers: savedSelfAnswers,
        onBatch: async (answers) => {
          checkpoint.selfTest = { probeIds: stableProbeIds, answers }
          await saveCheckpoint()
        },
      },
    )
    const selfMatches = computeMatchVector(selfAnswers, stable)

  let selectedCount: number | null = null
  let selectedPowerResult: ReturnType<typeof computeBinomialPower> | null = null
  for (const probeCount of [...KBF_SUPPORTED_PROBE_COUNTS].reverse()) {
    if (stable.length < probeCount) continue
    if (probeCount > candidateCount) continue
    if (probeCount < minimumAcceptedProbes) continue
    const subsetMatches = selfMatches.slice(0, probeCount)
    const selfHamming = subsetMatches.filter((entry) => entry !== 1).length
    const powerResult = computeBinomialPower({
      selfHamming,
      selfTotal: probeCount,
      minimumMismatchDelta,
    })
    if (powerResult.power >= minimumAcceptedPower) {
      selectedCount = probeCount
      selectedPowerResult = powerResult
      break
    }
  }
  if (selectedCount === null) {
    throw new Error(
      `buildKbfReference: reference remains underpowered (below accepted power ${minimumAcceptedPower}) ` +
        `at ${stable.length} stable probes`,
    )
  }

  const selectedProbes = stable.slice(0, selectedCount)
  const selectedAnswers = selfAnswers.slice(0, selectedCount)
  const selectedMatches = selfMatches.slice(0, selectedCount)
  const total = selectedCount
  const matched = selectedMatches.filter((entry) => entry === 1).length
  const parsed = selectedMatches.filter((entry) => entry !== null).length
  const hamming = total - matched
  const selfTest = {
    hamming,
    total,
    coverage: parsed / total,
    errorRate: hamming / total,
    outcomes: selectedProbes.map((probe, index) => ({
      probeId: probe.id,
      answer: selectedAnswers[index] ?? null,
      match: selectedMatches[index] ?? null,
    })),
  }
  log(`Self-test: ${hamming}/${total} mismatches (coverage ${(selfTest.coverage * 100).toFixed(1)}%)`)
  // Quality gate: a reference that cannot reproduce itself must never be
  // persisted — it would certify verdicts its own hold-out pass disowns.
  if (selfTest.coverage < minSelfTestCoverage) {
    throw new Error(
      `buildKbfReference: hold-out coverage ${(selfTest.coverage * 100).toFixed(1)}% ` +
        `< required ${(minSelfTestCoverage * 100).toFixed(1)}%; ` +
        'the upstream endpoint may be unreliable for this model',
    )
  }
  if (selfTest.errorRate > maxSelfTestErrorRate) {
    throw new Error(
      `buildKbfReference: hold-out error rate ${(selfTest.errorRate * 100).toFixed(1)}% ` +
        `> allowed ${(maxSelfTestErrorRate * 100).toFixed(1)}%; ` +
        'the upstream endpoint may be unreliable for this model',
    )
  }

  const serviceAliases = [...new Set([service, model, ...aliases].map((s) => s.trim().toLowerCase()))]
  const queryProfile = createReferenceQueryProfile({
    upstreamModel: model,
    maxTokensPerRequest,
    requestTimeoutMs,
  })
  const referenceStrategy = runtime.strategyByModel.get(model) ?? 'bare'
  queryProfile.reasoningStrategy = referenceStrategy
  queryProfile.requestOverrides = reasoningOverrides(referenceStrategy)
  const configHash = endpointConfigHash({ upstream, model, contrastModels: normalizedContrasts, queryProfile })
  const generatorName = probeSource ? 'antseed-kbf-static-fixture' : ADAPTIVE_KBF_GENERATOR_NAME
  const generatorVersion = probeSource ? sourceId : ADAPTIVE_KBF_GENERATOR_VERSION
  const reference: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: service,
    serviceAliases,
    createdAt: new Date().toISOString(),
    source: 'generated',
    generator: {
      name: generatorName,
      version: generatorVersion,
      verifierKind: 'kbf',
      params: {
        sourceId: upstream.sourceId ?? 'legacy-upstream',
        trust: upstream.trust ?? 'trusted',
        endpointConfigHash: configHash,
        antseedPeerId: upstream.antseedPeerId ?? null,
        upstreamModel: model,
        candidateCount: candidates.length,
        generationSeed,
        generationStats: generationStats ?? null,
        temperatures,
        selfTestTemperature,
        queryProfile,
        contrastModels: normalizedContrasts,
        minimumAcceptedProbes,
        minimumAcceptedPower,
        requestCount: runtime.requestCount,
        retryCount: runtime.retryCount,
        failureCount: runtime.failureCount,
        maxRequestsPerBuild,
        batchRetryCount,
        reasoningStrategies: Object.fromEntries(runtime.strategyByModel),
      },
    },
    provenance: {
      sourceId: upstream.sourceId ?? 'legacy-upstream',
      trust: upstream.trust ?? 'trusted',
      endpointConfigHash: configHash,
      referenceProvider: upstream.antseedPeerId ? `antseed-peer:${upstream.antseedPeerId}` : 'direct-api',
    },
    queryProfile,
    selfTest,
    probes: selectedProbes,
    selectedProbeCount: selectedCount,
    minimumMismatchDelta,
    statisticalPower: selectedPowerResult!.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      p0UpperBound: selectedPowerResult!.p0,
      alternativeMismatchRate: selectedPowerResult!.p1,
      criticalMismatchCount: selectedPowerResult!.criticalMismatchCount,
      power: selectedPowerResult!.power,
    },
    contrasts: normalizedContrasts.map((contrastModel) => ({
      model: contrastModel,
      distinguishingProbeIds: selectedProbes
        .filter((probe) => ((probe.contrast as { distinguishingModels?: unknown } | undefined)?.distinguishingModels as string[] | undefined)?.includes(contrastModel))
        .map((probe) => probe.id),
    })),
  }
  reference.referenceId = computeReferenceId(reference)
  return validateKbfReferenceV1(reference)
  } catch (error) {
    await saveCheckpoint().catch((checkpointError) => {
      log(`checkpoint save failed while handling build error: ${(checkpointError as Error).message}`)
    })
    if (error instanceof Error) {
      Object.assign(error, {
        requestCount: runtime.requestCount,
        retryCount: runtime.retryCount,
        failureCount: runtime.failureCount,
      })
    }
    throw error
  }
}

export interface KbfSelfTestExecution {
  answers: number[]
  matches: Array<0 | 1 | null>
  requestCount: number
  retryCount: number
  failureCount: number
  reasoningStrategy: ReasoningStrategy
}

export async function executeKbfSelfTest(
  upstream: UpstreamApiConfig,
  model: string,
  probes: readonly KbfProbe[],
  options: {
    queryProfile: ReferenceQueryProfileV1
    maxRequests: number
    batchRetryCount: number
    maxConcurrentReferenceRequests?: number
    maxConcurrentRequestsPerModel?: number
    fetchFn?: typeof fetch
    log?: (message: string) => void
  },
): Promise<KbfSelfTestExecution> {
  if (probes.length % KBF_PROBES_PER_REQUEST !== 0) {
    throw new Error(`KBF self-test requires complete batches of ${KBF_PROBES_PER_REQUEST}`)
  }
  const preferred = options.queryProfile.reasoningStrategy ?? 'bare'
  const maxConcurrentReferenceRequests = options.maxConcurrentReferenceRequests ?? 4
  const maxConcurrentRequestsPerModel = options.maxConcurrentRequestsPerModel ?? 2
  if (maxConcurrentRequestsPerModel > maxConcurrentReferenceRequests) {
    throw new Error('KBF self-test maxConcurrentRequestsPerModel must not exceed maxConcurrentReferenceRequests')
  }
  const runtime: RequestRuntime = {
    requestCount: 0,
    retryCount: 0,
    failureCount: 0,
    maxRequests: options.maxRequests,
    retries: options.batchRetryCount,
    timeoutMs: options.queryProfile.requestTimeoutMs,
    strategyByModel: new Map([[model, preferred]]),
    rejectedStrategiesByModel: new Map(),
    strategyLocksByModel: new Map(),
    strategySelectionFailureCounts: new Map(),
    strategySelectionErrors: new Map(),
    scheduler: new ReferenceRequestScheduler(maxConcurrentReferenceRequests, maxConcurrentRequestsPerModel),
    maxConcurrentRequestsPerModel,
    fetchFn: options.fetchFn ?? fetch,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log: options.log ?? (() => {}),
  }
  const answers = await samplePass(
    upstream,
    model,
    probes,
    KBF_EXECUTION_TEMPERATURE,
    KBF_PROBES_PER_REQUEST,
    options.queryProfile.maxTokensPerRequest,
    runtime,
    { label: `fresh self-test ${model}` },
  )
  return {
    answers,
    matches: computeMatchVector(answers, probes),
    requestCount: runtime.requestCount,
    retryCount: runtime.retryCount,
    failureCount: runtime.failureCount,
    reasoningStrategy: runtime.strategyByModel.get(model) ?? preferred,
  }
}

export function kbfFactualIdentity(probe: KbfProbe): string {
  return canonicalHash({
    domain: probe.domain.trim().toLowerCase(),
    name: probe.name.trim().toLowerCase().replace(/\s+/g, ' '),
    template: probe.template.trim().toLowerCase().replace(/\s+/g, ' '),
  })
}

/**
 * Enroll a reference via the upstream and persist it to
 * `<outDir>/<slug(certified service)>.json` — the layout `loadReferences`
 * scans. Shared by `antseed verifier reference build` and the daemon's
 * automatic enrollment so the two write identical files.
 */
export async function enrollAndPersistReference(
  upstream: UpstreamApiConfig,
  options: BuildReferenceOptions,
  outDir: string,
): Promise<{ reference: KbfReferenceV1; outPath: string }> {
  const checkpointIdentity = canonicalHash({
    baseUrl: normalizeBaseUrl(upstream.baseUrl),
    sourceId: upstream.sourceId ?? 'legacy-upstream',
    trust: upstream.trust ?? 'trusted',
    antseedPeerId: upstream.antseedPeerId ?? null,
    model: options.model,
    service: options.service ?? options.model,
    contrastModels: options.contrastModels ?? [],
    candidateCount: options.candidateCount ?? DEFAULT_CANDIDATE_COUNT,
    minProbes: options.minProbes ?? MIN_REFERENCE_PROBES,
    generator: { name: ADAPTIVE_KBF_GENERATOR_NAME, version: ADAPTIVE_KBF_GENERATOR_VERSION },
    excludedProbeIdsHash: canonicalHash([...(options.excludedProbeIds ?? [])].sort()),
    excludedFactualIdentitiesHash: canonicalHash([...(options.excludedFactualIdentities ?? [])].sort()),
  }).replace(/^sha256:/, '').slice(0, 20)
  const checkpointPath = options.checkpointPath ?? join(
    outDir,
    '.checkpoints',
    `${safeServiceSlug(options.service ?? options.model)}-${checkpointIdentity}.json`,
  )
  const reference = await buildKbfReference(upstream, { ...options, checkpointPath })
  await mkdir(outDir, { recursive: true })
  const outPath = join(
    outDir,
    `${safeServiceSlug(reference.referenceModel || options.model)}-${reference.referenceId.replace(/^sha256:/, '').slice(0, 16)}.json`,
  )
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tempPath, 'wx')
  try {
    await handle.writeFile(JSON.stringify(reference, null, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tempPath, outPath)
  await rm(checkpointPath, { force: true })
  return { reference, outPath }
}

import type { FingerprintReference, KbfProbe, ProbeSource } from '@antseed/fingerprints'
import {
  buildKbfChatRequestBody,
  compositionalProbeSource,
  computeMatchVector,
  computeReferenceId,
  matchesTolerance,
  parseKbfAnswers,
} from '@antseed/fingerprints'
import { randomBytes } from 'node:crypto'

/**
 * Build a certified KBF reference by enrolling a model through a trusted
 * OpenAI-compatible upstream API (the canonical provider, OpenRouter, a local
 * deployment of the open weights, …).
 *
 * Enrollment follows the published KBF protocol (arXiv:2605.29524):
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
  /** Extra headers merged into every request. */
  headers?: Record<string, string>
}

/**
 * Resolve the verifier upstream config into a usable API config, reading the
 * key from `apiKeyEnv` when set. Returns null when no upstream is configured.
 */
export function resolveUpstream(
  upstream: { baseUrl: string; apiKey?: string; apiKeyEnv?: string } | undefined,
): UpstreamApiConfig | null {
  if (!upstream?.baseUrl) return null
  const apiKey = (upstream.apiKeyEnv ? process.env[upstream.apiKeyEnv] : undefined) ?? upstream.apiKey
  return { baseUrl: upstream.baseUrl, ...(apiKey ? { apiKey } : {}) }
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
  /** Candidate probes drawn from the compositional space. Default 120. */
  candidateCount?: number
  /** Probes per upstream request. Default 10 (spec 07 KBF batch size). */
  batchSize?: number
  /** Consistency-filter passes. Default [0, 0.4, 0.8]. */
  temperatures?: number[]
  /** Hold-out self-test temperature. Default 0.7. */
  selfTestTemperature?: number
  /** Candidate probe origin. Default: the compositional source. */
  probeSource?: ProbeSource
  /** Minimum stable probes for a usable reference. Default MIN_REFERENCE_PROBES. */
  minProbes?: number
  /** Minimum hold-out coverage (parsed/total). Default MIN_SELF_TEST_COVERAGE. */
  minSelfTestCoverage?: number
  /** Maximum hold-out error rate (hamming/total). Default MAX_SELF_TEST_ERROR_RATE. */
  maxSelfTestErrorRate?: number
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch
  log?: (message: string) => void
}

const DEFAULT_CANDIDATE_COUNT = 120
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_TEMPERATURES = [0, 0.4, 0.8]
const DEFAULT_SELF_TEST_TEMPERATURE = 0.7

/** Minimum stable probes for a usable reference; below this, enrollment fails. */
export const MIN_REFERENCE_PROBES = 24

/**
 * Hold-out quality gate. A reference whose independent hold-out pass barely
 * parses (low coverage) or barely matches its own certified consensus (high
 * error rate) would still be persisted and drive verdicts — including
 * single-seller mode, where it is the only ground truth. `computeKbfVerdict`
 * derives the honest-mismatch bound p₀ from the self-test, so a degenerate
 * self-test (coverage 0, error rate 1) makes every verdict vacuous. Reject at
 * enrollment instead.
 */
export const MIN_SELF_TEST_COVERAGE = 0.8
export const MAX_SELF_TEST_ERROR_RATE = 0.35

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
  error?: { message?: string }
}

async function queryBatch(
  upstream: UpstreamApiConfig,
  model: string,
  batch: readonly KbfProbe[],
  temperature: number,
  fetchFn: typeof fetch,
): Promise<Array<number | null>> {
  const body = { ...buildKbfChatRequestBody(model, batch), temperature }
  const response = await fetchFn(`${upstream.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
      ...(upstream.headers ?? {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`upstream ${response.status}: ${text.slice(0, 200)}`)
  }
  const parsed = (await response.json()) as ChatCompletionResponse
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error(`upstream returned no text content${parsed.error?.message ? `: ${parsed.error.message}` : ''}`)
  }
  return parseKbfAnswers(content, batch.length)
}

/** One full pass over all candidates at a fixed temperature. */
async function samplePass(
  upstream: UpstreamApiConfig,
  model: string,
  candidates: readonly KbfProbe[],
  temperature: number,
  batchSize: number,
  fetchFn: typeof fetch,
  warn: (message: string) => void,
): Promise<Array<number | null>> {
  const answers: Array<number | null> = new Array(candidates.length).fill(null)
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize)
    try {
      const parsed = await queryBatch(upstream, model, batch, temperature, fetchFn)
      for (let i = 0; i < batch.length; i++) answers[start + i] = parsed[i]!
    } catch (err) {
      warn(`batch at ${start} (temp ${temperature}) failed: ${(err as Error).message}`)
    }
  }
  return answers
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export async function buildKbfReference(
  upstream: UpstreamApiConfig,
  options: BuildReferenceOptions,
): Promise<FingerprintReference> {
  const {
    model,
    service = options.model,
    aliases = [],
    candidateCount = DEFAULT_CANDIDATE_COUNT,
    batchSize = DEFAULT_BATCH_SIZE,
    temperatures = DEFAULT_TEMPERATURES,
    selfTestTemperature = DEFAULT_SELF_TEST_TEMPERATURE,
    probeSource,
    minProbes = MIN_REFERENCE_PROBES,
    minSelfTestCoverage = MIN_SELF_TEST_COVERAGE,
    maxSelfTestErrorRate = MAX_SELF_TEST_ERROR_RATE,
    fetchFn = fetch,
    log = () => {},
  } = options
  if (temperatures.length < 2) {
    throw new Error('buildKbfReference: need at least 2 consistency-filter temperatures')
  }

  const source = probeSource ?? compositionalProbeSource()
  const candidates = source.generate({
    count: Math.min(candidateCount, source.size),
    seed: randomBytes(32).toString('hex'),
  })
  log(`Enrolling ${model}: ${candidates.length} candidate probes, ${temperatures.length} consistency passes`)

  // Reference-consistency filtering: one pass per temperature.
  const passes: Array<Array<number | null>> = []
  for (const temperature of temperatures) {
    passes.push(await samplePass(upstream, model, candidates, temperature, batchSize, fetchFn, log))
  }

  const stable: KbfProbe[] = []
  for (let i = 0; i < candidates.length; i++) {
    const probe = candidates[i]!
    const samples = passes.map((pass) => pass[i])
    if (samples.some((s) => s === null || s === undefined || !Number.isFinite(s))) continue
    const values = samples as number[]
    const [lo, hi] = probe.range
    if (values.some((v) => v < lo || v > hi)) continue
    const consensus = median(values)
    const certified: KbfProbe = { ...probe, consensus, advisoryConsensus: false }
    // Stable = every sample within the probe's own tolerance of the median.
    if (!values.every((v) => matchesTolerance(v, certified))) continue
    stable.push(certified)
  }
  log(`${stable.length}/${candidates.length} probes stable across temperatures`)
  if (stable.length < minProbes) {
    throw new Error(
      `buildKbfReference: only ${stable.length} stable probes (< ${minProbes}); ` +
        'the upstream endpoint may be unreliable for this model',
    )
  }

  // Independent hold-out pass scored against the certified consensus: the
  // reference's own honest error rate (selfTest) that p₀ is derived from.
  const selfAnswers = await samplePass(upstream, model, stable, selfTestTemperature, batchSize, fetchFn, log)
  const matchVector = computeMatchVector(selfAnswers, stable)
  const total = stable.length
  const matched = matchVector.filter((entry) => entry === 1).length
  const parsed = matchVector.filter((entry) => entry !== null).length
  const hamming = total - matched // unparseable/out-of-range counts as mismatch
  const selfTest = {
    hamming,
    total,
    coverage: total > 0 ? parsed / total : 0,
    errorRate: total > 0 ? hamming / total : 0,
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
  const reference: FingerprintReference = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: service,
    serviceAliases,
    createdAt: new Date().toISOString(),
    source: 'generated',
    generator: {
      name: 'antseed-cli-upstream-enrollment',
      version: '1',
      verifierKind: 'kbf',
      params: {
        upstreamBaseUrl: upstream.baseUrl,
        upstreamModel: model,
        candidateCount: candidates.length,
        temperatures,
        selfTestTemperature,
      },
    },
    selfTest,
    probes: stable,
  }
  reference.referenceId = computeReferenceId(reference)
  return reference
}

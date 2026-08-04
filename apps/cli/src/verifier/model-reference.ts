import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  KBF_ENROLLMENT_TEMPERATURES,
  KBF_PROBES_PER_REQUEST,
  buildKbfChatRequestBody,
  computeBinomialPower,
  computeMatchVector,
  computeReferenceId,
  createReferenceQueryProfile,
  matchesTolerance,
  parseKbfAnswers,
  validateCandidateProbes,
  validateKbfReferenceV1,
  type KbfProbe,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig, VerifierReferenceEndpointConfig } from '../config/types.js'
import { safeServiceSlug } from './slug.js'
import { VERIFICATION_PROBE_COUNT } from './model-run.js'

const CANDIDATE_COUNT = 300
const CANDIDATE_BATCH_SIZE = 50
const MAX_TOKENS = 1600
const MINIMUM_MISMATCH_DELTA = 0.1

export async function loadModelReference(input: {
  model: string
  referencesDir: string
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
    const reference = validateKbfReferenceV1(JSON.parse(raw), { trustImported: true })
    if (!reference.serviceAliases.some((alias) => normalized(alias) === normalized(input.model))) {
      throw new Error(`reference does not include service alias ${input.model}`)
    }
    if (reference.probes.length !== VERIFICATION_PROBE_COUNT) {
      throw new Error(`reference must contain exactly ${VERIFICATION_PROBE_COUNT} probes`)
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
  const query = (model: string, body: Record<string, unknown>) => postChatCompletion(endpoint, apiKey, model, body, input.fetchFn ?? fetch)
  input.log?.(`generating ${CANDIDATE_COUNT} candidate probes`)
  const candidates = await generateCandidates(modelConfig.upstreamModel, query)
  if (candidates.length < VERIFICATION_PROBE_COUNT) {
    throw new Error(`reference builder produced only ${candidates.length} valid candidates`)
  }

  input.log?.(`testing ${candidates.length} candidates for stability`)
  const passes = await Promise.all(KBF_ENROLLMENT_TEMPERATURES.map((temperature) => {
    return queryProbeAnswers(modelConfig.upstreamModel, candidates, temperature, query)
  }))
  const stable = candidates.flatMap((probe, index) => {
    const values = passes.map((pass) => pass[index]).filter((value): value is number => value !== null)
    if (values.length !== passes.length) return []
    const consensus = median(values)
    const certified = { ...probe, consensus }
    return values.every((value) => matchesTolerance(value, certified)) ? [certified] : []
  })

  let distinguishing = stable
  for (const contrastModel of modelConfig.contrastModels) {
    input.log?.(`checking contrast model ${contrastModel}`)
    const answers = await queryProbeAnswers(contrastModel, distinguishing, 0, query)
    distinguishing = distinguishing.filter((probe, index) => {
      const answer = answers[index]
      return answer !== null && !matchesTolerance(answer, probe)
    })
  }
  if (distinguishing.length < VERIFICATION_PROBE_COUNT) {
    throw new Error(`only ${distinguishing.length} stable distinguishing probes; ${VERIFICATION_PROBE_COUNT} required`)
  }

  const probes = distinguishing.slice(0, VERIFICATION_PROBE_COUNT)
  input.log?.(`self-testing ${probes.length} selected probes`)
  const selfAnswers = await queryProbeAnswers(modelConfig.upstreamModel, probes, 0, query)
  const matches = computeMatchVector(selfAnswers, probes)
  const parsed = matches.filter((match) => match !== null).length
  const hamming = matches.filter((match) => match !== 1).length
  const selfTest = {
    hamming,
    total: probes.length,
    coverage: parsed / probes.length,
    errorRate: hamming / probes.length,
    outcomes: probes.map((probe, index) => ({ probeId: probe.id, answer: selfAnswers[index] ?? null, match: matches[index]! })),
  }
  if (selfTest.coverage < 0.8) throw new Error(`self-test coverage ${selfTest.coverage.toFixed(3)} is below 0.8`)
  if (selfTest.errorRate > 0.35) throw new Error(`self-test error rate ${selfTest.errorRate.toFixed(3)} exceeds 0.35`)
  const power = computeBinomialPower({ selfHamming: hamming, selfTotal: probes.length, minimumMismatchDelta: MINIMUM_MISMATCH_DELTA })
  if (power.power < 0.9) throw new Error(`reference statistical power ${power.power.toFixed(3)} is below 0.9`)
  const queryProfile = createReferenceQueryProfile({
    upstreamModel: modelConfig.upstreamModel,
    maxTokensPerRequest: MAX_TOKENS,
    requestTimeoutMs: input.config?.probeRequestTimeoutMs ?? 120_000,
  })
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
      version: '1',
      verifierKind: 'kbf',
      params: { sourceId: endpoint.sourceId, upstreamModel: modelConfig.upstreamModel, candidateCount: candidates.length },
    },
    provenance: { sourceId: endpoint.sourceId, trust: endpoint.trust },
    queryProfile,
    selfTest,
    probes,
    selectedProbeCount: probes.length,
    minimumMismatchDelta: MINIMUM_MISMATCH_DELTA,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: hamming,
      selfTotal: probes.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: modelConfig.contrastModels.map((model) => ({ model, distinguishingProbeIds: probes.map((probe) => probe.id) })),
  }
  reference.referenceId = computeReferenceId(reference)
  const validated = validateKbfReferenceV1(reference)
  const path = referencePath(input.referencesDir, input.model)
  await writeReference(path, validated)
  return { reference: validated, path }
}

function findModelConfig(endpoint: VerifierReferenceEndpointConfig, model: string) {
  return Object.entries(endpoint.models).find(([service]) => normalized(service) === normalized(model))?.[1]
}

async function generateCandidates(
  model: string,
  query: (model: string, body: Record<string, unknown>) => Promise<string>,
): Promise<KbfProbe[]> {
  const probes: KbfProbe[] = []
  const seen = new Set<string>()
  for (let offset = 0; offset < CANDIDATE_COUNT; offset += CANDIDATE_BATCH_SIZE) {
    const content = await query(model, {
      model,
      temperature: 0.7,
      max_tokens: 6000,
      messages: [
        { role: 'system', content: 'Create stable numeric factual-recall probes. Output only valid JSON.' },
        { role: 'user', content: candidatePrompt(CANDIDATE_BATCH_SIZE, offset / CANDIDATE_BATCH_SIZE) },
      ],
    })
    const parsed = parseJsonArray(content)
    const validated = validateCandidateProbes(parsed)
    for (const probe of validated.probes) {
      if (!seen.has(probe.id)) {
        seen.add(probe.id)
        probes.push(probe)
      }
    }
  }
  return probes
}

function candidatePrompt(count: number, batch: number): string {
  return `Generate ${count} diverse specialist numeric facts for batch ${batch + 1}. Return a JSON array. Each object must contain name, domain, template with exactly one ___ marker, consensus number, range [lo,hi], and tolerance {mode:"absolute"|"relative",value:number}. Avoid current, volatile, or ambiguous facts.`
}

async function queryProbeAnswers(
  model: string,
  probes: readonly KbfProbe[],
  temperature: number,
  query: (model: string, body: Record<string, unknown>) => Promise<string>,
): Promise<Array<number | null>> {
  const answers: Array<number | null> = []
  for (let offset = 0; offset < probes.length; offset += KBF_PROBES_PER_REQUEST) {
    const batch = probes.slice(offset, offset + KBF_PROBES_PER_REQUEST)
    const body = { ...buildKbfChatRequestBody(model, batch, { maxTokens: MAX_TOKENS }), temperature, top_p: 1 }
    const content = await query(model, body)
    answers.push(...parseKbfAnswers(content, batch.length))
  }
  return answers
}

async function postChatCompletion(
  endpoint: VerifierReferenceEndpointConfig,
  apiKey: string | undefined,
  model: string,
  body: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetchFn(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(endpoint.antseedPeerId ? { 'x-antseed-pin-peer': endpoint.antseedPeerId } : {}),
      },
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`reference endpoint ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const parsed = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = parsed.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') throw new Error('reference endpoint returned no text content')
    return content
  } finally {
    clearTimeout(timeout)
  }
}

function parseJsonArray(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(trimmed)
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
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

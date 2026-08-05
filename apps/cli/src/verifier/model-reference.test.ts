import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import { buildModelReference, collectReferenceProbes, loadModelReference } from './model-reference.js'

const MODEL = 'gpt-test'

function config(overrides: Partial<VerifierCLIConfig> = {}): VerifierCLIConfig {
  return {
    probeRequestTimeoutMs: 120_000,
    referenceRetryBaseDelayMs: 1,
    referenceEndpoint: {
      baseUrl: 'https://reference.test/v1',
      sourceId: 'test-source',
      trust: 'trusted' as const,
      models: {
        [MODEL]: { upstreamModel: 'upstream-test', contrastModels: [] },
      },
    },
    ...overrides,
  }
}

function reference(count: number, hamming = 0, alpha = 0.05, confidence = 0.99): KbfReferenceV1 {
  const probes = Array.from({ length: count }, (_, index) => ({
    id: `probe-${index + 1}`,
    name: `test probe ${index + 1}`,
    domain: 'test',
    template: `The test probe ${index + 1} value is ___.`,
    consensus: index + 1,
    range: [0, count + 10] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0 },
  }))
  const power = computeBinomialPower({
    selfHamming: hamming,
    selfTotal: count,
    minimumMismatchDelta: 0.1,
    alpha,
    cpConfidence: confidence,
  })
  const value: KbfReferenceV1 = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: MODEL,
    serviceAliases: [MODEL],
    createdAt: '2026-08-05T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'upstream-test' }),
    selfTest: {
      hamming,
      total: count,
      coverage: 1,
      errorRate: hamming / count,
      outcomes: probes.map((probe, index) => ({
        probeId: probe.id,
        answer: probe.consensus + (index < hamming ? 0.5 : 0),
        match: index < hamming ? 0 : 1,
      })),
    },
    probes,
    selectedProbeCount: count,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha,
      clopperPearsonConfidence: confidence,
      selfHamming: hamming,
      selfTotal: count,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [],
  }
  value.referenceId = computeReferenceId(value)
  return value
}

function generatedCandidates(prompt: string): string {
  const count = Number(prompt.match(/^Generate (?:exactly )?(\d+)/)?.[1])
  const round = Number(prompt.match(/generation round (\d+)/)?.[1])
  const batch = Number(prompt.match(/batch (\d+)/)?.[1])
  const offset = (round - 1) * 10_000 + (batch - 1) * count
  return JSON.stringify(Array.from({ length: count }, (_, index) => {
    const value = offset + index + 1
    return {
      name: `stable fact ${value}`,
      domain: 'test',
      template: `The stable specialist test value ${value} is ___.`,
      consensus: value,
      range: [0, 100_000],
      tolerance: { mode: 'absolute', value: 0 },
    }
  }))
}

function successfulContent(model: string, prompt: string): string {
  if (prompt.startsWith('Generate ')) return generatedCandidates(prompt)
  const values = [...prompt.matchAll(/test value (\d+) is ___/g)].map((match) => Number(match[1]))
  return values.map((value, index) => `(${index + 1}) ${model.startsWith('contrast-') ? value + 100_000 : value}`).join('\n')
}

function response(content: string, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content } }] } : { error: content }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('missing references fail with the explicit build command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-load-'))
  try {
    await assert.rejects(
      loadModelReference({ model: MODEL, referencesDir: directory }),
      new RegExp(`antseed verifier reference build ${MODEL}`),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference build writes one valid file that the run loader reuses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-build-'))
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    return response(successfulContent(body.model, prompt))
  }
  try {
    const built = await buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn })
    assert.equal(built.reference.probes.length, 100)
    const loaded = await loadModelReference({ model: MODEL, referencesDir: directory })
    assert.equal(loaded.reference.referenceId, built.reference.referenceId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('loader rejects references outside the configured adaptive sizing policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-policy-'))
  const path = join(directory, `${MODEL}.json`)
  try {
    for (const [candidate, policy, message] of [
      [reference(50), undefined, /probe count 50/],
      [reference(510), undefined, /probe count 510/],
      [reference(110), config({ referenceProbeStep: 20 }), /adaptive sizing sequence/],
      [reference(100, 2), undefined, /statistical power .* is below 0\.900/],
      [reference(100, 0, 0.1), undefined, /statistical power alpha must be 0\.05/],
      [reference(100, 0, 0.05, 0.98), undefined, /Clopper-Pearson confidence must be 0\.99/],
    ] as const) {
      await writeFile(path, JSON.stringify(candidate))
      await assert.rejects(
        loadModelReference({ model: MODEL, referencesDir: directory, config: policy }),
        message,
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('adaptive builder selects the first powered prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-adaptive-'))
  const zeroTemperatureCalls = new Map<string, number>()
  const mismatches = new Set([1, 2, 101, 102])
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      temperature: number
      messages: Array<{ content: string }>
    }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('Reply with only the number 7')) return response('7')
    if (prompt.startsWith('Generate ')) return response(generatedCandidates(prompt))
    const values = [...prompt.matchAll(/test value (\d+) is ___/g)].map((match) => Number(match[1]))
    const zeroCall = body.temperature === 0 ? (zeroTemperatureCalls.get(prompt) ?? 0) + 1 : 0
    if (body.temperature === 0) zeroTemperatureCalls.set(prompt, zeroCall)
    const selfTest = body.temperature === 0 && zeroCall === 2
    return response(values.map((value, index) => (
      `(${index + 1}) ${selfTest && mismatches.has(value) ? value + 0.5 : value}`
    )).join('\n'))
  }
  try {
    const built = await buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn })
    assert.equal(built.reference.probes.length, 120)
    assert.equal(built.reference.selfTest.hamming, 4)
    assert.ok(built.reference.statisticalPower >= 0.9)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('adaptive builder generates more candidates when the next step is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-grow-pool-'))
  const generationRounds = new Set<number>()
  const zeroTemperatureCalls = new Map<string, number>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { temperature: number; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('Reply with only the number 7')) return response('7')
    if (prompt.startsWith('Generate ')) {
      const round = Number(prompt.match(/generation round (\d+)/)?.[1])
      const batch = Number(prompt.match(/batch (\d+)/)?.[1])
      generationRounds.add(round)
      const offset = (round - 1) * 10_000 + (batch - 1) * 100
      return response(JSON.stringify(Array.from({ length: 7 }, (_, index) => {
        const value = offset + index + 1
        return {
          name: `stable fact ${value}`,
          domain: 'test',
          template: `The stable specialist test value ${value} is ___.`,
          consensus: value,
          range: [0, 100_000],
          tolerance: { mode: 'absolute', value: 0 },
        }
      })))
    }
    const values = [...prompt.matchAll(/test value (\d+) is ___/g)].map((match) => Number(match[1]))
    const zeroCall = body.temperature === 0 ? (zeroTemperatureCalls.get(prompt) ?? 0) + 1 : 0
    if (body.temperature === 0) zeroTemperatureCalls.set(prompt, zeroCall)
    const selfTest = body.temperature === 0 && zeroCall === 2
    return response(values.map((value, index) => (
      `(${index + 1}) ${selfTest && [1, 2].includes(value) ? value + 0.5 : value}`
    )).join('\n'))
  }
  try {
    const built = await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config({ referenceMaximumProbeCount: 110 }),
      fetchFn,
    })
    assert.equal(built.reference.probes.length, 110)
    assert.deepEqual([...generationRounds], [1, 2])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('underpowered 500-probe maximum preserves the previous reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-underpowered-'))
  const path = join(directory, `${MODEL}.json`)
  await mkdir(directory, { recursive: true })
  await writeFile(path, 'existing-reference')
  const zeroTemperatureCalls = new Map<string, number>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      temperature: number
      messages: Array<{ content: string }>
    }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('Reply with only the number 7')) return response('7')
    if (prompt.startsWith('Generate ')) return response(generatedCandidates(prompt))
    const values = [...prompt.matchAll(/test value (\d+) is ___/g)].map((match) => Number(match[1]))
    const zeroCall = body.temperature === 0 ? (zeroTemperatureCalls.get(prompt) ?? 0) + 1 : 0
    if (body.temperature === 0) zeroTemperatureCalls.set(prompt, zeroCall)
    const selfTest = body.temperature === 0 && zeroCall === 2
    return response(values.map((value, index) => (
      `(${index + 1}) ${selfTest && index === 0 ? value + 0.5 : value}`
    )).join('\n'))
  }
  try {
    await assert.rejects(buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config({ referenceMinimumStatisticalPower: 1 }),
      fetchFn,
    }), /underpowered at 500 probes/)
    assert.equal(await readFile(path, 'utf8'), 'existing-reference')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('collector generates until target and accepts probes distinguishing any contrast', async () => {
  let generated = 0
  const query = async (model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) {
      const count = Number(prompt.match(/^Generate (?:exactly )?(\d+)/)?.[1])
      return JSON.stringify(Array.from({ length: count }, () => {
        generated += 1
        return {
          name: `collector fact ${generated}`,
          domain: 'test',
          template: `The stable collector test value ${generated} is ___.`,
          consensus: generated,
          range: [0, 1000],
          tolerance: { mode: 'absolute', value: 0 },
        }
      }))
    }
    const values = [...prompt.matchAll(/collector test value (\d+) is ___/g)].map((match) => Number(match[1]))
    return values.map((value, index) => {
      const differs = model === 'contrast-a' ? value % 2 === 1 : model === 'contrast-b' && value % 2 === 0
      return `(${index + 1}) ${differs ? value + 100 : value}`
    }).join('\n')
  }

  const collected = await collectReferenceProbes({
    model: 'reference-model',
    contrastModels: ['contrast-a', 'contrast-b'],
    targetCount: 4,
    candidateCountPerRound: 2,
    query,
  })

  assert.equal(generated, 4)
  assert.equal(collected.probes.length, 4)
  assert.deepEqual(collected.distinguishingProbeIdsByModel.get('contrast-a'), [
    collected.probes[0]!.id,
    collected.probes[2]!.id,
  ])
  assert.deepEqual(collected.distinguishingProbeIdsByModel.get('contrast-b'), [
    collected.probes[1]!.id,
    collected.probes[3]!.id,
  ])
})

test('collector stops after repeated rounds without progress', async () => {
  let generationRequests = 0
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) {
      generationRequests += 1
      return JSON.stringify([{
        name: 'duplicate fact',
        domain: 'test',
        template: 'The stable duplicate collector value is ___.',
        consensus: 1,
        range: [0, 10],
        tolerance: { mode: 'absolute', value: 0 },
      }])
    }
    return '(1) 1'
  }

  await assert.rejects(collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 2,
    candidateCountPerRound: 1,
    maxNoProgressRounds: 2,
    query,
  }), /made no progress for 2 rounds/)
  assert.equal(generationRequests, 3)
})

test('collector rejects certified consensus values outside the declared range', async () => {
  let generationRound = 0
  const query = async (_model: string, body: Record<string, unknown>): Promise<string> => {
    const messages = body.messages as Array<{ content: string }>
    const prompt = messages.at(-1)?.content ?? ''
    if (prompt.startsWith('Generate ')) {
      generationRound += 1
      return JSON.stringify([{
        name: `range fact ${generationRound}`,
        domain: 'test',
        template: `The range collector value ${generationRound} is ___.`,
        consensus: 5,
        range: [0, 10],
        tolerance: { mode: 'absolute', value: 20 },
      }])
    }
    const value = Number(prompt.match(/range collector value (\d+) is ___/)?.[1])
    return `(1) ${value === 1 ? 15 : 5}`
  }

  const collected = await collectReferenceProbes({
    model: 'reference-model',
    contrastModels: [],
    targetCount: 1,
    candidateCountPerRound: 1,
    query,
  })
  assert.equal(generationRound, 2)
  assert.equal(collected.probes[0]?.consensus, 5)
})

test('reference requests retry transient failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-retry-'))
  let firstCandidateBatchAttempts = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('generation round 1, batch 1.') && firstCandidateBatchAttempts++ === 0) {
      return response('throttled', 429)
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    const built = await buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn })
    assert.equal(built.reference.probes.length, 100)
    assert.equal(firstCandidateBatchAttempts, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference builds enforce the physical request budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-budget-'))
  const budgetedConfig = { ...config(), referenceMaxRequestsPerBuild: 1 }
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    return response(successfulContent(body.model, prompt))
  }
  try {
    await assert.rejects(
      buildModelReference({ model: MODEL, referencesDir: directory, config: budgetedConfig, fetchFn }),
      /request budget exhausted \(1\)/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed builds resume cached reference responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-resume-'))
  const promptCalls = new Map<string, number>()
  let failSecondCandidateBatch = true
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    promptCalls.set(prompt, (promptCalls.get(prompt) ?? 0) + 1)
    if (failSecondCandidateBatch && prompt.includes('generation round 1, batch 2')) {
      failSecondCandidateBatch = false
      return response('invalid request', 400)
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    await assert.rejects(buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn }), /reference endpoint 400/)
    await buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn })
    const firstCandidatePrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('generation round 1, batch 1'))!
    assert.equal(promptCalls.get(firstCandidatePrompt), 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('checkpoint compatibility invalidates changed sizing policies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-policy-checkpoint-'))
  let failSecondCandidateBatch = true
  const promptCalls = new Map<string, number>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    promptCalls.set(prompt, (promptCalls.get(prompt) ?? 0) + 1)
    if (failSecondCandidateBatch && prompt.includes('generation round 1, batch 2')) {
      failSecondCandidateBatch = false
      return response('invalid request', 400)
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    await assert.rejects(buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn }))
    await buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config({ referenceMinimumStatisticalPower: 0.91 }),
      fetchFn,
    })
    const firstCandidatePrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('generation round 1, batch 1'))!
    assert.equal(promptCalls.get(firstCandidatePrompt), 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed builds preserve an existing reference file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-preserve-'))
  const path = join(directory, `${MODEL}.json`)
  await mkdir(directory, { recursive: true })
  await writeFile(path, 'existing-reference')
  try {
    await assert.rejects(buildModelReference({
      model: MODEL,
      referencesDir: directory,
      config: config(),
      fetchFn: async () => response('missing content', 400),
    }), /reference endpoint 400/)
    assert.equal(await readFile(path, 'utf8'), 'existing-reference')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

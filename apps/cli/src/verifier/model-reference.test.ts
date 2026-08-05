import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildModelReference, collectReferenceProbes, loadModelReference } from './model-reference.js'

const MODEL = 'gpt-test'

function config() {
  return {
    probeRequestTimeoutMs: 120_000,
    maxTotalSpendUSDC: '1',
    referenceRetryBaseDelayMs: 1,
    referenceEndpoint: {
      baseUrl: 'https://reference.test/v1',
      sourceId: 'test-source',
      trust: 'trusted' as const,
      models: {
        [MODEL]: { upstreamModel: 'upstream-test', contrastModels: [] },
      },
    },
  }
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
  if (prompt.includes('Reply with only the number 7')) return '7'
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

test('reference requests retry transient failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-retry-'))
  let preflightAttempts = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)?.content ?? ''
    if (prompt.includes('Reply with only the number 7') && preflightAttempts++ === 0) {
      return response('throttled', 429)
    }
    return response(successfulContent(body.model, prompt))
  }
  try {
    const built = await buildModelReference({ model: MODEL, referencesDir: directory, config: config(), fetchFn })
    assert.equal(built.reference.probes.length, 100)
    assert.equal(preflightAttempts, 2)
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
    const preflightPrompt = [...promptCalls.keys()].find((prompt) => prompt.includes('Reply with only the number 7'))!
    assert.equal(promptCalls.get(firstCandidatePrompt), 1)
    assert.equal(promptCalls.get(preflightPrompt), 1)
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
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        const prompt = body.messages.at(-1)?.content ?? ''
        return prompt.includes('Reply with only the number 7') ? response('7') : response('missing content', 400)
      },
    }), /reference endpoint 400/)
    assert.equal(await readFile(path, 'utf8'), 'existing-reference')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

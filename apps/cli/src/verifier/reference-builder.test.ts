import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KbfProbe } from '@antseed/fingerprints'
import { computeReferenceId, createReferenceQueryProfile, staticProbeSource } from '@antseed/fingerprints'
import {
  buildKbfReference,
  endpointConfigHash,
  postChatCompletion,
  resolveUpstream,
  resolveUpstreamModel,
} from './reference-builder.js'
import { generateAdaptiveProbes, type AdaptiveGenerationCheckpoint } from './adaptive-probes.js'

function probes(count: number): KbfProbe[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `p-${index.toString().padStart(3, '0')}`,
    name: `probe-${index.toString().padStart(3, '0')}`,
    domain: 'test',
    template: `The test value of {name} is ___.`,
    consensus: index + 100,
    range: [0, 10_000],
    tolerance: { mode: 'absolute', value: 0.1 },
    advisoryConsensus: true,
  }))
}

function probeValue(name: string): number {
  const index = Number(name.slice('probe-'.length))
  if (!Number.isInteger(index)) throw new Error(`unexpected probe ${name}`)
  return index + 100
}

function fakeUpstream(
  answerFor: (input: { name: string; model: string; call: number; temperature: number }) => number | string,
) {
  let calls = 0
  const requests: Array<{ model: string; temperature: number; probeCount: number; headers: Record<string, string> }> = []
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const call = calls++
    const body = JSON.parse(String(init?.body)) as {
      model: string
      temperature: number
      messages: Array<{ role: string; content: string }>
    }
    const userContent = body.messages.find((message) => message.role === 'user')?.content ?? ''
    const lines: string[] = []
    for (const line of userContent.split('\n')) {
      const match = /^\((\d+)\) The test value of (.+?) is/.exec(line)
      if (match) {
        lines.push(`(${match[1]}) ${answerFor({
          name: match[2]!,
          model: body.model,
          call,
          temperature: body.temperature,
        })}`)
      }
    }
    requests.push({
      model: body.model,
      temperature: body.temperature,
      probeCount: lines.length,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    })
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: lines.join('\n') } }] }),
      text: async () => '',
    } as unknown as Response
  }) as typeof fetch
  return { fetchFn, requests }
}

test('builds the configured 100-probe smoke reference with ten probes per request', async () => {
  const source = probes(100)
  const { fetchFn, requests } = fakeUpstream(({ name }) => probeValue(name))
  const reference = await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1', apiKey: 'sk-test' },
    {
      model: 'Qwen/Qwen3-32B',
      service: 'qwen/qwen3-32b',
      aliases: ['qwen3-32b'],
      probeSource: staticProbeSource('test/v1', source),
      candidateCount: 100,
      fetchFn,
    },
  )

  assert.equal(reference.selectedProbeCount, 100)
  assert.equal(reference.probes.length, 100)
  assert.equal(reference.selfTest.outcomes.length, 100)
  assert.equal(reference.selfTest.hamming, 0)
  assert.ok(reference.statisticalPower >= 0.9)
  assert.equal(reference.referenceId, computeReferenceId(reference))
  assert.deepEqual(reference.queryProfile.enrollmentTemperatures, [0, 0.7, 0.7])
  assert.equal(reference.queryProfile.selfTestTemperature, 0)
  assert.equal(reference.queryProfile.contrastTemperature, 0)
  assert.equal(reference.queryProfile.auditTemperature, 0)
  assert.equal(reference.queryProfile.probesPerRequest, 10)
  assert.equal(requests.length, 40)
  assert.ok(requests.every((request) => request.probeCount === 10))
  assert.ok(requests.every((request) => request.model === 'Qwen/Qwen3-32B'))
  assert.ok(requests.every((request) => request.headers.authorization === 'Bearer sk-test'))
})

test('retains the complete configured certified reference pool when powered', async () => {
  const source = probes(200)
  const { fetchFn } = fakeUpstream(({ name }) => probeValue(name))
  const reference = await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1' },
    {
      model: 'model-200',
      probeSource: staticProbeSource('test/v1', source),
      candidateCount: 200,
      minimumMismatchDelta: 0.07,
      maxSelfTestErrorRate: 0.05,
      fetchFn,
    },
  )
  assert.equal(reference.selectedProbeCount, 200)
  assert.equal(reference.selfTest.hamming, 0)
  assert.ok(reference.statisticalPower >= 0.9)
})

test('rejects a candidate pool with fewer than 100 contrast-distinguishing probes', async () => {
  const source = probes(100)
  const { fetchFn } = fakeUpstream(({ name, model }) => {
    const value = probeValue(name)
    const index = Number(name.slice('probe-'.length))
    return model === 'contrast-model' && index < 39 ? value + 1 : value
  })
  await assert.rejects(buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      {
        model: 'reference-model',
        contrastModels: ['contrast-model'],
        probeSource: staticProbeSource('test/v1', source),
        candidateCount: 100,
        fetchFn,
      },
  ), /only 39 contrast-distinguishing probes/)
})

test('rejects a reference that remains statistically underpowered at 500 probes', async () => {
  const source = probes(500)
  const { fetchFn } = fakeUpstream(({ name }) => probeValue(name))
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      {
        model: 'underpowered-model',
        probeSource: staticProbeSource('test/v1', source),
        candidateCount: 500,
        minimumMismatchDelta: 0.001,
        fetchFn,
      },
    ),
    /underpowered/,
  )
})

test('rejects non-canonical batching and temperature profiles', async () => {
  const source = staticProbeSource('test/v1', probes(100))
  const { fetchFn } = fakeUpstream(({ name }) => probeValue(name))
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      { model: 'm', probeSource: source, candidateCount: 100, batchSize: 20, fetchFn },
    ),
    /batchSize must be 10/,
  )
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      { model: 'm', probeSource: source, candidateCount: 100, temperatures: [0, 0.5, 0.7], fetchFn },
    ),
    /temperatures must be \[0, 0.7, 0.7\]/,
  )
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      { model: 'm', probeSource: source, candidateCount: 100, selfTestTemperature: 0.7, fetchFn },
    ),
    /self-test temperature must be 0/,
  )
})

test('resolveUpstreamModel preserves case-sensitive advertised spelling and supports mappings', () => {
  assert.equal(resolveUpstreamModel(undefined, 'qwen/qwen3-32b', 'Qwen/Qwen3-32B'), 'Qwen/Qwen3-32B')
  assert.equal(
    resolveUpstreamModel({ 'qwen/qwen3-32b': 'qwen3-32b-upstream' }, 'qwen/qwen3-32b', 'Qwen/Qwen3-32B'),
    'qwen3-32b-upstream',
  )
  assert.equal(
    resolveUpstreamModel({ 'QWEN/QWEN3-32B': 'qwen3-32b-upstream' }, 'qwen/qwen3-32b', 'Qwen/Qwen3-32B'),
    'qwen3-32b-upstream',
  )
})

test('resolveUpstream reads the key from apiKeyEnv and falls back to apiKey', () => {
  process.env.ANTSEED_TEST_UPSTREAM_KEY = 'from-env'
  try {
    assert.equal(resolveUpstream(undefined), null)
    assert.equal(resolveUpstream({ baseUrl: '' }), null)
    assert.deepEqual(resolveUpstream({ baseUrl: 'https://u/v1', apiKey: 'inline' }), {
      baseUrl: 'https://u/v1',
      apiKey: 'inline',
    })
    assert.deepEqual(
      resolveUpstream({ baseUrl: 'https://u/v1', apiKey: 'inline', apiKeyEnv: 'ANTSEED_TEST_UPSTREAM_KEY' }),
      { baseUrl: 'https://u/v1', apiKey: 'from-env' },
    )
  } finally {
    delete process.env.ANTSEED_TEST_UPSTREAM_KEY
  }
})

test('endpoint hashing excludes API keys but invalidates Venice peer changes', () => {
  const queryProfile = createReferenceQueryProfile({ upstreamModel: 'gpt-5.6-sol' })
  const common = {
    model: 'gpt-5.6-sol',
    contrastModels: ['kimi-k3', 'gpt-5.6-luna', 'sonnet-4.8'],
    queryProfile,
  }
  const first = endpointConfigHash({
    ...common,
    upstream: {
      baseUrl: 'http://127.0.0.1:8377/v1/', apiKey: 'secret-one', sourceId: 'venice-smoke',
      trust: 'smoke', antseedPeerId: '9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7',
    },
  })
  const rotatedSecret = endpointConfigHash({
    ...common,
    upstream: {
      baseUrl: 'http://127.0.0.1:8377/v1', apiKey: 'secret-two', sourceId: 'venice-smoke',
      trust: 'smoke', antseedPeerId: '9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7',
    },
  })
  const direct = endpointConfigHash({
    ...common,
    upstream: {
      baseUrl: 'http://127.0.0.1:8377/v1', apiKey: 'secret-two', sourceId: 'venice-smoke', trust: 'smoke',
    },
  })
  assert.equal(first, rotatedSecret)
  assert.notEqual(first, direct)
  assert.equal(first.includes('secret'), false)
})

test('postChatCompletion pins every Venice request explicitly', async () => {
  let headers: Record<string, string> = {}
  await postChatCompletion(
    {
      baseUrl: 'http://127.0.0.1:8377/v1', apiKey: 'local-key',
      antseedPeerId: '9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7',
    },
    { model: 'gpt-5.6-sol', messages: [] },
    (async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as Response
    }) as typeof fetch,
  )
  assert.equal(headers['x-antseed-pin-peer'], '9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7')
  assert.equal(headers.authorization, 'Bearer local-key')
})

test('strict parser failures advance to the next reasoning suppression strategy', async () => {
  const source = probes(100)
  let malformedReturned = false
  const fetchFn = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      reasoning_effort?: string
      enable_thinking?: boolean
      messages: Array<{ role: string; content: string }>
    }
    if (body.reasoning_effort === 'none' && !malformedReturned) {
      malformedReturned = true
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '<think>hidden reasoning only</think>' } }] }),
      } as Response
    }
    const userContent = body.messages.find((message) => message.role === 'user')?.content ?? ''
    const lines = userContent.split('\n').flatMap((line) => {
      const match = /^\((\d+)\) The test value of (.+?) is/.exec(line)
      return match ? [`(${match[1]}) ${probeValue(match[2]!)}`] : []
    })
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: lines.join('\n') } }] }),
    } as Response
  }) as typeof fetch
  const reference = await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1' },
    {
      model: 'reference-model',
      probeSource: staticProbeSource('test/v1', source),
      candidateCount: 100,
      batchRetryCount: 1,
      fetchFn,
    },
  )
  assert.equal(reference.queryProfile.reasoningStrategy, 'disable-thinking')
  assert.deepEqual(reference.queryProfile.requestOverrides, { enable_thinking: false })
})

test('failed builds expose consumed request counts without leaking secrets', async () => {
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1', apiKey: 'do-not-leak' },
      {
        model: 'reference-model',
        probeSource: staticProbeSource('test/v1', probes(100)),
        candidateCount: 100,
        batchRetryCount: 0,
        fetchFn: (async () => ({
          ok: false,
          status: 503,
          text: async () => 'unavailable',
        } as unknown as Response)) as typeof fetch,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as Error & { requestCount?: number }).requestCount, 3)
      assert.equal(error.message.includes('do-not-leak'), false)
      return true
    },
  )
})

test('interrupted builds resume completed answer batches from an atomic checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-reference-checkpoint-'))
  const checkpointPath = join(directory, 'build.json')
  const source = staticProbeSource('test/v1', probes(100))
  const first = fakeUpstream(({ name }) => probeValue(name))
  let firstCalls = 0
  const interruptedFetch = (async (url, init) => {
    firstCalls += 1
    if (firstCalls === 5) {
      return { ok: false, status: 503, text: async () => 'temporary outage' } as Response
    }
    return first.fetchFn(url, init)
  }) as typeof fetch

  try {
    await assert.rejects(buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      {
        model: 'checkpoint-model',
        probeSource: source,
        candidateCount: 100,
        batchRetryCount: 0,
        checkpointPath,
        fetchFn: interruptedFetch,
      },
    ), /503/)
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      initialAnswers: Array<number | null>
      requestCount: number
    }
    assert.equal(checkpoint.initialAnswers.filter((answer) => answer !== null).length, 50)
    assert.equal(checkpoint.requestCount, 6)

    const resumed = fakeUpstream(({ name }) => probeValue(name))
    const reference = await buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      {
        model: 'checkpoint-model',
        probeSource: source,
        candidateCount: 100,
        batchRetryCount: 0,
        checkpointPath,
        fetchFn: resumed.fetchFn,
      },
    )
    assert.equal(reference.probes.length, 100)
    assert.equal(resumed.requests.length, 35)
    assert.equal((reference.generator.params as Record<string, unknown>).requestCount, 41)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('adaptive generation resumes after the last persisted domain round', async () => {
  let saved: AdaptiveGenerationCheckpoint | undefined
  let initialQueries = 0
  await assert.rejects(generateAdaptiveProbes({
    model: 'adaptive-model',
    count: 20,
    maxRounds: 2,
    query: async () => {
      initialQueries += 1
      return Array.from({ length: 15 }, (_unused, index) => `fact ${initialQueries}-${index} | ${index + 1}`).join('\n')
    },
    onProgress: async (checkpoint) => {
      saved = checkpoint
      throw new Error('interrupt after checkpoint')
    },
  }), /interrupt after checkpoint/)
  assert.ok(saved)
  assert.equal(saved.probes.length, 10)

  let resumedQueries = 0
  const resumed = await generateAdaptiveProbes({
    model: 'adaptive-model',
    count: 20,
    maxRounds: 2,
    resume: saved,
    query: async () => {
      resumedQueries += 1
      return Array.from({ length: 15 }, (_unused, index) => `resumed fact ${resumedQueries}-${index} | ${index + 1}`).join('\n')
    },
  })
  assert.equal(resumed.probes.length, 20)
  assert.equal(resumedQueries, 1)
  assert.equal(new Set(resumed.probes.map((probe) => probe.id)).size, 20)
})

test('adaptive builds reject an unavailable contrast before candidate generation', async () => {
  let generationRequests = 0
  const fetchFn = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages: Array<{ role: string; content: string }>
    }
    const userContent = body.messages.find((message) => message.role === 'user')?.content ?? ''
    if (userContent.includes('List 15')) generationRequests += 1
    if (body.model === 'missing-contrast') {
      return { ok: false, status: 400, text: async () => 'model is unavailable' } as Response
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: Array.from({ length: 10 }, (_unused, index) => `(${index + 1}) ${index + 1}`).join('\n') } }],
      }),
      text: async () => '',
    } as unknown as Response
  }) as typeof fetch

  await assert.rejects(buildKbfReference(
    { baseUrl: 'https://upstream.test/v1' },
    {
      model: 'reference-model',
      contrastModels: ['missing-contrast'],
      candidateCount: 100,
      minProbes: 100,
      batchRetryCount: 0,
      fetchFn,
    },
  ), /model is unavailable/)
  assert.equal(generationRequests, 0)
})

test('bounds concurrent reference requests globally and per model', async () => {
  let active = 0
  let maximumActive = 0
  const activeByModel = new Map<string, number>()
  const maximumByModel = new Map<string, number>()
  const fetchFn = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages: Array<{ role: string; content: string }>
    }
    active += 1
    maximumActive = Math.max(maximumActive, active)
    const modelActive = (activeByModel.get(body.model) ?? 0) + 1
    activeByModel.set(body.model, modelActive)
    maximumByModel.set(body.model, Math.max(maximumByModel.get(body.model) ?? 0, modelActive))
    await new Promise((resolve) => setTimeout(resolve, 2))
    const userContent = body.messages.find((message) => message.role === 'user')?.content ?? ''
    const lines = userContent.split('\n').flatMap((line) => {
      const match = /^\((\d+)\) The test value of (.+?) is/.exec(line)
      return match ? [`(${match[1]}) ${probeValue(match[2]!)}`] : []
    })
    active -= 1
    activeByModel.set(body.model, (activeByModel.get(body.model) ?? 1) - 1)
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: lines.join('\n') } }] }),
      text: async () => '',
    } as unknown as Response
  }) as typeof fetch

  await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1' },
    {
      model: 'bounded-model',
      probeSource: staticProbeSource('test/v1', probes(100)),
      candidateCount: 100,
      maxConcurrentReferenceRequests: 4,
      maxConcurrentRequestsPerModel: 2,
      fetchFn,
    },
  )

  assert.equal(maximumActive, 2)
  assert.equal(maximumByModel.get('bounded-model'), 2)
})

test('runs the initial reference and contrast passes concurrently', async () => {
  let active = 0
  let maximumActive = 0
  const contrastModels = ['contrast-a', 'contrast-b', 'contrast-c']
  const fetchFn = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages: Array<{ role: string; content: string }>
    }
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    const userContent = body.messages.find((message) => message.role === 'user')?.content ?? ''
    const lines = userContent.split('\n').flatMap((line) => {
      const match = /^\((\d+)\) The test value of (.+?) is/.exec(line)
      if (!match) return []
      const value = probeValue(match[2]!) + (body.model.startsWith('contrast-') ? 1 : 0)
      return [`(${match[1]}) ${value}`]
    })
    active -= 1
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: lines.join('\n') } }] }),
      text: async () => '',
    } as unknown as Response
  }) as typeof fetch

  const reference = await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1' },
    {
      model: 'reference-model',
      contrastModels,
      probeSource: staticProbeSource('test/v1', probes(100)),
      candidateCount: 100,
      maxConcurrentReferenceRequests: 4,
      maxConcurrentRequestsPerModel: 2,
      fetchFn,
    },
  )

  assert.ok(maximumActive >= 3)
  assert.ok(maximumActive <= 4)
  assert.equal(reference.contrasts.length, 3)
  assert.ok(reference.contrasts.every((contrast) => contrast.distinguishingProbeIds.length === 100))
})

test('enforces the request budget exactly under concurrency', async () => {
  const { fetchFn } = fakeUpstream(({ name }) => probeValue(name))
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      {
        model: 'budget-model',
        probeSource: staticProbeSource('test/v1', probes(100)),
        candidateCount: 100,
        maxRequestsPerBuild: 5,
        batchRetryCount: 0,
        maxConcurrentReferenceRequests: 4,
        maxConcurrentRequestsPerModel: 2,
        fetchFn,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /request budget 5 exhausted/)
      assert.equal((error as Error & { requestCount?: number }).requestCount, 5)
      return true
    },
  )
})

test('parallel adaptive domains preserve deterministic taxonomy ordering', async () => {
  let active = 0
  let maximumActive = 0
  const query = async (): Promise<string> => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active -= 1
    return Array.from({ length: 15 }, (_unused, index) => `shared fact ${index} | ${index + 1}`).join('\n')
  }
  const concurrent = await generateAdaptiveProbes({
    model: 'adaptive-model',
    count: 30,
    domainConcurrency: 3,
    query,
  })
  const sequential = await generateAdaptiveProbes({
    model: 'adaptive-model',
    count: 30,
    domainConcurrency: 1,
    query: async () => Array.from({ length: 15 }, (_unused, index) => `shared fact ${index} | ${index + 1}`).join('\n'),
  })

  assert.equal(maximumActive, 3)
  assert.deepEqual(concurrent.probes.map((probe) => probe.id), sequential.probes.map((probe) => probe.id))
  assert.deepEqual([...new Set(concurrent.probes.map((probe) => probe.domain))], ['chemistry_bp', 'chemistry_mp', 'physics'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { KbfProbe } from '@antseed/fingerprints'
import { staticProbeSource, computeReferenceId } from '@antseed/fingerprints'
import { buildKbfReference, resolveUpstream } from './reference-builder.js'

function probe(id: string, name: string): KbfProbe {
  return {
    id,
    name,
    domain: 'test',
    template: `The test value of {name} is ___.`,
    consensus: 0, // advisory placeholder; enrollment certifies the real value
    range: [0, 10_000],
    tolerance: { mode: 'absolute', value: 1 },
    advisoryConsensus: true,
  }
}

/**
 * Fake OpenAI-compatible upstream: parses the numbered probe lines out of the
 * request and answers via `answerFor(probeName, callIndex)`.
 */
function fakeUpstream(answerFor: (name: string, call: number) => number | string) {
  let calls = 0
  const seenHeaders: Array<Record<string, string>> = []
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const call = calls++
    seenHeaders.push({ ...((init?.headers ?? {}) as Record<string, string>) })
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
    const userContent = body.messages.find((m) => m.role === 'user')?.content ?? ''
    const lines: string[] = []
    for (const line of userContent.split('\n')) {
      const match = /^\((\d+)\) The test value of (.+?) is/.exec(line)
      if (match) lines.push(`(${match[1]}) ${answerFor(match[2]!, call)}`)
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: lines.join('\n') } }] }),
      text: async () => '',
    } as unknown as Response
  }) as typeof fetch
  return { fetchFn, seenHeaders }
}

const STABLE_VALUES: Record<string, number> = {
  alpha: 10,
  beta: 250,
  gamma: 42,
  delta: 7,
}

function makeProbes(): KbfProbe[] {
  return [
    ...Object.keys(STABLE_VALUES).map((name, i) => probe(`p-${i}`, name)),
    probe('p-unstable', 'epsilon'),
    probe('p-oor', 'zeta'),
  ]
}

test('enrolls stable probes with certified median consensus and clean self-test', async () => {
  const { fetchFn, seenHeaders } = fakeUpstream((name, call) => {
    if (name in STABLE_VALUES) return STABLE_VALUES[name]!
    if (name === 'epsilon') return 100 + call * 50 // drifts across passes → unstable
    return 999_999 // zeta: out of range
  })

  const reference = await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1', apiKey: 'sk-test' },
    {
      model: 'kimi-k2-upstream',
      service: 'Kimi-K2',
      aliases: ['moonshotai/kimi-k2'],
      probeSource: staticProbeSource('test/v1', makeProbes()),
      candidateCount: 6,
      batchSize: 4,
      minProbes: 3,
      fetchFn,
    },
  )

  const enrolled = new Map(reference.probes.map((p) => [p.name, p]))
  assert.deepEqual([...enrolled.keys()].sort(), ['alpha', 'beta', 'delta', 'gamma'])
  for (const [name, value] of Object.entries(STABLE_VALUES)) {
    assert.equal(enrolled.get(name)!.consensus, value)
    assert.equal(enrolled.get(name)!.advisoryConsensus, false)
  }

  assert.equal(reference.selfTest.total, 4)
  assert.equal(reference.selfTest.hamming, 0)
  assert.equal(reference.selfTest.coverage, 1)
  assert.equal(reference.selfTest.errorRate, 0)

  assert.equal(reference.kind, 'kbf')
  assert.equal(reference.referenceModel, 'Kimi-K2')
  assert.ok(reference.serviceAliases.includes('kimi-k2'))
  assert.ok(reference.serviceAliases.includes('moonshotai/kimi-k2'))
  assert.ok(reference.serviceAliases.includes('kimi-k2-upstream'))
  assert.equal(reference.referenceId, computeReferenceId(reference))

  assert.ok(seenHeaders.every((h) => h['authorization'] === 'Bearer sk-test'))
})

test('self-test records the reference model own error rate', async () => {
  let selfTestStarted = false
  const { fetchFn } = fakeUpstream((name, call) => {
    // Passes 0-1 (temps [0, 0.5]) are consistent; the hold-out pass (call
    // index >= 2 in this batching: 6 probes / batch 10 → 1 request per pass)
    // answers alpha wrong.
    if (call >= 2) selfTestStarted = true
    if (name === 'alpha' && selfTestStarted) return STABLE_VALUES.alpha! + 500
    return STABLE_VALUES[name] ?? 1
  })

  const reference = await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1' },
    {
      model: 'm',
      probeSource: staticProbeSource('test/v1', makeProbes().slice(0, 4)),
      candidateCount: 4,
      temperatures: [0, 0.5],
      minProbes: 3,
      fetchFn,
    },
  )
  assert.equal(reference.selfTest.total, 4)
  assert.equal(reference.selfTest.hamming, 1)
  assert.equal(reference.selfTest.errorRate, 0.25)
})

test('throws when too few probes are stable', async () => {
  const { fetchFn } = fakeUpstream((_name, call) => 100 + call * 50) // everything drifts
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      {
        model: 'm',
        probeSource: staticProbeSource('test/v1', makeProbes()),
        candidateCount: 6,
        minProbes: 3,
        fetchFn,
      },
    ),
    /stable probes/,
  )
})

test('hold-out error rate at the configured boundary passes; above it rejects', async () => {
  const makeFetch = (wrongCount: number) => {
    let selfTestStarted = false
    const wrongNames = new Set(Object.keys(STABLE_VALUES).slice(0, wrongCount))
    return fakeUpstream((name, call) => {
      if (call >= 3) selfTestStarted = true // temps [0, 0.4, 0.8] → 3 consistency calls
      if (selfTestStarted && wrongNames.has(name)) return STABLE_VALUES[name]! + 500
      return STABLE_VALUES[name] ?? 1
    }).fetchFn
  }
  const options = {
    model: 'm',
    probeSource: staticProbeSource('test/v1', makeProbes().slice(0, 4)),
    candidateCount: 4,
    minProbes: 3,
    maxSelfTestErrorRate: 0.25,
  }

  // Exactly at the boundary (1/4 = 0.25): accepted.
  const reference = await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1' },
    { ...options, fetchFn: makeFetch(1) },
  )
  assert.equal(reference.selfTest.errorRate, 0.25)

  // One past the boundary (2/4 = 0.5): rejected, nothing usable returned.
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      { ...options, fetchFn: makeFetch(2) },
    ),
    /hold-out error rate/,
  )
})

test('hold-out coverage at the configured boundary passes; below it rejects', async () => {
  const makeFetch = (unparseableCount: number) => {
    let selfTestStarted = false
    const badNames = new Set(Object.keys(STABLE_VALUES).slice(0, unparseableCount))
    return fakeUpstream((name, call) => {
      if (call >= 3) selfTestStarted = true
      if (selfTestStarted && badNames.has(name)) return 'no idea' // unparseable
      return STABLE_VALUES[name] ?? 1
    }).fetchFn
  }
  const options = {
    model: 'm',
    probeSource: staticProbeSource('test/v1', makeProbes().slice(0, 4)),
    candidateCount: 4,
    minProbes: 3,
    minSelfTestCoverage: 0.75,
    maxSelfTestErrorRate: 0.25, // unparseable also counts as mismatch
  }

  // Exactly at the boundary (3/4 parsed = 0.75): accepted.
  const reference = await buildKbfReference(
    { baseUrl: 'https://upstream.test/v1' },
    { ...options, fetchFn: makeFetch(1) },
  )
  assert.equal(reference.selfTest.coverage, 0.75)

  // Below the boundary (2/4 = 0.5): rejected — a reference whose hold-out
  // pass barely parses must never be persisted or drive verdicts.
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      { ...options, fetchFn: makeFetch(2) },
    ),
    /hold-out coverage/,
  )
})

test('a degenerate hold-out (coverage 0, error rate 1) is rejected by defaults', async () => {
  let selfTestStarted = false
  const { fetchFn } = fakeUpstream((name, call) => {
    if (call >= 3) selfTestStarted = true
    if (selfTestStarted) return 'total garbage'
    return STABLE_VALUES[name] ?? 1
  })
  await assert.rejects(
    buildKbfReference(
      { baseUrl: 'https://upstream.test/v1' },
      {
        model: 'm',
        probeSource: staticProbeSource('test/v1', makeProbes().slice(0, 4)),
        candidateCount: 4,
        minProbes: 3,
        fetchFn,
      },
    ),
    /hold-out coverage/,
  )
})

test('resolveUpstream reads the key from apiKeyEnv and falls back to apiKey', () => {
  process.env['ANTSEED_TEST_UPSTREAM_KEY'] = 'from-env'
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
    delete process.env['ANTSEED_TEST_UPSTREAM_KEY']
  }
})

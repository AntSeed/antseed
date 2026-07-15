import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeLlmProbeId } from '@antseed/fingerprints'
import { authorProbes, buildAuthorPrompt, extractJsonArray } from './probe-author.js'

const SERVICE = 'kimi-k2'
const CERT_MODEL = 'moonshotai/Kimi-K2'
const AUTHOR_MODEL = 'gpt-5.2'

/** Stable "true" values the fake reference model answers with. */
const STABLE_VALUES: Record<string, number> = {
  alpha: 10,
  beta: 250,
  gamma: 42,
  delta: 7,
  epsilon: 99,
  zeta: 61,
}

function template(name: string): string {
  return `The certified quiz value called ${name} is ___ units in the standard test.`
}

function candidate(name: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: `probe-${name}`,
    domain: 'test',
    template: template(name),
    consensus: STABLE_VALUES[name] ?? 1,
    range: [0, 1_000],
    tolerance: { mode: 'absolute', value: 1 },
    ...overrides,
  }
}

/**
 * Fake upstream serving BOTH roles: the authoring request (answers with the
 * candidate JSON payload) and the certification passes (answers the numbered
 * "(N) …" lines per `answerFor`).
 */
function fakeUpstream(options: {
  authorPayload: string
  answerFor?: (name: string, certCall: number) => number | string
}) {
  const seenAuthorModels: string[] = []
  const seenCertModels: string[] = []
  let certCalls = 0
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> }
    const userContent = body.messages.find((m) => m.role === 'user')?.content ?? ''
    let content: string
    if (userContent.includes('Respond with ONLY a JSON array')) {
      seenAuthorModels.push(body.model)
      content = options.authorPayload
    } else {
      seenCertModels.push(body.model)
      const call = certCalls++
      const lines: string[] = []
      for (const line of userContent.split('\n')) {
        const match = /^\((\d+)\) The certified quiz value called (\w+) is/.exec(line)
        if (!match) continue
        const answer = options.answerFor?.(match[2]!, call) ?? STABLE_VALUES[match[2]!] ?? 1
        lines.push(`(${match[1]}) ${answer}`)
      }
      content = lines.join('\n')
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => '',
    } as unknown as Response
  }) as typeof fetch
  return { fetchFn, seenAuthorModels, seenCertModels }
}

test('extractJsonArray finds the array in plain, fenced, and prose-wrapped completions', () => {
  assert.deepEqual(extractJsonArray('[1, 2]'), [1, 2])
  assert.deepEqual(extractJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }])
  assert.deepEqual(extractJsonArray('Here you go:\n[3, 4]\nHope that helps!'), [3, 4])
  assert.equal(extractJsonArray('no json here'), null)
  assert.equal(extractJsonArray('{"an":"object, not an array"}'), null)
})

test('buildAuthorPrompt requests the exact candidate count and the strict schema', () => {
  const prompt = buildAuthorPrompt(12)
  assert.ok(prompt.includes('exactly 12'))
  assert.ok(prompt.includes('___'))
  assert.ok(prompt.includes('"tolerance"'))
})

test('authorProbes validates, dedupes against the rotation log, certifies, and returns exactly count probes', async () => {
  // 2x oversample for count=3 → 6 candidates requested; supply:
  //  - 4 good ones (alpha..delta),
  //  - 1 already used (epsilon — excluded via the rotation log),
  //  - 1 invalid (no ___ marker) and 1 volatile (banned pattern).
  const payload = 'Sure! Here are your questions:\n' + JSON.stringify([
    candidate('alpha'),
    candidate('beta'),
    candidate('gamma'),
    candidate('delta'),
    candidate('epsilon'),
    candidate('bad-marker', { template: 'This template has no blank marker at all, sadly.' }),
    candidate('volatile', { template: 'The current population of the test region is ___ people.' }),
  ])
  const { fetchFn, seenAuthorModels, seenCertModels } = fakeUpstream({ authorPayload: payload })

  const exclude = new Set([computeLlmProbeId('test', template('epsilon'))])
  const authored = await authorProbes(
    { baseUrl: 'https://upstream.test/v1', apiKey: 'sk-test' },
    {
      service: SERVICE,
      model: CERT_MODEL,
      authorModel: AUTHOR_MODEL,
      count: 3,
      exclude,
      temperatures: [0, 0.5],
      batchSize: 10,
      fetchFn,
    },
  )

  assert.equal(authored.probes.length, 3)
  assert.equal(authored.rejectedCount, 2, 'marker-less and volatile candidates are rejected')
  assert.equal(authored.dedupedCount, 1, 'the already-revealed candidate is dropped')
  for (const probe of authored.probes) {
    assert.ok(probe.id.startsWith('llm:test:'), 'ids are content-derived by the validator')
    const name = /called (\w+) is/.exec(probe.template)![1]!
    assert.equal(probe.consensus, STABLE_VALUES[name], 'consensus is the certified upstream median, not the LLM claim')
    assert.equal(probe.advisoryConsensus, false)
  }
  assert.equal(authored.selfTest.errorRate, 0)

  // Authoring goes to the author model; certification to the reference model.
  assert.deepEqual(seenAuthorModels, [AUTHOR_MODEL])
  assert.ok(seenCertModels.length > 0)
  assert.ok(seenCertModels.every((m) => m === CERT_MODEL))
})

test('authorProbes rejects a completion with no JSON array', async () => {
  const { fetchFn } = fakeUpstream({ authorPayload: 'I refuse to answer in JSON.' })
  await assert.rejects(
    authorProbes({ baseUrl: 'https://upstream.test/v1' }, {
      service: SERVICE, model: CERT_MODEL, count: 3, fetchFn,
    }),
    /no parseable JSON array/,
  )
})

test('authorProbes rejects when too few valid fresh candidates survive', async () => {
  const payload = JSON.stringify([
    candidate('alpha'),
    candidate('bad', { consensus: 'not-a-number' }),
  ])
  const { fetchFn } = fakeUpstream({ authorPayload: payload })
  await assert.rejects(
    authorProbes({ baseUrl: 'https://upstream.test/v1' }, {
      service: SERVICE, model: CERT_MODEL, count: 3, fetchFn,
    }),
    /valid fresh candidate/,
  )
})

test('authorProbes rejects when certification leaves fewer than count stable probes', async () => {
  const payload = JSON.stringify([
    candidate('alpha'),
    candidate('beta'),
    candidate('drift-1'),
    candidate('drift-2'),
  ])
  const { fetchFn } = fakeUpstream({
    authorPayload: payload,
    // Drifting candidates change answers across temperature passes → unstable.
    answerFor: (name, call) => name.startsWith('drift') ? 100 + call * 50 : STABLE_VALUES[name] ?? 1,
  })
  await assert.rejects(
    authorProbes({ baseUrl: 'https://upstream.test/v1' }, {
      service: SERVICE, model: CERT_MODEL, count: 3, temperatures: [0, 0.5], fetchFn,
    }),
    /stable probes/,
  )
})

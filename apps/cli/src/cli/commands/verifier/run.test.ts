import assert from 'node:assert/strict'
import test from 'node:test'
import { Command } from 'commander'
import { registerVerifierCommands } from './index.js'
import { resolveRunModels } from './run.js'

function command(): Command {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  registerVerifierCommands(program)
  return program
}

test('verifier exposes proxy run, reference, and claim workflows', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')
  assert.ok(verifier)
  assert.deepEqual(verifier.commands.map((entry) => entry.name()).sort(), ['claim', 'reference', 'run', 'status', 'submit'])
})

test('verifier submit exposes model-bundle submission controls', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const submit = verifier.commands.find((entry) => entry.name() === 'submit')!
  assert.deepEqual(submit.options.map((option) => option.long), ['--run-id', '--dry-run', '--yes', '--rpc-url'])
})

test('verifier reference exposes only the explicit build workflow', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const reference = verifier.commands.find((entry) => entry.name() === 'reference')!
  assert.deepEqual(reference.commands.map((entry) => entry.name()), ['build'])
  assert.deepEqual(reference.commands[0]!.registeredArguments.map((argument) => argument.name()), ['model'])
  assert.deepEqual(reference.commands[0]!.options.map((option) => option.long), ['--all'])
})

test('verifier run accepts one model or all configured models', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const run = verifier.commands.find((entry) => entry.name() === 'run')!
  assert.deepEqual(run.options.map((option) => option.long), ['--all', '--allow-probe-reuse', '--resume-run'])
  assert.deepEqual(run.registeredArguments.map((argument) => argument.name()), ['model'])
})

test('explicit resume limits model selection to the source manifest', () => {
  const verifier = {
    referenceEndpoint: {
      baseUrl: 'https://example.test',
      apiKeyEnv: 'TEST_API_KEY',
      sourceId: 'test',
      trust: 'trusted' as const,
      models: {
        'model-a': { upstreamModel: 'vendor/model-a' },
        'model-b': { upstreamModel: 'vendor/model-b' },
      },
    },
  }
  const manifest = {
    version: 1 as const,
    kind: 'antseed-verifier-run-manifest' as const,
    runId: 'source-run',
    state: 'completed' as const,
    epoch: '7',
    epochSource: 'utc-day' as const,
    epochStartedAt: '2026-08-10T00:00:00.000Z',
    epochEndsAt: '2026-08-11T00:00:00.000Z',
    startedAt: '2026-08-10T01:00:00.000Z',
    completedAt: '2026-08-10T02:00:00.000Z',
    summaryPath: '/tmp/summary.json',
    modelOrder: ['model-b'],
    models: [],
    failureCount: 0,
  }
  assert.deepEqual(resolveRunModels(verifier, undefined, false, manifest), ['model-b'])
  assert.deepEqual(resolveRunModels(verifier, 'MODEL-B', false, manifest), ['model-b'])
  assert.throws(
    () => resolveRunModels(verifier, 'model-a', false, manifest),
    /does not include model model-a/,
  )
})

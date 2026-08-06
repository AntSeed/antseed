import assert from 'node:assert/strict'
import test from 'node:test'
import { Command } from 'commander'
import { registerVerifierCommands } from './index.js'

function command(): Command {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  registerVerifierCommands(program)
  return program
}

test('verifier exposes proxy run, reference, and claim workflows', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')
  assert.ok(verifier)
  assert.deepEqual(verifier.commands.map((entry) => entry.name()).sort(), ['claim', 'reference', 'run', 'status'])
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
  assert.deepEqual(run.options.map((option) => option.long), ['--all', '--allow-probe-reuse'])
  assert.deepEqual(run.registeredArguments.map((argument) => argument.name()), ['model'])
})

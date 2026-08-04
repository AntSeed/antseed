import assert from 'node:assert/strict'
import test from 'node:test'
import { Command } from 'commander'
import { registerVerifierCommands } from './index.js'

function command(): Command {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  registerVerifierCommands(program)
  return program
}

test('verifier exposes only run and claim workflows', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')
  assert.ok(verifier)
  assert.deepEqual(verifier.commands.map((entry) => entry.name()).sort(), ['claim', 'run'])
})

test('verifier run takes one model and one benchmark switch', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const run = verifier.commands.find((entry) => entry.name() === 'run')!
  assert.deepEqual(run.options.map((option) => option.long), ['--benchmark'])
  assert.deepEqual(run.registeredArguments.map((argument) => argument.name()), ['model'])
})

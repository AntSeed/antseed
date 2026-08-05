import assert from 'node:assert/strict'
import test from 'node:test'
import { Command } from 'commander'
import { registerVerifierCommands } from './index.js'

function command(): Command {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  registerVerifierCommands(program)
  return program
}

test('verifier exposes run, reference, and claim workflows', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')
  assert.ok(verifier)
  assert.deepEqual(verifier.commands.map((entry) => entry.name()).sort(), ['claim', 'reference', 'run'])
})

test('verifier reference exposes only the explicit build workflow', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const reference = verifier.commands.find((entry) => entry.name() === 'reference')!
  assert.deepEqual(reference.commands.map((entry) => entry.name()), ['build'])
  assert.deepEqual(reference.commands[0]!.registeredArguments.map((argument) => argument.name()), ['model'])
})

test('verifier run takes one model and one no-attest switch', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const run = verifier.commands.find((entry) => entry.name() === 'run')!
  assert.deepEqual(run.options.map((option) => option.long), ['--no-attest'])
  assert.deepEqual(run.registeredArguments.map((argument) => argument.name()), ['model'])
})

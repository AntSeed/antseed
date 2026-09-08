import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsVerifyCommand } from './verify.js';

test('verify inspects a seller by default and exposes submit and proof', () => {
  const ants = new Command('ants');
  registerAntsVerifyCommand(ants);
  const verify = ants.commands.find((command) => command.name() === 'verify');
  assert.ok(verify);
  assert.equal(verify.registeredArguments[0]?.name(), 'seller');
  assert.equal(verify.registeredArguments[0]?.required, false);
  assert.deepEqual(verify.commands.map((command) => command.name()).sort(), ['proof', 'submit']);
});

test('verify submit asks for confirmation unless --yes is given', () => {
  const ants = new Command('ants');
  registerAntsVerifyCommand(ants);
  const submit = ants.commands.find((command) => command.name() === 'verify')!.commands.find((command) => command.name() === 'submit')!;
  assert.deepEqual(submit.registeredArguments.map((argument) => argument.name()), ['artifact']);
  const yes = submit.options.find((option) => option.long === '--yes');
  assert.ok(yes);
  assert.equal(yes.defaultValue, false);
});

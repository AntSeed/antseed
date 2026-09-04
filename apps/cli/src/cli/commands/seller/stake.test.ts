import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerSellerCommands } from './index.js';

function sellerCommand(): Command {
  const program = new Command();
  registerSellerCommands(program);
  return program.commands.find((command) => command.name() === 'seller')!;
}

function findCommand(parent: Command, name: string): Command | undefined {
  return parent.commands.find((command) => command.name() === name);
}

test('seller stake is stack-aware and accepts an ANTS lock duration', () => {
  const stake = findCommand(sellerCommand(), 'stake');
  assert.ok(stake);
  assert.ok(stake!.options.some((option) => option.long === '--epochs'));
  assert.ok(stake!.options.some((option) => option.long === '--agent-id'));
});

test('legacy USDC staking lives under seller legacy', () => {
  const legacy = findCommand(sellerCommand(), 'legacy');
  assert.ok(legacy);
  assert.ok(findCommand(legacy!, 'stake'));
  assert.ok(findCommand(legacy!, 'unstake'));
});

test('seller unstake remains available as a legacy alias', () => {
  assert.ok(findCommand(sellerCommand(), 'unstake'));
});

test('pool bootstrap replaces pool init but keeps the old name as an alias', () => {
  const pool = findCommand(sellerCommand(), 'pool')!;
  const bootstrap = findCommand(pool, 'bootstrap');
  assert.ok(bootstrap);
  assert.ok(bootstrap!.aliases().includes('init'));
  assert.ok(findCommand(pool, 'stake'));
});

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
  const agentId = stake!.options.find((option) => option.long === '--agent-id');
  assert.ok(agentId);
  assert.equal(agentId!.hidden, true);
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

test('primary help shows aggregate rewards while retaining hidden compatibility commands', () => {
  const seller = sellerCommand();
  const help = seller.helpInformation();
  assert.match(help, /rewards/);
  assert.doesNotMatch(help, /\n\s+emissions\s/);
  assert.doesNotMatch(help, /\n\s+unstake\s/);
  const pool = findCommand(seller, 'pool')!;
  assert.ok(findCommand(pool, 'rewards'));
  assert.doesNotMatch(pool.helpInformation(), /\n\s+rewards/);
});

test('pool claim-starter keeps bootstrap and init as aliases', () => {
  const pool = findCommand(sellerCommand(), 'pool')!;
  const claimStarter = findCommand(pool, 'claim-starter');
  assert.ok(claimStarter);
  assert.deepEqual(claimStarter!.aliases(), ['bootstrap', 'init']);
  assert.equal(findCommand(pool, 'stake'), undefined);
});

test('seller rewards provides the minimal aggregate reward surface', () => {
  const rewards = findCommand(sellerCommand(), 'rewards');
  assert.ok(rewards);
  assert.ok(findCommand(rewards!, 'claim'));
});

test('pool withdrawal requires explicit slashing consent instead of force', () => {
  const pool = findCommand(sellerCommand(), 'pool')!;
  const withdraw = findCommand(pool, 'withdraw')!;
  assert.ok(withdraw.options.some((option) => option.long === '--accept-slashing'));
  assert.ok(withdraw.options.some((option) => option.long === '--yes'));
  assert.ok(!withdraw.options.some((option) => option.long === '--force'));
});

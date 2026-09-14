import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { compoundSummary, parseUsageSide, registerAntsRewardsCommand, selectedBuckets } from './rewards.js';
import { lockedClaimDecision, validateLockedClaimOptions } from './locked-rewards.js';

function rewardsCommand(): Command {
  const ants = new Command('ants');
  registerAntsRewardsCommand(ants);
  return ants.commands.find((command) => command.name() === 'rewards')!;
}

test('rewards exposes claim, restake, compound, and stake-usage', () => {
  const rewards = rewardsCommand();
  assert.ok(rewards);
  assert.deepEqual(rewards.commands.map((command) => command.name()).sort(), ['claim', 'compound', 'restake', 'stake-usage']);
  assert.ok(rewards.options.some((option) => option.long === '--json'));
});

test('claim has one flag per reward bucket', () => {
  const claim = rewardsCommand().commands.find((command) => command.name() === 'claim')!;
  const flags = claim.options.map((option) => option.long);
  for (const bucket of ['--staker', '--seller', '--buyer', '--legacy', '--locked', '--recipient']) assert.ok(flags.includes(bucket), bucket);
});

test('locked diagnostics and claim safety flags are registered', () => {
  const rewards = rewardsCommand();
  for (const flag of ['--locked', '--address', '--json']) assert.ok(rewards.options.some((option) => option.long === flag));
  const claim = rewards.commands.find((command) => command.name() === 'claim')!;
  for (const flag of ['--dry-run', '--yes']) assert.ok(claim.options.some((option) => option.long === flag));
});

test('locked-only claims preview, confirm, or send explicitly', () => {
  assert.equal(validateLockedClaimOptions({ locked: true }), true);
  assert.equal(validateLockedClaimOptions({ locked: true, legacy: true }), false);
  assert.equal(lockedClaimDecision({}), 'confirm');
  assert.equal(lockedClaimDecision({ dryRun: true }), 'preview');
  assert.equal(lockedClaimDecision({ yes: true }), 'send');
});

test('safety flags cannot silently broadcast a multi-bucket claim', () => {
  assert.throws(() => validateLockedClaimOptions({ dryRun: true }), /require --locked/);
  assert.throws(() => validateLockedClaimOptions({ yes: true }), /require --locked/);
  for (const bucket of ['legacy', 'seller', 'buyer', 'staker'] as const) {
    assert.throws(() => validateLockedClaimOptions({ locked: true, [bucket]: true, dryRun: true }), /without other/);
    assert.throws(() => validateLockedClaimOptions({ locked: true, [bucket]: true, yes: true }), /without other/);
  }
  assert.throws(() => validateLockedClaimOptions({ locked: true, dryRun: true, yes: true }), /not both/);
});

test('restake and compound require a lock length; compound can retarget with --to', () => {
  const rewards = rewardsCommand();
  const restake = rewards.commands.find((command) => command.name() === 'restake')!;
  const compound = rewards.commands.find((command) => command.name() === 'compound')!;
  assert.ok(restake.options.find((option) => option.long === '--epochs')?.mandatory);
  assert.ok(compound.options.find((option) => option.long === '--epochs')?.mandatory);
  assert.ok(compound.options.some((option) => option.long === '--to'));
  assert.equal(restake.registeredArguments[0]?.name(), 'ids');
  assert.equal(restake.registeredArguments[0]?.required, false);
});

test('selectedBuckets keeps only the flags that were set, in bucket order', () => {
  assert.deepEqual(selectedBuckets({}), []);
  assert.deepEqual(selectedBuckets({ locked: true, staker: true, buyer: false }), ['staker', 'locked']);
});

test('parseUsageSide only accepts seller or buyer', () => {
  assert.equal(parseUsageSide('seller'), 'seller');
  assert.equal(parseUsageSide('buyer'), 'buyer');
  assert.throws(() => parseUsageSide('operator'), /--side must be seller or buyer/);
});

test('compoundSummary lists only the parts that happened', () => {
  const base = { transactions: ['0x1', '0x2'], restakedPositionIds: [3, 4], sellerEpochs: [22], buyerEpochs: [], newPositionIds: [9, 10], movedPositionIds: [9, 10], targetAgentId: 7 };
  assert.equal(compoundSummary(base), 'Compounded staker rewards from 2 position(s), seller usage for 1 epoch(s), moved 2 position(s) to agent 7 across 2 transaction(s)');
  assert.equal(compoundSummary({ ...base, sellerEpochs: [], movedPositionIds: [], targetAgentId: null }), 'Compounded staker rewards from 2 position(s) across 2 transaction(s)');
});

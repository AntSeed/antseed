import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { AntsContext } from '@antseed/ants';
import { registerAntsRewardsCommand } from './rewards.js';

const seller = '0x0000000000000000000000000000000000000001';
const recipient = '0x0000000000000000000000000000000000000002';
const policy = '0x0000000000000000000000000000000000000003';
const legacy = '0x0000000000000000000000000000000000000004';

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-m002-cli-'));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ payments: { crypto: { chainId: 'base-local', rpcUrl: 'http://127.0.0.1:1', antsTokenAddress: policy } } }));
  const previousExitCode = process.exitCode;
  const previousIdentity = process.env['ANTSEED_IDENTITY_HEX'];
  process.env['ANTSEED_IDENTITY_HEX'] = '11'.repeat(32);
  context.after(async () => {
    process.exitCode = previousExitCode;
    if (previousIdentity === undefined) delete process.env['ANTSEED_IDENTITY_HEX'];
    else process.env['ANTSEED_IDENTITY_HEX'] = previousIdentity;
    await rm(directory, { recursive: true, force: true });
  });
  const output: string[] = [];
  context.mock.method(console, 'log', (...messages: unknown[]) => output.push(messages.join(' ')));
  let activeContext: AntsContext;
  const provider = { send: async () => '0x7a69', getNetwork: async () => ({ chainId: 31337n }) };
  const pool = {
    provider,
    details: context.mock.fn(async () => ({
      seller: activeContext.address, blockNumber: 55, pool: recipient, token: policy, locked: 1000n, poolBalance: 1000n, transferAllowed: true,
      policy: { address: policy, cumulativeLocked: 1000n, accountingCumulative: 1000n, withdrawn: 0n, entitlement: 100n,
        releaseBps: 1000n, lastEpoch: 21n, legacyEmissions: legacy, washTradingRegistry: policy, restricted: false, claimable: 100n },
    })),
    previewClaim: context.mock.fn(async () => ({ gasEstimate: 100n, gasLimit: 130n, maxFeePerGas: 2n, maxExecutionFee: 260n, ethBalance: 1000n })),
    claimable: async () => ({ locked: 1000n, claimable: 100n, policy }),
    claim: context.mock.fn(async () => 'confirmed-claim'),
  };
  context.mock.method(AntsContext.prototype, 'selectRpc', async () => {});
  context.mock.method(AntsContext.prototype, 'provider', () => provider as never);
  context.mock.method(AntsContext.prototype, 'stack', async () => ({
    phase: 'active', effectiveEpoch: 22, legacyEmissions: legacy, lockedRewardsPool: recipient,
  }) as never);
  context.mock.method(AntsContext.prototype, 'claimableEpochs', async () => ({ legacy: [], recognized: [] }));
  context.mock.method(AntsContext.prototype, 'lockedPoolAt', function (this: AntsContext) { activeContext = this; return pool as never; });
  context.mock.method(AntsContext.prototype, 'antsToken', () => ({ receivedInTransaction: async () => 100n }) as never);
  const command = new Command('antseed').exitOverride().option('--config <path>', '', configPath).option('--data-dir <path>', '', directory);
  const ants = command.command('ants');
  registerAntsRewardsCommand(ants);
  return {
    directory, output, pool, getContext: () => activeContext,
    run: (args: string[]) => command.parseAsync(['ants', 'rewards', ...args], { from: 'user' }),
  };
}

test('address-only inspection does not load a signer or create identity files', async (context) => {
  const state = await fixture(context);
  const filesBefore = await readdir(state.directory);
  await state.run(['--locked', '--address', seller, '--json']);
  assert.equal(state.getContext().signer, undefined);
  assert.deepEqual(await readdir(state.directory), filesBefore);
  assert.equal(JSON.parse(state.output.join('\n')).policy.claimable, '100');
  assert.equal(state.pool.claim.mock.callCount(), 0);
});

test('a locked claim dry run simulates the selected recipient but never broadcasts', async (context) => {
  const state = await fixture(context);
  await state.run(['claim', '--locked', '--recipient', recipient, '--dry-run']);
  assert.equal(state.pool.previewClaim.mock.callCount(), 1);
  assert.equal(state.pool.claim.mock.callCount(), 0);
  assert.match(state.output.join('\n'), new RegExp(`Recipient: ${recipient}`));
  assert.match(state.output.join('\n'), /Estimated maximum execution fee/);
});

test('a locked claim with --yes rechecks then broadcasts exactly once', async (context) => {
  const state = await fixture(context);
  await state.run(['claim', '--locked', '--yes']);
  assert.equal(state.pool.previewClaim.mock.callCount(), 2);
  assert.equal(state.pool.claim.mock.callCount(), 1);
});

test('a noninteractive locked claim without --yes fails closed', async (context) => {
  const state = await fixture(context);
  await state.run(['claim', '--locked']);
  assert.equal(process.exitCode, 1);
  assert.equal(state.pool.claim.mock.callCount(), 0);
});

test('a mixed-bucket dry run is rejected without sending any transaction', async (context) => {
  const state = await fixture(context);
  await state.run(['claim', '--legacy', '--locked', '--dry-run']);
  assert.equal(process.exitCode, 1);
  assert.equal(state.pool.previewClaim.mock.callCount(), 0);
  assert.equal(state.pool.claim.mock.callCount(), 0);
});

test('an inherited --locked flag cannot accidentally select all claim buckets', async (context) => {
  const state = await fixture(context);
  await state.run(['--locked', 'claim', '--dry-run']);
  assert.equal(state.pool.previewClaim.mock.callCount(), 1);
  assert.equal(state.pool.claim.mock.callCount(), 0);
});

test('a read-only address flag cannot be used to claim for another seller', async (context) => {
  const state = await fixture(context);
  await state.run(['claim', '--locked', '--address', seller, '--yes']);
  assert.equal(process.exitCode, 1);
  assert.equal(state.pool.claim.mock.callCount(), 0);
});

test('the new locked read flag cannot silently select unrelated restakable rewards', async (context) => {
  const state = await fixture(context);
  await assert.rejects(state.run(['compound', '--locked', '--epochs', '4']), /inspection and claim only/);
  assert.equal(state.pool.claim.mock.callCount(), 0);
});

test('JSON read failures are explicit errors, not zero balances', async (context) => {
  const state = await fixture(context);
  state.pool.details.mock.mockImplementation(async () => { throw new Error('RPC unavailable'); });
  await state.run(['--locked', '--address', seller, '--json']);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(JSON.parse(state.output.join('\n')), { status: 'unavailable', error: 'RPC unavailable' });
});
